// Survival smoke: 3 lives, wrong placements cost one, 0 lives = RUN OVER with
// the score, and the personal best lands in tl_best.
const { chromium } = require('playwright-core');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = '/home/user/Timeline';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
function makeWav(){
  const rate=8000, secs=2, n=rate*secs, buf=Buffer.alloc(44+n*2);
  buf.write('RIFF',0); buf.writeUInt32LE(36+n*2,4); buf.write('WAVEfmt ',8);
  buf.writeUInt32LE(16,16); buf.writeUInt16LE(1,20); buf.writeUInt16LE(1,22);
  buf.writeUInt32LE(rate,24); buf.writeUInt32LE(rate*2,28); buf.writeUInt16LE(2,32);
  buf.writeUInt16LE(16,34); buf.write('data',36); buf.writeUInt32LE(n*2,40);
  for(let i=0;i<n;i++) buf.writeInt16LE(Math.round(Math.sin(i/10)*8000), 44+i*2);
  return buf;
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
  await new Promise(r=>server.listen(8118,r));
  const base='http://localhost:8118/';
  const browser = await chromium.launch({executablePath:CHROME,args:['--autoplay-policy=no-user-gesture-required']});
  const ctx = await browser.newContext({viewport:{width:540,height:1200},hasTouch:true,serviceWorkers:'block'});
  const pg = await ctx.newPage();
  pg.on('pageerror',e=>console.log('PAGEERROR:',e.message));
  let tid=1;
  // previews.json now ships in the repo and every test server serves ROOT.
  // These suites exercise the LOOKUP path, so hide it — otherwise songs
  // resolve from the static file and point at a CDN this test doesn't stub.
  await pg.route(/previews\.json/, r=>r.fulfill({status:404, body:''}));
  await pg.route(/itunes\.apple\.com/, route=>{
    const u=new URL(route.request().url());const cb=u.searchParams.get('callback');const term=u.searchParams.get('term')||'x';
    route.fulfill({contentType:'text/javascript',body:`${cb}(${JSON.stringify({resultCount:1,results:[{trackId:++tid,trackName:term,artistName:term,collectionName:'T',releaseDate:'1999-01-01',previewUrl:'http://localhost:8118/clip.wav'}]})})`});
  });
  await pg.goto(base,{waitUntil:'load'});
  await pg.waitForTimeout(700);

  await pg.click('.modecard:has-text("Survival")');
  await pg.click('text=🎯 Start survival');
  await pg.waitForSelector('.slot.active',{timeout:30000});
  const lives0 = await pg.evaluate(()=>S.lives);
  if(lives0!==3) throw new Error('survival should start with 3 lives, got '+lives0);
  console.log('survival starts: 3 lives OK');

  // always slam the FIRST slot — statistically wrong often; play until dead
  let deaths=0, placements=0, sawLifeLoss=false, prevLives=3;
  for(let i=0;i<60;i++){
    const over = await pg.evaluate(()=>({
      show: document.getElementById('overlay').classList.contains('show'),
      txt: document.getElementById('sheet').innerText, lives: S.lives
    }));
    if(over.lives < prevLives){ sawLifeLoss = true; }
    prevLives = over.lives;
    if(over.show && /RUN OVER/.test(over.txt)){ deaths=1; break; }
    if(over.show){ await pg.click('#sheet .btn.primary'); await pg.waitForTimeout(250); continue; }
    const slot = await pg.$('.slot.active');
    if(!slot){ await pg.waitForTimeout(400); continue; }
    await slot.click(); placements++;
    await pg.waitForSelector('#overlay.show',{timeout:8000}).catch(()=>{});
  }
  if(!sawLifeLoss) throw new Error('never lost a life in '+placements+' placements — lives not wired?');
  if(!deaths) throw new Error('survival never ended after '+placements+' placements');
  const fin = await pg.evaluate(()=>({ lives:S.lives, score:S.score,
    sheet: document.getElementById('sheet').innerText.replace(/\s+/g,' '),
    best: JSON.parse(localStorage.getItem('tl_best')||'{}') }));
  if(fin.lives!==0) throw new Error('run over but lives='+fin.lives);
  if(!/You placed/.test(fin.sheet)) throw new Error('game-over sheet missing score: '+fin.sheet.slice(0,160));
  if(!( (fin.best.cards||0) >= fin.score )) throw new Error('personal best not recorded: '+JSON.stringify(fin.best)+' score '+fin.score);
  console.log('survival: lives drain on misses, RUN OVER at 0, best recorded OK ·', fin.score, 'placed');

  console.log('SURVIVAL TEST PASS ✓');
  await browser.close(); server.close();
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1);});
