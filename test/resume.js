// Classic save/resume integrity: play → reload → Resume → same game continues,
// per-player clocks survive, a stray turbo toggle can't leak in, and the
// background deck loader RESTARTS (a resumed game must not "run dry" early).
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
  await new Promise(r=>server.listen(8117,r));
  const base='http://localhost:8117/';
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
    route.fulfill({contentType:'text/javascript',body:`${cb}(${JSON.stringify({resultCount:1,results:[{trackId:++tid,trackName:term,artistName:term,collectionName:'T',releaseDate:'1999-01-01',previewUrl:'http://localhost:8117/clip.wav'}]})})`});
  });
  await pg.goto(base,{waitUntil:'load'});
  await pg.waitForTimeout(700);

  // default setup is 2-player classic — start and place two cards
  await pg.click('.modecard:has-text("Pass & Play")');
  await pg.click('text=▶ Start game');
  for(let i=0;i<2;i++){
    await pg.waitForSelector('.slot.active',{timeout:30000});
    await pg.waitForTimeout(400);   // let the turn clock tick a little
    await pg.click('.slot.active');
    await pg.waitForSelector('#overlay.show',{timeout:8000});
    await pg.click('#sheet .btn.primary');
    await pg.waitForFunction(()=>!document.getElementById('overlay').classList.contains('show'), null, {timeout:8000}).catch(()=>{});
    await pg.waitForTimeout(250);
  }
  const before = await pg.evaluate(()=>({
    turn:S.turn, mode:S.mode,
    tls:S.players.map(p=>p.timeline.map(c=>c.id)),
    times:S.players.map(p=>p.timeMs||0),
    deckLen:S.deck.length
  }));
  if(!before.times.some(t=>t>0)) throw new Error('turn clock never ticked pre-reload: '+JSON.stringify(before.times));
  console.log('pre-reload:', JSON.stringify({turn:before.turn, cards:before.tls.map(t=>t.length), deck:before.deckLen}));

  // reload → the resume card appears on the Play home; resume it. (Turbo is now
  // its own mode, not a chip reachable here — resumeSaved forces S.turbo=false.)
  await pg.reload(); await pg.waitForTimeout(800);
  const setupTxt = await pg.$eval('#app', e=>e.innerText);
  if(!/Resume game/.test(setupTxt)) throw new Error('resume card missing after reload');
  await pg.click('text=▶ Resume game');
  await pg.waitForTimeout(800);
  const after = await pg.evaluate(()=>({
    turn:S.turn, mode:S.mode, turbo:S.turbo,
    tls:S.players.map(p=>p.timeline.map(c=>c.id)),
    times:S.players.map(p=>p.timeMs||0),
    deckLen:S.deck.length, current:!!S.current
  }));
  if(after.mode!=='classic' || after.turbo) throw new Error('resume mode wrong (turbo leak?): '+JSON.stringify(after));
  if(after.turn!==before.turn) throw new Error('turn lost on resume: '+before.turn+' -> '+after.turn);
  if(JSON.stringify(after.tls)!==JSON.stringify(before.tls)) throw new Error('timelines changed on resume');
  if(JSON.stringify(after.times)!==JSON.stringify(before.times)) throw new Error('player clocks lost on resume: '+JSON.stringify(before.times)+' -> '+JSON.stringify(after.times));
  if(!after.current) throw new Error('no current card after resume');
  console.log('resume: mode/turn/timelines/clocks intact, turbo toggle did not leak OK');

  // the background loader must restart: the deck keeps growing after resume
  await pg.waitForFunction(len=>S.deck.length>len, before.deckLen, {timeout:30000})
    .catch(()=>{ throw new Error('deck never grew after resume — loader not restarted'); });
  console.log('background deck loader restarted after resume OK ·', await pg.evaluate(()=>S.deck.length), 'cards');

  // and the game is actually playable: one more placement goes through
  await pg.waitForSelector('.slot.active',{timeout:30000});
  await pg.click('.slot.active');
  await pg.waitForSelector('#overlay.show',{timeout:8000});
  console.log('placement after resume OK');

  console.log('RESUME TEST PASS ✓');
  await browser.close(); server.close();
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1);});
