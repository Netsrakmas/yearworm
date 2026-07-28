// Robustness: on a flaky connection the FIRST lookup for each song times out
// (returns empty) and only the RETRY succeeds. Without the retry the deck
// starves and a 2-player race dies after a few placements ("done after 3
// songs"); with it, the game plays through. Also proves the bigger start
// buffer + retry keep the deck ahead of two players racing to 10.
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
  await new Promise(r=>server.listen(8105,r));
  const base='http://localhost:8105/';
  const browser = await chromium.launch({executablePath:CHROME,args:['--autoplay-policy=no-user-gesture-required']});
  const ctx = await browser.newContext({viewport:{width:540,height:1200},hasTouch:true,serviceWorkers:'block'});
  const pg = await ctx.newPage();
  pg.on('pageerror',e=>console.log('PAGEERROR:',e.message));
  let tid=1, calls=0; const seen = new Map();   // term -> attempts so far
  // previews.json now ships in the repo and every test server serves ROOT.
  // These suites exercise the LOOKUP path, so hide it — otherwise songs
  // resolve from the static file and point at a CDN this test doesn't stub.
  await pg.route(/previews\.json/, r=>r.fulfill({status:404, body:''}));
  await pg.route(/itunes\.apple\.com/, route=>{
    calls++;
    const u=new URL(route.request().url());const cb=u.searchParams.get('callback');const term=u.searchParams.get('term')||'x';
    const n = (seen.get(term)||0) + 1; seen.set(term, n);
    if(n === 1){   // first attempt for this term always fails (flaky net) → empty
      route.fulfill({contentType:'text/javascript',body:`${cb}({"resultCount":0,"results":[]})`}); return;
    }
    route.fulfill({contentType:'text/javascript',body:`${cb}(${JSON.stringify({resultCount:1,results:[{trackId:++tid,trackName:term,artistName:term,collectionName:'T',releaseDate:'1990-01-01',previewUrl:'http://localhost:8105/clip.wav'}]})})`});
  });
  await pg.goto(base,{waitUntil:'load'});
  await pg.waitForTimeout(700);

  // default 2 players, classic race — start
  await pg.click('.modecard:has-text("Pass & Play")');
  await pg.click('text=▶ Start game');
  await pg.waitForSelector('.slot.active',{timeout:30000});

  // place 12 cards across the two players; the old build died around 3
  let placed = 0;
  for(let i=1;i<=12;i++){
    // deck may be refilling on the "flaky" net — wait patiently for a live slot
    await pg.waitForSelector('.slot.active',{timeout:30000});
    await pg.click('.slot.active');
    await pg.waitForSelector('#overlay.show',{timeout:8000});
    placed++;
    const btn = await pg.$eval('#sheet .btn.primary', e=>e.textContent);
    if(/See results/i.test(btn)) break;   // legitimately finished (someone won)
    await pg.click('#sheet .btn.primary');
    await pg.waitForFunction(()=>!document.getElementById('overlay').classList.contains('show'), null, {timeout:8000}).catch(()=>{});
    await pg.waitForTimeout(200);
  }
  const st = await pg.evaluate(()=>({deck:S.deck.length, used:S.used.size, over: !!document.querySelector('#sheet') && /ran out|no more|game over/i.test(document.getElementById('sheet').innerText)}));
  if(placed < 12) throw new Error('game stalled after only '+placed+' placements (deck starved despite retry) · deck '+st.deck);
  if(st.over) throw new Error('hit a deck-empty game-over screen despite the retry');
  console.log('bad-net: placed '+placed+' cards with every first lookup failing · deck now '+st.deck+' · itunes calls '+calls);
  console.log('BAD-NET TEST PASS ✓ (retry recovers a flaky connection; race survives past 3 songs)');
  await browser.close(); server.close();
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1);});
