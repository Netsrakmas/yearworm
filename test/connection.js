// Connection UX: the reconnecting banner (offline events + repeated failed
// lookups, clearing on recovery) and the audio buffering indicator.
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
let fail = false;
const server = http.createServer((req,res)=>{
  let p = decodeURIComponent(req.url.split('?')[0]); if(p==='/')p='/index.html';
  if(p==='/clip.wav'){res.writeHead(200,{'Content-Type':'audio/wav','Access-Control-Allow-Origin':'*'});return res.end(WAV);}
  const f = path.join(ROOT,p);
  if(!f.startsWith(ROOT)||!fs.existsSync(f)){res.writeHead(404);return res.end();}
  res.writeHead(200,{'Content-Type':p.endsWith('.html')?'text/html':'application/octet-stream'});
  fs.createReadStream(f).pipe(res);
});

const bannerShown = pg => pg.evaluate(()=>{ const el=document.getElementById('netbanner'); return !!el && el.classList.contains('show'); });

(async()=>{
  await new Promise(r=>server.listen(8106,r));
  const base='http://localhost:8106/';
  const browser = await chromium.launch({executablePath:CHROME,args:['--autoplay-policy=no-user-gesture-required']});
  const ctx = await browser.newContext({viewport:{width:540,height:1100},hasTouch:true,serviceWorkers:'block'});
  const pg = await ctx.newPage();
  pg.on('pageerror',e=>console.log('PAGEERROR:',e.message));
  let tid=1;
  // previews.json now ships in the repo and every test server serves ROOT.
  // These suites exercise the LOOKUP path, so hide it — otherwise songs
  // resolve from the static file and point at a CDN this test doesn't stub.
  await pg.route(/previews\.json/, r=>r.fulfill({status:404, body:''}));
  await pg.route(/itunes\.apple\.com/, route=>{
    const u=new URL(route.request().url());const cb=u.searchParams.get('callback');const term=u.searchParams.get('term')||'x';
    if(fail){ route.fulfill({contentType:'text/javascript',body:`${cb}({"resultCount":0,"results":[]})`}); return; }
    route.fulfill({contentType:'text/javascript',body:`${cb}(${JSON.stringify({resultCount:1,results:[{trackId:++tid,trackName:term,artistName:term,collectionName:'T',releaseDate:'1990-01-01',previewUrl:'http://localhost:8106/clip.wav'}]})})`});
  });
  await pg.goto(base,{waitUntil:'load'});
  await pg.waitForTimeout(700);

  // A) offline/online browser events drive the banner
  if(await bannerShown(pg)) throw new Error('banner shown at rest');
  await pg.evaluate(()=>window.dispatchEvent(new Event('offline')));
  await pg.waitForTimeout(100);
  if(!await bannerShown(pg)) throw new Error('offline event did not show the banner');
  await pg.evaluate(()=>window.dispatchEvent(new Event('online')));
  await pg.waitForTimeout(100);
  if(await bannerShown(pg)) throw new Error('online event did not clear the banner');
  console.log('offline/online events toggle the banner OK');

  // B) repeated failed lookups raise it; a good lookup clears it
  await pg.evaluate(()=>{ _netFails=0; noteLookup(false); noteLookup(false); });
  if(await bannerShown(pg)) throw new Error('banner raised too early (2 fails)');
  await pg.evaluate(()=>noteLookup(false));   // third strike
  await pg.waitForTimeout(50);
  if(!await bannerShown(pg)) throw new Error('3 failed lookups did not raise the banner');
  await pg.evaluate(()=>noteLookup(true));    // recovery
  await pg.waitForTimeout(50);
  if(await bannerShown(pg)) throw new Error('a good lookup did not clear the banner');
  console.log('failed-lookup streak raises + recovery clears the banner OK');

  // C) integration: a start where every lookup fails shows the banner
  fail = true;
  await pg.click('.modecard:has-text("Pass & Play")');
  await pg.click('text=▶ Start game');
  // every song is now retried 3x with backoff before its verdict reaches the
  // watchdog, so on a fully dead API the banner takes a few seconds — wait for
  // it rather than sampling at a fixed moment
  await pg.waitForFunction(()=>{const el=document.getElementById('netbanner');return !!el&&el.classList.contains('show');},null,{timeout:20000})
    .catch(()=>{ throw new Error('all-failing start did not surface the banner'); });
  console.log('all-failing deck load surfaces the banner OK');
  fail = false;
  await pg.evaluate(()=>setNetTrouble(false));

  // D) audio buffering indicator: waiting -> shows, playing -> clears
  await pg.reload(); await pg.waitForTimeout(600);
  await pg.click('.modecard:has-text("Pass & Play")');
  await pg.click('text=▶ Start game');
  await pg.waitForSelector('.slot.active',{timeout:20000});
  // dispatch + read in the same tick: the stub clip keeps auto-firing 'playing',
  // which would race a separate check (harmless in the real app — waiting and
  // playing never coincide there)
  let buf = await pg.evaluate(()=>{ const a=document.getElementById('aud'); a.dispatchEvent(new Event('waiting'));
    const n=document.getElementById('bufNote'); return !!n && n.classList.contains('show'); });
  if(!buf) throw new Error('waiting event did not show the buffering note');
  buf = await pg.evaluate(()=>{ const a=document.getElementById('aud'); a.dispatchEvent(new Event('playing'));
    const n=document.getElementById('bufNote'); return !!n && n.classList.contains('show'); });
  if(buf) throw new Error('playing event did not clear the buffering note');
  console.log('audio buffering note shows on stall, clears on playing OK');

  console.log('CONNECTION TEST PASS ✓');
  await browser.close(); server.close();
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1);});
