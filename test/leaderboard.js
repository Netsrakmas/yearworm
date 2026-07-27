// E2E: daily leaderboard client — submit after the daily, rank line + top-3,
// nickname edit resubmits, setup card shows the mini rank. API stubbed.
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
  await new Promise(r=>server.listen(8085,r));
  const base='http://localhost:8085/';
  const browser = await chromium.launch({executablePath:CHROME,args:['--autoplay-policy=no-user-gesture-required']});
  const ctx = await browser.newContext({viewport:{width:540,height:1200},hasTouch:true,serviceWorkers:'block'});
  const pg = await ctx.newPage();
  pg.on('pageerror',e=>console.log('PAGEERROR:',e.message));
  let tid=1;
  await pg.route(/itunes\.apple\.com/, route=>{
    const u=new URL(route.request().url());const cb=u.searchParams.get('callback');const term=u.searchParams.get('term')||'x';
    route.fulfill({contentType:'text/javascript',body:`${cb}(${JSON.stringify({resultCount:1,results:[{trackId:++tid,trackName:term,artistName:term,collectionName:'T',releaseDate:'1999-01-01',previewUrl:'http://localhost:8085/clip.wav'}]})})`});
  });

  const posts = [], gets = [], chalPosts = [], chalGets = [];
  let chalOthers = [];   // extra players the stubbed /chal board reports
  await pg.route(/lb\.test/, route=>{
    const req = route.request();
    if(/\/social/.test(req.url())){   // social state polls are not board traffic
      route.fulfill({ contentType:'application/json',
        body: JSON.stringify({ me:null, friends:[], requests:[], outgoing:0, inbox:[] }),
        headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type'} });
      return;
    }
    // song lookups now go through the API host too — they are not board traffic
    if(/\/lookup/.test(req.url())){
      route.fulfill({ contentType:'application/json', body: JSON.stringify({ results:[], ok:false }),
        headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type'} });
      return;
    }
    const isChal = /\/chal/.test(req.url());
    const rbody = req.method()==='POST' ? (()=>{ try{ return JSON.parse(req.postData()); }catch(e){ return {}; } })() : null;
    if(isChal){
      if(rbody && !rbody.read) chalPosts.push(rbody); else chalGets.push(req.url());
      const results = [{nick:'Player',score:2,timeMs:9000,you:true}, ...chalOthers];
      route.fulfill({ contentType:'application/json',
        body: JSON.stringify({ set:'x', total: results.length, results }),
        headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type'} });
      return;
    }
    const body = { day: 16, total: 42,
      me: { nick:'Player', score: 2, timeMs: 9000, rank: 7 },
      top: [{nick:'Ace',score:5,timeMs:8000},{nick:'Bo',score:4,timeMs:9000},{nick:'Cy',score:4,timeMs:12000}] };
    if(rbody && !rbody.read){ posts.push(rbody); }
    else gets.push(req.url());   // GETs and read-only POSTs are board fetches, not submits
    route.fulfill({ contentType:'application/json', body: JSON.stringify(body),
      headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type'} });
  });

  await pg.goto(base,{waitUntil:'load'});
  await pg.waitForTimeout(700);
  await pg.evaluate(()=>{ LB.url = 'https://lb.test'; });

  // play the daily
  await pg.click('.modecard:has-text("Daily Challenge")');
  for(let i=1;i<=5;i++){
    await pg.waitForSelector('.slot.active',{timeout:20000});
    await pg.click('.slot.active');
    await pg.waitForSelector('#overlay.show',{timeout:5000});
    if(i===5) break;   // final placement lands straight on the results sheet
    await pg.click('#sheet .btn.primary');
    await pg.waitForFunction(()=>!document.getElementById('overlay').classList.contains('show'), null, {timeout:5000}).catch(()=>{});
    await pg.waitForTimeout(250);
  }
  await pg.waitForTimeout(600);
  const sheet = await pg.$eval('#sheet', e=>e.innerText.replace(/\s+/g,' '));
  if(!/#7 of 42 today/.test(sheet)) throw new Error('rank line missing: '+sheet.slice(0,220));
  // per-song recap: collapsed <details> by default, one row per placement
  const recapRows = await pg.$$eval('#runRecap > div', els=>els.map(e=>e.textContent.replace(/\s+/g,' ')));
  if(recapRows.length !== 5) throw new Error('recap should list 5 songs, got '+recapRows.length);
  if(!recapRows.every(r=>/[🟩🟥]/u.test(r) && /\d{4}/.test(r))) throw new Error('recap rows malformed: '+JSON.stringify(recapRows));
  if(await pg.$eval('#runRecap', e=>e.closest('details').open)) throw new Error('recap should start collapsed');
  console.log('per-song recap: 5 rows behind a collapsed toggle OK');
  if(!/Ace 5\/5/.test(sheet) || !/Cy 4\/5/.test(sheet)) throw new Error('top-3 missing: '+sheet.slice(0,220));
  if(posts.length!==1) throw new Error('expected 1 submit, got '+posts.length);
  const p0 = posts[0];
  if(!/^[a-f0-9]{32}$/.test(p0.device) || p0.score==null || p0.timeMs==null || p0.day==null) throw new Error('bad submit payload: '+JSON.stringify(p0));
  console.log('daily submit + rank line + top-3 OK ·', JSON.stringify({day:p0.day, score:p0.score}));

  // the sheet's nickname input is gone (identity lives on Profile since 4.0);
  // the Done button now sits in a sticky footer so it's visible without scrolling
  if(/playing as/.test(sheet)) throw new Error('sheet still shows the redundant nickname field');
  if(!(await pg.$eval('#sheet .sheetfoot button', b=>/Done/.test(b.textContent)))) throw new Error('sticky Done footer missing');

  // back on setup: daily card shows the mini rank (via GET)
  await pg.click('#sheet button:has-text("Done")');
  await pg.waitForTimeout(600);
  const card = await pg.$eval('#app', e=>e.innerText);
  if(!/🌍 #7\/42/.test(card)) throw new Error('daily-card mini rank missing: '+card.slice(0,200));
  if(gets.length<1) throw new Error('expected a board fetch for the daily card');
  // the device token is a bearer credential — board fetches must never put it in a URL
  if([...gets, ...chalGets].some(u=>/device=/.test(u))) throw new Error('device token leaked into a URL');
  // identity now lives on the Profile tab — rename there via the name input
  await pg.evaluate(()=>goTab('profile'));
  await pg.waitForTimeout(300);
  const pName = await pg.$eval('#nickTop', e=>e.value);
  if(!pName || pName.length < 3) throw new Error('profile name missing: '+pName);
  await pg.$eval('#nickTop', e=>{ e.value='Sammy'; e.dispatchEvent(new Event('change')); });
  await pg.waitForTimeout(300);
  if((await pg.evaluate(()=>lbNick()))!=='Sammy') throw new Error('profile rename failed');
  await pg.waitForTimeout(300);
  if(!posts.some(p=>p.nick==='Sammy')) throw new Error('profile rename did not resubmit the daily nick: '+JSON.stringify(posts.map(p=>p.nick)));
  // the finished daily shows up in Profile's "recent games" (from the local feed log)
  const prof = await pg.$eval('#app', e=>e.innerText.replace(/\s+/g,' '));
  if(!/recent games/i.test(prof) || !/Daily #\d+ — \d\/5/.test(prof)) throw new Error('recent games missing the daily: '+prof.slice(0,300));
  // lifetime counters: the finished daily = 1 game, 5 cards; stats show on Profile
  const life = await pg.evaluate(()=>loadLife());
  if((life.games|0) < 1 || (life.cards|0) < 5) throw new Error('lifetime counters wrong: '+JSON.stringify(life));
  if(!/Games/i.test(prof) || !/Cards placed/i.test(prof)) throw new Error('lifetime stats missing on Profile: '+prof.slice(0,200));
  // the submitted rank (stubbed #7) is remembered for the Champion badge
  if((await pg.evaluate(()=>loadDaily().bestRank)) !== 7) throw new Error('bestRank not recorded');
  // stubbed rank #7 ≤ 10 → Champion unlocks outright (counted in the unlock tally)
  if(!/Champion/.test(prof) || !/ACHIEVEMENTS · 2\/30/i.test(prof)) throw new Error('Champion badge missing/not unlocked: '+prof.slice(0,600));
  // the 30-badge grid renders as tiles
  const achTiles = await pg.$$eval('.ach', els=>els.length);
  if(achTiles !== 30) throw new Error('expected 30 achievement tiles, got '+achTiles);
  console.log('daily mini rank + profile rename + recent games + lifetime stats + bestRank OK');

  // avatar picker: tap the pfp, choose a generated musician, it sticks + persists a reload
  await pg.click('.pfpwrap');
  await pg.waitForSelector('.avgrid.muso',{timeout:3000});
  const optCount = await pg.$$eval('.avgrid.muso .avopt', els=>els.length);
  if(optCount !== 60) throw new Error('expected 60 avatar options, got '+optCount);
  if(!(await pg.$eval('.avgrid.muso .avopt svg', e=>!!e))) throw new Error('avatar options are not rendered SVGs');
  await pg.click('.avgrid.muso .avopt >> nth=6');
  await pg.waitForTimeout(300);
  const picked = await pg.evaluate(()=>localStorage.getItem('tl_avatar'));
  if(!/^m:\d+$/.test(picked||'')) throw new Error('picked avatar not stored as m:NN: '+picked);
  if(!(await pg.$eval('.pfp', e=>/<svg/i.test(e.innerHTML)))) throw new Error('pfp did not render the picked SVG');
  await pg.reload(); await pg.waitForTimeout(700);
  await pg.evaluate(()=>{ LB.url = 'https://lb.test'; });   // reload drops the localhost override
  await pg.evaluate(()=>goTab('profile')); await pg.waitForTimeout(300);
  if((await pg.evaluate(()=>localStorage.getItem('tl_avatar'))) !== picked) throw new Error('avatar choice did not persist a reload');
  if(!(await pg.$eval('.pfp', e=>/<svg/i.test(e.innerHTML)))) throw new Error('avatar SVG did not persist a reload');
  console.log('avatar picker: 60 generated musicians, pick + persist OK ('+picked+')');

  // --- step 2: challenge-set boards ---
  // the finished daily also reported to /chal (the set is shareable)
  if(chalPosts.length < 1) throw new Error('run not submitted to /chal: '+chalPosts.length);
  if(!/^\d+(\.\d+)+$/.test(chalPosts[0].set)) throw new Error('bad set key: '+chalPosts[0].set);
  console.log('run submitted to /chal ·', chalPosts[0].set.slice(0,20)+'…');

  // create a fresh challenge; its results sheet shows the set board incl. others
  chalOthers = [{nick:'Jesse',score:4,timeMs:12000}];
  await pg.evaluate(()=>goTab('play')); await pg.waitForTimeout(300);
  await pg.click('.modecard:has-text("Challenges")');
  for(let i=1;i<=5;i++){
    try{ await pg.waitForSelector('.slot.active',{timeout:15000}); }
    catch(e){
      console.log('DEBUG APP:', (await pg.$eval('#app', x=>x.innerText)).slice(0,500).replace(/\n/g,' | '));
      console.log('DEBUG state:', await pg.evaluate(()=>JSON.stringify({mode:S.mode, cur:!!S.current, deck:S.deck.length, used:S.used.size, loading:S.loadingMore, chk:S.checkingTrack, msg:S.checkMessage, chal:S.challenge&&S.challenge.idx})));
      throw e; }
    await pg.click('.slot.active');
    await pg.waitForSelector('#overlay.show',{timeout:5000});
    if(i===5) break;   // final placement lands straight on the results sheet
    await pg.click('#sheet .btn.primary');
    await pg.waitForFunction(()=>!document.getElementById('overlay').classList.contains('show'), null, {timeout:5000}).catch(()=>{});
    await pg.waitForTimeout(250);
  }
  await pg.waitForTimeout(600);
  // the set board lives inside the "Show the songs" toggle now — open it first
  await pg.click('#sheet summary');
  await pg.waitForTimeout(200);
  const chalSheet = await pg.$eval('#sheet', e=>e.innerText.replace(/\s+/g,' '));
  if(!/2 played this set/.test(chalSheet) || !/Jesse 4\/5/.test(chalSheet)) throw new Error('set board missing on results: '+chalSheet.slice(0,240));
  if(!/\(you\)/.test(chalSheet)) throw new Error('own row not marked (you): '+chalSheet.slice(0,240));
  console.log('results sheet shows set board (inside the songs toggle) with Jesse + (you) OK');

  // back on setup: Jesse counts as NEW on our own set -> news card
  await pg.click('#sheet button:has-text("Done")');
  await pg.waitForTimeout(700);
  let news = await pg.$eval('#app', e=>e.innerText);
  if(!/new results on your challenges/i.test(news) || !/Jesse/.test(news)) throw new Error('news card missing: '+news.slice(0,220));
  console.log('news card: Jesse played your challenge OK');

  // seen once = seen; a reload with unchanged board shows no news
  await pg.reload(); await pg.waitForTimeout(900);
  news = await pg.$eval('#app', e=>e.innerText);
  if(/new results on your challenges/i.test(news)) throw new Error('news card should not repeat for already-seen results');
  console.log('news card marks results as seen OK');

  // a fresh profile that hasn't played the daily shows no leaderboard UI yet
  const ctx2 = await browser.newContext({viewport:{width:540,height:1200},hasTouch:true,serviceWorkers:'block'});
  const pg2 = await ctx2.newPage();
  await pg2.route(/workers\.dev|lb\.test/, r=>r.abort());   // and a dead API must stay silent
  await pg2.goto(base,{waitUntil:'load'}); await pg2.waitForTimeout(600);
  const off = await pg2.$eval('#app', e=>e.innerText);
  if(/🌍 #\d/.test(off) || /new results/.test(off)) throw new Error('rank/news UI leaked before playing');
  if(!/Daily Challenge/.test(off) || !/Pass & Play/.test(off)) throw new Error('mode list missing');
  console.log('mode list present · no rank/news before playing · API errors silent OK');
  await ctx2.close();

  console.log('LEADERBOARD TEST PASS ✓');
  await browser.close(); server.close();
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1);});
