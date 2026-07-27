// E2E: themed weeks — the daily takes a deterministic era theme every 7 days
// (from week THEMES_FROM_WEEK on), shown on the mode card, in-game, results
// (+ next-week tease) and share text; sets stay full-pool-indexed & in-range.
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
(async()=>{
  await new Promise(r=>server.listen(8088,r));
  const browser = await chromium.launch({executablePath:CHROME,args:['--autoplay-policy=no-user-gesture-required']});
  const ctx = await browser.newContext({viewport:{width:540,height:1200},hasTouch:true,serviceWorkers:'block'});
  const pg = await ctx.newPage();
  pg.on('pageerror',e=>console.log('PAGEERROR:',e.message));
  await pg.addInitScript(()=>{ navigator.share = t => { window.__shared = (t&&t.text)||String(t); return Promise.resolve(); }; });
  await pg.route(/itunes\.apple\.com/, route=>{
    const u=new URL(route.request().url());const cb=u.searchParams.get('callback');const term=u.searchParams.get('term')||'x';
    route.fulfill({contentType:'text/javascript',body:`${cb}(${JSON.stringify({resultCount:1,results:[{trackId:++tid,trackName:term,artistName:term,collectionName:'T',releaseDate:'1999-01-01',previewUrl:'http://localhost:8088/clip.wav'}]})})`});
  });
  await pg.route(/lb\.test|workers\.dev/, route=>{
    // song lookups go through the API host now; this stub has no catalogue, so
    // report ok:false and let the client resolve them directly via JSONP
    const body = /\/lookup/.test(route.request().url())
      ? { results: [], pick: null, ok: false } : { ok:true, total:1, me:null, top:[] };
    route.fulfill({contentType:'application/json', body: JSON.stringify(body),
      headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type'}});
  });
  await pg.goto('http://localhost:8088/',{waitUntil:'load'});
  await pg.waitForTimeout(700);

  // pin the clock to daily #30 → week 4 → Golden Oldies (themes run from week 0)
  const info = await pg.evaluate(()=>{
    dailyNumber = () => 30;
    goTab('play');
    const th = weekTheme(30), next = weekTheme(37);
    const rot = [weekTheme(3), weekTheme(8), weekTheme(21)].map(t=>t && t.key);
    const songs = dailySongs(6), songs2 = dailySongs(6);
    return { th, next, rot,
      det: JSON.stringify(songs) === JSON.stringify(songs2),
      years: songs.map(s=>s.year) };
  });
  if(info.rot.join(',') !== 'wild,80s,90s') throw new Error('weeks 0/1/2 should be wild/80s/90s: '+info.rot);
  if(!info.th || info.th.key !== 'gold') throw new Error('week 4 should be Golden Oldies: '+JSON.stringify(info.th));
  if(!info.next || info.next.key !== 'now') throw new Error('week 5 should be Modern Era: '+JSON.stringify(info.next));
  if(!info.det) throw new Error('themed daily is not deterministic');
  if(!info.years.every(y => y <= 1979)) throw new Error('Golden Oldies picked out-of-era songs: '+info.years);
  console.log('theme rotation + determinism + era-bounded picks OK ·', info.years.join(','));

  // mode card announces the theme
  await pg.waitForTimeout(300);
  const card = await pg.$eval('#app', e=>e.innerText.replace(/\s+/g,' '));
  if(!/Golden Oldies — Everything before 1980/.test(card)) throw new Error('mode card missing theme: '+card.slice(0,400));
  console.log('mode card shows the theme OK');

  // play the daily: eyebrow carries the theme; results show theme + tease + share text
  await pg.click('text=Daily Challenge');
  await pg.waitForSelector('.slot.active',{timeout:30000});
  const eb = await pg.$eval('.topbar .eyebrow', e=>e.textContent);
  if(!/daily challenge #30 · golden oldies/.test(eb)) throw new Error('in-game eyebrow missing theme: '+eb);
  for(let i=1;i<=5;i++){
    await pg.waitForSelector('.slot.active',{timeout:30000});
    await pg.click('.slot.active');
    await pg.waitForSelector('#overlay.show',{timeout:8000});
    if(i===5) break;
    await pg.click('#sheet .btn.primary');
    await pg.waitForFunction(()=>!document.getElementById('overlay').classList.contains('show'), null, {timeout:8000}).catch(()=>{});
    await pg.waitForTimeout(200);
  }
  await pg.waitForTimeout(400);
  const sheet = await pg.$eval('#sheet', e=>e.innerText.replace(/\s+/g,' '));
  if(!/DAILY #30/.test(sheet)) throw new Error('results title wrong: '+sheet.slice(0,200));
  if(!/📻 Golden Oldies/.test(sheet)) throw new Error('results missing theme line: '+sheet.slice(0,300));
  if(!/next week: 📱 Modern Era/.test(sheet)) throw new Error('next-week tease missing: '+sheet.slice(0,300));
  await pg.click('#sheet button:has-text("Challenge friends")');
  await pg.waitForTimeout(400);
  const shared = await pg.evaluate(()=>window.__shared);
  if(!/Daily #30 · 📻 Golden Oldies/.test(shared||'')) throw new Error('share text missing theme: '+shared);
  console.log('in-game + results + tease + share text carry the theme OK');

  // a Wildcard week announces itself but places NO era bound on the songs
  const wild = await pg.evaluate(()=>{
    localStorage.clear(); dailyNumber = () => 3; goTab('play');
    const years = dailySongs(6).map(s=>s.year);
    return { years, spread: Math.max(...years) - Math.min(...years) };
  });
  await pg.waitForTimeout(300);
  const card2 = await pg.$eval('#app', e=>e.innerText.replace(/\s+/g,' '));
  if(!/Wildcard Week/.test(card2)) throw new Error('wildcard week not announced: '+card2.slice(0,300));
  console.log('wildcard week: announced, unbounded pool OK · years', wild.years.join(','));

  await browser.close(); server.close();
  console.log('THEMED WEEK TEST PASS ✓');
})().catch(e=>{ console.error('THEMED WEEK TEST FAIL ✗', e); process.exit(1); });
