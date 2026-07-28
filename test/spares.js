// E2E: fresh challenges must survive failed preview lookups — every 5th
// iTunes search returns nothing, yet the run still fills all 5 songs
// (spare candidates), and the share link only contains played tracks.
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
  await new Promise(r=>server.listen(8095,r));
  const base='http://localhost:8095/';
  const browser = await chromium.launch({executablePath:CHROME,args:['--autoplay-policy=no-user-gesture-required']});
  const ctx = await browser.newContext({viewport:{width:540,height:1200},hasTouch:true,serviceWorkers:'block'});
  const pg = await ctx.newPage();
  pg.on('pageerror',e=>console.log('PAGEERROR:',e.message));
  await pg.addInitScript(()=>{ navigator.share = t => { window.__shared = (t&&t.text)||String(t); return Promise.resolve(); }; });
  let tid=1, reqN=0, failed=0;
  // previews.json now ships in the repo and every test server serves ROOT.
  // These suites exercise the LOOKUP path, so hide it — otherwise songs
  // resolve from the static file and point at a CDN this test doesn't stub.
  await pg.route(/previews\.json/, r=>r.fulfill({status:404, body:''}));
  await pg.route(/itunes\.apple\.com/, route=>{
    const u=new URL(route.request().url());const cb=u.searchParams.get('callback');const term=u.searchParams.get('term')||'x';
    if(++reqN % 5 === 0){ failed++; route.fulfill({contentType:'text/javascript',body:`${cb}({"resultCount":0,"results":[]})`}); return; }
    route.fulfill({contentType:'text/javascript',body:`${cb}(${JSON.stringify({resultCount:1,results:[{trackId:++tid,trackName:term,artistName:term,collectionName:'T',releaseDate:'1999-01-01',previewUrl:'http://localhost:8095/clip.wav'}]})})`});
  });
  await pg.goto(base,{waitUntil:'load'});
  await pg.waitForTimeout(700);

  await pg.click('.modecard:has-text("Challenges")');
  for(let i=1;i<=5;i++){
    await pg.waitForSelector('.slot.active',{timeout:40000});   // may wait through "Loading more songs…"
    await pg.click('.slot.active');
    await pg.waitForSelector('#overlay.show',{timeout:5000});
    if(i===5) break;
    await pg.click('#sheet .btn.primary');
    await pg.waitForFunction(()=>!document.getElementById('overlay').classList.contains('show'), null, {timeout:5000}).catch(()=>{});
    await pg.waitForTimeout(250);
  }
  await pg.waitForTimeout(400);
  const st = await pg.evaluate(()=>({tries:S.players[0].tries, deck:S.deck.length, run:S.runCards&&S.runCards.length}));
  if(st.tries !== 5) throw new Error('run ended early at '+st.tries+'/5 despite spares (deck '+st.deck+')');
  if(failed < 1) throw new Error('stub never failed a lookup — test proves nothing');
  console.log('run reached 5/5 with', failed, 'failed lookups · deck', st.deck, '· runCards', st.run);
  // the share link carries exactly the played set (anchor + 5), all resolvable
  // (4.14.0 declutter: the share button lives inside the pass-on sheet now)
  await pg.click('text=Challenge friends');
  await pg.waitForTimeout(300);
  await pg.click('text=Share a link');
  await pg.waitForTimeout(300);
  const shared = await pg.evaluate(()=>window.__shared);
  const m = shared && shared.match(/#c=([\d.]+)/);
  if(!m || m[1].split('.').length !== 6) throw new Error('share link should carry exactly 6 played indices: '+shared);
  console.log('share link carries the 6 PLAYED songs only ✓');
  console.log('SPARES TEST PASS ✓');
  await browser.close(); server.close();
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1);});
