// E2E: guided first round (onboarding) — hero card for blank players only,
// 3-song coached run with pulsing slots, finish sheet funnels into the Daily,
// nothing recorded as a one-shot set.
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

let tid=1;
async function newPage(browser, url){
  const ctx = await browser.newContext({viewport:{width:540,height:1200},hasTouch:true,serviceWorkers:'block'});
  const pg = await ctx.newPage();
  pg.on('pageerror',e=>console.log('PAGEERROR:',e.message));
  // previews.json now ships in the repo and every test server serves ROOT.
  // These suites exercise the LOOKUP path, so hide it — otherwise songs
  // resolve from the static file and point at a CDN this test doesn't stub.
  await pg.route(/previews\.json/, r=>r.fulfill({status:404, body:''}));
  await pg.route(/itunes\.apple\.com/, route=>{
    const u=new URL(route.request().url());const cb=u.searchParams.get('callback');const term=u.searchParams.get('term')||'x';
    route.fulfill({contentType:'text/javascript',body:`${cb}(${JSON.stringify({resultCount:1,results:[{trackId:++tid,trackName:term,artistName:term,collectionName:'T',releaseDate:'1999-01-01',previewUrl:'http://localhost:8085/clip.wav'}]})})`});
  });
  await pg.goto(url,{waitUntil:'load'});
  await pg.waitForTimeout(700);
  return {ctx,pg};
}

(async()=>{
  await new Promise(r=>server.listen(8085,r));
  const base='http://localhost:8085/';
  const browser = await chromium.launch({executablePath:CHROME,args:['--autoplay-policy=no-user-gesture-required']});

  // 1) blank player: hero card shows, intro paragraph yields to it
  const {ctx,pg} = await newPage(browser, base);
  let home = await pg.$eval('#app', e=>e.innerText.replace(/\s+/g,' '));
  if(!/first time here\?/i.test(home) || !/Play your first round/.test(home))
    throw new Error('tutorial hero missing for a blank player: '+home.slice(0,300));
  if(/Hear a mystery track and drop it into your timeline/.test(home))
    throw new Error('lobby intro paragraph should yield to the hero card');
  console.log('blank player: hero card replaces the intro OK');

  // 2) start the guided round: tut framing + coach hint + pulsing slots
  await pg.click('#app button:has-text("Play your first round")');
  await pg.waitForSelector('.slot.active',{timeout:30000});
  const eyebrow = await pg.$eval('.topbar .eyebrow', e=>e.textContent);
  if(!/your first round/.test(eyebrow)) throw new Error('tut eyebrow wrong: '+eyebrow);
  const stage = await pg.$eval('.stage', e=>e.innerText.replace(/\s+/g,' '));
  if(!/older/.test(stage) || !/newer/.test(stage) || !/Tap a gap/.test(stage))
    throw new Error('coach hint missing on the stage: '+stage.slice(0,240));
  if(!/\b19\d\d|\b20\d\d/.test(stage)) throw new Error('coach hint should name the anchor year: '+stage);
  if(!await pg.$('.timeline.tutpulse')) throw new Error('slots not pulsing on the first song');
  const hud = await pg.$eval('.lb2', e=>e.innerText.replace(/\s+/g,' '));
  if(!/song 1\/3/.test(hud)) throw new Error('tut HUD should count to 3: '+hud);
  console.log('guided round: framing + coach hint + pulse + /3 HUD OK');

  // 3) three placements: coached reveals, then the finish sheet
  await pg.click('.slot.active');
  await pg.waitForSelector('#overlay.show',{timeout:8000});
  let rev = await pg.$eval('#sheet', e=>e.innerText.replace(/\s+/g,' '));
  if(!/locks (onto the line )?at its true year/.test(rev)) throw new Error('first reveal not coached: '+rev.slice(0,240));
  if(/Wrong year in our data/.test(rev)) throw new Error('flag block should be hidden in the tutorial');
  await pg.click('#sheet .btn.primary');
  await pg.waitForFunction(()=>!document.getElementById('overlay').classList.contains('show'), null, {timeout:8000}).catch(()=>{});
  await pg.waitForSelector('.slot.active',{timeout:30000});
  if(await pg.$('.timeline.tutpulse')) throw new Error('pulse should stop after the first placement');
  await pg.click('.slot.active');
  await pg.waitForSelector('#overlay.show',{timeout:8000});
  rev = await pg.$eval('#sheet', e=>e.innerText.replace(/\s+/g,' '));
  if(!/gaps get tighter/.test(rev)) throw new Error('second reveal not coached: '+rev.slice(0,240));
  await pg.click('#sheet .btn.primary');
  await pg.waitForFunction(()=>!document.getElementById('overlay').classList.contains('show'), null, {timeout:8000}).catch(()=>{});
  await pg.waitForSelector('.slot.active',{timeout:30000});
  await pg.click('.slot.active');
  await pg.waitForSelector('#overlay.show',{timeout:8000});
  const fin = await pg.$eval('#sheet', e=>e.innerText.replace(/\s+/g,' '));
  if(!/THAT'S YEARWORM!/.test(fin)) throw new Error('finish sheet missing: '+fin.slice(0,240));
  if(!/You placed \d\/3/.test(fin)) throw new Error('finish score not /3: '+fin.slice(0,240));
  if(!/Play today's Daily/.test(fin) || !/Explore the modes/.test(fin)) throw new Error('finish CTAs missing: '+fin.slice(0,240));
  console.log('three placements: coached reveals + finish sheet with CTAs OK');

  // 4) nothing burned: no one-shot chal record, no daily record, no saved game
  const stored = await pg.evaluate(()=>({ chals: localStorage.getItem('tl_chals'), daily: localStorage.getItem('tl_daily'),
    game: localStorage.getItem('tl_game'), tut: localStorage.getItem('tl_tut'), life: localStorage.getItem('tl_life') }));
  if(stored.chals && Object.keys(JSON.parse(stored.chals)).length) throw new Error('tutorial burned a chal record: '+stored.chals);
  if(stored.daily && JSON.parse(stored.daily).last) throw new Error('tutorial recorded a daily: '+stored.daily);
  if(stored.game) throw new Error('tutorial saved a resumable game');
  if(stored.tut !== '1') throw new Error('tl_tut flag not set');
  if(((JSON.parse(stored.life||'{}').games)|0) !== 1) throw new Error('tutorial should count as one lifetime game: '+stored.life);
  console.log('no one-shot burn, no save, tut flag + lifetime game counted OK');

  // 5) the Daily CTA actually starts the daily
  await pg.click('#sheet button:has-text("Play today\'s Daily")');
  await pg.waitForSelector('.slot.active',{timeout:30000});
  const eb2 = await pg.$eval('.topbar .eyebrow', e=>e.textContent);
  if(!/daily challenge #/.test(eb2)) throw new Error('Daily CTA did not start the daily: '+eb2);
  console.log('finish sheet funnels into the daily OK');

  // 6) back in the lobby the hero is gone (flag set + a game played)
  pg.once('dialog', d=>d.accept());
  await pg.click('.topbar button:has-text("Quit")');
  await pg.waitForTimeout(500);
  home = await pg.$eval('#app', e=>e.innerText.replace(/\s+/g,' '));
  if(/first time here\?/i.test(home)) throw new Error('hero card should disappear after the tutorial');
  console.log('hero gone after the guided round OK');
  await ctx.close();

  // 7) experienced player (lifetime games > 0, no flag): no hero, intro shows
  const {ctx:ctx2, pg:pg2} = await newPage(browser, base);
  await pg2.evaluate(()=>{ localStorage.clear(); localStorage.setItem('tl_life', JSON.stringify({games:5, cards:25})); });
  await pg2.reload({waitUntil:'load'});
  await pg2.waitForTimeout(700);
  const home2 = await pg2.$eval('#app', e=>e.innerText.replace(/\s+/g,' '));
  if(/first time here\?/i.test(home2)) throw new Error('hero should not show for an experienced player');
  if(!/Hear a mystery track and drop it into your timeline/.test(home2)) throw new Error('intro paragraph missing for experienced player');
  console.log('experienced player: no hero, intro back OK');
  await ctx2.close();

  await browser.close(); server.close();
  console.log('TUTORIAL TEST PASS ✓');
})().catch(e=>{ console.error('TUTORIAL TEST FAIL ✗', e); process.exit(1); });
