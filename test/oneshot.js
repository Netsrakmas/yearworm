// E2E: one-shot integrity — quitting a daily or incoming-challenge run mid-way
// burns the attempt with the partial score (no replay with revealed answers),
// and a challenge link whose songs can't resolve aborts WITHOUT locking.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = '/home/user/Timeline';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
function makeWav(){
  const sr=8000,n=3200;const d=Buffer.alloc(n*2);
  for(let i=0;i<n;i++)d.writeInt16LE((Math.floor(i/40)%2)?4000:-4000,i*2);
  const h=Buffer.alloc(44);h.write('RIFF',0);h.writeUInt32LE(36+d.length,4);h.write('WAVEfmt ',8);
  h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(sr,24);
  h.writeUInt32LE(sr*2,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(d.length,40);
  return Buffer.concat([h,d]);
}
const WAV = makeWav();
const server = http.createServer((req,res)=>{
  let p = decodeURIComponent(req.url.split('?')[0]); if(p==='/')p='/index.html';
  if(p==='/clip.wav'){res.writeHead(200,{'Content-Type':'audio/wav','Access-Control-Allow-Origin':'*'});return res.end(WAV);}
  const f = path.join(ROOT,p);
  if(!f.startsWith(ROOT)||!fs.existsSync(f)){res.writeHead(404);return res.end();}
  res.writeHead(200,{'Content-Type':p.endsWith('.html')?'text/html':'application/octet-stream'});
  fs.createReadStream(f).pipe(res);
});

(async()=>{
  await new Promise(r=>server.listen(8087,r));
  const base='http://localhost:8087/';
  const browser = await chromium.launch({executablePath:CHROME,args:['--autoplay-policy=no-user-gesture-required']});
  const ctx = await browser.newContext({viewport:{width:540,height:1200},hasTouch:true,serviceWorkers:'block'});
  const pg = await ctx.newPage();
  pg.on('pageerror',e=>console.log('PAGEERROR:',e.message));
  pg.on('dialog',d=>d.accept());   // confirmQuit()
  let tid=1, failLookups=false;
  await pg.route(/itunes\.apple\.com/, route=>{
    const u=new URL(route.request().url());const cb=u.searchParams.get('callback');const term=u.searchParams.get('term')||'x';
    const body = failLookups
      ? `${cb}(${JSON.stringify({resultCount:0,results:[]})})`
      : `${cb}(${JSON.stringify({resultCount:1,results:[{trackId:++tid,trackName:term,artistName:term,collectionName:'T',releaseDate:'1999-01-01',previewUrl:'http://localhost:8087/clip.wav'}]})})`;
    route.fulfill({contentType:'text/javascript',body});
  });
  await pg.route(/lb\.test|workers\.dev/, r=>r.abort());   // offline social/boards — must stay silent

  // --- 1) daily: place 2, quit → partial recorded, replay blocked ---
  await pg.goto(base,{waitUntil:'load'});
  await pg.waitForTimeout(600);
  await pg.click('.modecard:has-text("Daily Challenge")');
  for(let i=1;i<=2;i++){
    await pg.waitForSelector('.slot.active',{timeout:20000});
    await pg.click('.slot.active');
    await pg.waitForSelector('#overlay.show',{timeout:5000});
    await pg.click('#sheet .btn.primary');
    await pg.waitForFunction(()=>!document.getElementById('overlay').classList.contains('show'), null, {timeout:5000}).catch(()=>{});
    await pg.waitForTimeout(250);
  }
  await pg.click('button:has-text("Quit")');
  await pg.waitForTimeout(500);
  const d1 = await pg.evaluate(()=>JSON.parse(localStorage.getItem('tl_daily')||'{}'));
  if(d1.p !== 1) throw new Error('partial daily not flagged: '+JSON.stringify(d1));
  if(!(d1.results||[]).length || d1.num == null) throw new Error('partial daily incomplete: '+JSON.stringify(d1));
  const blocked = await pg.evaluate(()=>dailyPlayedToday());
  if(!blocked) throw new Error('daily replay not blocked after quit');
  const home = await pg.$eval('#app', e=>e.innerText);
  if(!/Done ·/.test(home)) throw new Error('daily card not in done-state after quit: '+home.slice(0,200));
  console.log('daily quit → partial recorded (p:1, score '+d1.score+'), replay blocked OK');

  // reload: still blocked
  await pg.reload(); await pg.waitForTimeout(700);
  if(!(await pg.evaluate(()=>dailyPlayedToday()))) throw new Error('daily block did not survive reload');
  console.log('daily block survives reload OK');

  // --- 2) challenge link: place 1, quit → set locked with partial ---
  const idx = await pg.evaluate(()=>{ const n=stablePool().length; return [5, 11, 23, 31, 47, 59].map(i=>i%n); });
  await pg.goto(base+'#c='+idx.join('.')+'&s=4&t=60',{waitUntil:'load'});
  await pg.reload();   // hash-only navigation doesn't re-run boot()
  await pg.waitForTimeout(700);
  await pg.click('#sheet button:has-text("Accept challenge")');
  await pg.waitForSelector('.slot.active',{timeout:25000});
  await pg.click('.slot.active');
  await pg.waitForSelector('#overlay.show',{timeout:5000});
  await pg.click('#sheet .btn.primary');
  await pg.waitForTimeout(300);
  await pg.click('button:has-text("Quit")');
  await pg.waitForTimeout(500);
  const chals = await pg.evaluate(()=>JSON.parse(localStorage.getItem('tl_chals')||'{}'));
  const key = await pg.evaluate(k=>chalKey(k), idx);
  if(!chals[key] || chals[key].p !== 1) throw new Error('partial challenge not locked: '+JSON.stringify(chals));
  console.log('challenge quit → set locked with partial score OK');

  // the incoming card now shows the RESULT state, not a fresh ▶ Play
  const app2 = await pg.$eval('#app', e=>e.innerText);
  if(!/challenge result|already played/i.test(app2)) throw new Error('locked set still offers a fresh play: '+app2.slice(0,300));
  console.log('locked set shows result card, no fresh play OK');

  // --- 3) unresolvable link aborts WITHOUT locking ---
  failLookups = true;
  const idx2 = await pg.evaluate(()=>{ const n=stablePool().length; return [7, 13, 29, 37, 53, 61].map(i=>i%n); });
  await pg.goto(base+'#c='+idx2.join('.')+'&s=3',{waitUntil:'load'});
  await pg.reload();
  await pg.waitForTimeout(700);
  await pg.click('#sheet button:has-text("Accept challenge")');
  // strict resolution fails → error + back to setup. Each song burns 3 retries
  // with backoff first, so wait for the bar instead of guessing a duration.
  await pg.waitForSelector('#errbar',{state:'visible',timeout:30000});
  const chals2 = await pg.evaluate(()=>JSON.parse(localStorage.getItem('tl_chals')||'{}'));
  const key2 = await pg.evaluate(k=>chalKey(k), idx2);
  if(chals2[key2]) throw new Error('failed-resolution link must not lock the set: '+JSON.stringify(chals2[key2]));
  const err = await pg.evaluate(()=>document.getElementById('errbar').style.display);
  if(err !== 'block') throw new Error('no error surfaced for unresolvable link');
  console.log('unresolvable link → error shown, one-shot NOT burned OK');

  console.log('ONE-SHOT INTEGRITY TEST PASS ✓');
  await browser.close(); server.close();
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1);});
