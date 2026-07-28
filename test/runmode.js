// E2E: turbo (classic difficulty, solo + 2-player), daily (determinism, lock,
// share) and the challenge-link roundtrip.
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
  await pg.addInitScript(()=>{ navigator.share = t => { window.__shared = (t&&t.text)||String(t); return Promise.resolve(); }; });
  // previews.json now ships in the repo and every test server serves ROOT.
  // These suites exercise the LOOKUP path, so hide it — otherwise songs
  // resolve from the static file and point at a CDN this test doesn't stub.
  await pg.route(/previews\.json/, r=>r.fulfill({status:404, body:''}));
  await pg.route(/itunes\.apple\.com/, route=>{
    const u=new URL(route.request().url());const cb=u.searchParams.get('callback');const term=u.searchParams.get('term')||'x';
    route.fulfill({contentType:'text/javascript',body:`${cb}(${JSON.stringify({resultCount:1,results:[{trackId:++tid,trackName:term,artistName:term,collectionName:'T',releaseDate:'1999-01-01',previewUrl:'http://localhost:8079/clip.wav'}]})})`});
  });
  await pg.goto(url,{waitUntil:'load'});
  await pg.waitForTimeout(700);
  return {ctx,pg};
}
async function placeN(pg, n, collectTitles){
  const titles=[];
  for(let i=1;i<=n;i++){
    await pg.waitForSelector('.slot.active',{timeout:20000});
    await pg.click('.slot.active');
    await pg.waitForSelector('#overlay.show',{timeout:5000});
    if(collectTitles){
      if(i<n) titles.push(await pg.$eval('.reveal-ti', e=>e.textContent.trim()));
      else { // the run's final placement lands straight on the results sheet
        const t = await pg.$eval('#sheet', e=>e.innerText);
        const m = t.match(/last song:\s*[✓✗] \d+ — (.+?) · /);
        titles.push(m ? m[1].trim() : '?');
      }
    }
    if(i===n) break;   // results sheet is already up — nothing to click through
    await pg.click('#sheet .btn.primary');
    // wait until the overlay actually closed before hunting the next slot —
    // otherwise a click can land in the between-turns window (disabled slots)
    await pg.waitForFunction(()=>!document.getElementById('overlay').classList.contains('show'), null, {timeout:5000}).catch(()=>{});
    await pg.waitForTimeout(250);
  }
  return titles;
}

(async()=>{
  await new Promise(r=>server.listen(8079,r));
  const base='http://localhost:8079/';
  const browser = await chromium.launch({executablePath:CHROME,args:['--autoplay-policy=no-user-gesture-required']});

  // --- turbo solo (classic + turbo difficulty) ---
  let {ctx,pg} = await newPage(browser, base);
  await pg.click('.modecard:has-text("Turbo")');         // Turbo is its own mode now
  await pg.click('#players .row >> nth=1 >> .iconbtn');   // default is 2 players; solo test drops one
  await pg.click('text=⚡ Start turbo');
  await placeN(pg, 5);
  let sheet = await pg.$eval('#sheet', e=>e.innerText.replace(/\s+/g,' '));
  if(!/TURBO RUN/.test(sheet) || !/\/5/.test(sheet)) throw new Error('turbo solo results wrong: '+sheet.slice(0,140));
  const hasChal = /Challenge a friend/.test(sheet);
  // misses lock in red: red cards on the board == wrong placements in state == 5 - hits
  const hits = Number(sheet.match(/(\d)\/5/)[1]);
  const wrongState = await pg.evaluate(()=> S.players[0].timeline.filter(c=>c.wrong).length);
  const redCards = await pg.$$eval('.placed', els=>els.filter(e=>(e.getAttribute('style')||'').includes('var(--bad)')).length);
  if(wrongState !== 5-hits) throw new Error('wrong-flag count '+wrongState+' != misses '+(5-hits));
  if(redCards !== wrongState) throw new Error('red cards on board ('+redCards+') != wrong placements ('+wrongState+')');
  console.log('turbo solo: results OK ·', hits+'/5', '· challenge button:', hasChal?'yes':'no', '· misses in red:', redCards);
  await ctx.close();

  // --- turbo 2 players: ranking screen ---
  ({ctx,pg} = await newPage(browser, base));
  await pg.click('.modecard:has-text("Turbo")');   // default 2 players
  await pg.click('text=⚡ Start turbo');
  await placeN(pg, 10);   // 2 players x 5, reveal button rotates automatically
  sheet = await pg.$eval('#sheet', e=>e.innerText.replace(/\s+/g,' '));
  if(!/WINS/.test(sheet) || !(sheet.match(/\/5/g)||[]).length>=2) throw new Error('turbo multi ranking wrong: '+sheet.slice(0,160));
  const placed = await pg.$$eval('.placed', e=>e.length);
  if(placed !== 11){
    const st = await pg.evaluate(()=>({board:S.players[0].timeline.map(c=>c.name+':'+c.year+':o'+c.owner),
      tries:S.players.map(p=>p.tries), hits:S.players.map(p=>p.hits), deck:S.deck.length, used:S.used.size}));
    console.log('DEBUG state:', JSON.stringify(st,null,1));
    throw new Error('board not shared: expected 11 placed cards (1 anchor + 10 locked), got '+placed);
  }
  const colored = await pg.$$eval('.placed .yr[style]', e=>e.length);
  if(colored < 10) throw new Error('owner colors missing: only '+colored+' colored cards');
  console.log('turbo 2p: ranking OK · shared board (11 cards, '+colored+' colored)');
  await ctx.close();

  // --- daily: play, record, share text, challenge link out ---
  ({ctx,pg} = await newPage(browser, base));
  await pg.click('.modecard:has-text("Daily Challenge")');
  const titles1 = await placeN(pg, 5, true);
  sheet = await pg.$eval('#sheet', e=>e.innerText.replace(/\s+/g,' '));
  if(!/DAILY #/.test(sheet) || !/streak/.test(sheet)) throw new Error('daily results wrong: '+sheet.slice(0,140));
  // grab a challenge link from the daily result
  if(!/Challenge friends/.test(sheet)) throw new Error('daily results missing challenge button');
  await pg.click('text=Challenge friends');
  await pg.waitForTimeout(300);
  const shared = await pg.evaluate(()=>window.__shared);
  const m = shared && shared.match(/#c=[\d.]+&s=\d+(?:&t=\d+)?/);
  if(!m) throw new Error('challenge link not in share text: '+shared);
  const chalHash = m[0];
  console.log('daily: results + challenge link OK ·', chalHash.slice(0,26)+'…');
  await pg.click('#sheet button:has-text("Done")');
  await pg.waitForTimeout(400);
  const cardTxt = await pg.$eval('#app', e=>e.innerText);
  if(!/Done ·/.test(cardTxt)) throw new Error('daily card not in done state');
  console.log('daily: played-today lock OK');
  // the lock survives a reload, and the startDaily guard holds
  await pg.reload(); await pg.waitForTimeout(800);
  const relock = await pg.$eval('#app', e=>e.innerText);
  if(!/Done ·/.test(relock)) throw new Error('daily lock lost after reload');
  await pg.evaluate(()=>startDaily());
  await pg.waitForTimeout(400);
  if(!/Done ·/.test(await pg.$eval('#app', e=>e.innerText))) throw new Error('startDaily guard broke after reload');
  console.log('daily: lock survives reload + guard holds OK');
  // opening your OWN link must read as "your challenge", not as a played friend-challenge
  await pg.goto(base + chalHash, {waitUntil:'load'});
  await pg.reload();   // hash-only goto is a same-document navigation; a real link opens fresh
  await pg.waitForTimeout(600);
  const ownTxt = await pg.$eval('#app', e=>e.innerText);
  if(!/your challenge/i.test(ownTxt) || !/Send it to friends/.test(ownTxt)) throw new Error('own-link card wrong: '+ownTxt.slice(0,220));
  console.log('own challenge link: shows YOUR challenge + send prompt OK');
  // a link with a DIFFERENT score on the same set = a friend's result coming back
  const sM = chalHash.match(/&s=(\d+)/); const friendS = (+sM[1]) > 0 ? +sM[1]-1 : +sM[1]+1;
  const resHash = chalHash.replace(/&s=\d+/, '&s='+friendS).replace(/&t=\d+/, '&t=1');
  await pg.goto(base + resHash, {waitUntil:'load'});
  await pg.reload(); await pg.waitForTimeout(600);
  const resTxt = await pg.$eval('#app', e=>e.innerText);
  if(!/challenge result/i.test(resTxt) || !/vs your/.test(resTxt) || !/Rematch/.test(resTxt))
    throw new Error('friend-result card missing: '+resTxt.slice(0,220));
  console.log('friend result link: verdict card OK ('+friendS+'/5 vs own)');
  await ctx.close();

  // --- daily determinism (fresh profile) ---
  ({ctx,pg} = await newPage(browser, base));
  await pg.click('.modecard:has-text("Daily Challenge")');
  const titles2 = await placeN(pg, 5, true);
  if(JSON.stringify(titles1)!==JSON.stringify(titles2)){
    console.log(' run1:',titles1.join(' | ')); console.log(' run2:',titles2.join(' | '));
    throw new Error('daily determinism FAIL');
  }
  console.log('daily determinism: OK');
  await ctx.close();

  // --- challenge roundtrip: open the shared link in a fresh profile ---
  ({ctx,pg} = await newPage(browser, base + chalHash));
  // a playable link greets with a big Accept overlay
  await pg.waitForSelector('#overlay.show',{timeout:5000});
  const invite = await pg.$eval('#sheet', e=>e.innerText.replace(/\s+/g,' '));
  if(!/CHALLENGED/i.test(invite) || !/scored/.test(invite) || !/Accept/.test(invite)) throw new Error('invite overlay wrong: '+invite.slice(0,160));
  // "Not now" falls back to the setup card
  await pg.click('#sheet button:has-text("Not now")');
  await pg.waitForTimeout(300);
  const setupTxt = await pg.$eval('#app', e=>e.innerText);
  if(!/friend challenge/i.test(setupTxt) || !/Beat their/.test(setupTxt)) throw new Error('challenge card missing after dismiss');
  console.log('challenge invite: overlay + Not-now fallback OK');
  // reload → invite again → this time Accept
  await pg.reload(); await pg.waitForTimeout(700);
  await pg.waitForSelector('#overlay.show',{timeout:5000});
  await pg.click('#sheet button:has-text("Accept challenge")');
  const titles3 = await placeN(pg, 5, true);
  sheet = await pg.$eval('#sheet', e=>e.innerText.replace(/\s+/g,' '));
  if(!/CHALLENGE/.test(sheet)) throw new Error('challenge results wrong: '+sheet.slice(0,140));
  if(!/beat their|Tied|They hold it|faster|Dead even/i.test(sheet)) throw new Error('challenge verdict line missing: '+sheet.slice(0,160));
  const sameSongs = JSON.stringify(titles3)===JSON.stringify(titles1);
  if(!sameSongs){
    console.log(' daily :',titles1.join(' | ')); console.log(' chall :',titles3.join(' | '));
    throw new Error('challenge songs differ from the shared run');
  }
  console.log('challenge roundtrip: same songs + verdict OK');
  // answering a link: the share button sends a RESULT, not a fresh gauntlet
  if(!/Send your result back/.test(sheet)) throw new Error('result-back button missing: '+sheet.slice(0,240));
  await pg.click('#sheet button:has-text("Send your result back")');
  await pg.waitForTimeout(300);
  const replyTxt = await pg.evaluate(()=>window.__shared);
  if(!replyTxt || !/I played your Yearworm challenge/.test(replyTxt) || !/#c=[\d.]+&s=\d/.test(replyTxt))
    throw new Error('reply share text wrong: '+replyTxt);
  if(/beat me on the SAME/i.test(replyTxt)) throw new Error('reply text still reads as a challenge');
  console.log('send-result-back: reply-flavored share text OK');
  // back on setup: the link carries the challenger's score and we've played —
  // that's a RESULT card (verdict vs their score), with rematch + send-back.
  // No Play button anywhere on it = the one-shot lock still holds.
  await pg.click('#sheet button:has-text("Done")');
  await pg.waitForTimeout(400);
  let lockTxt = await pg.$eval('#app', e=>e.innerText);
  if(!/challenge result/i.test(lockTxt) || !/vs your/.test(lockTxt)) throw new Error('result card missing after play: '+lockTxt.slice(0,220));
  if(!/Rematch/.test(lockTxt) || !/Send result/.test(lockTxt)) throw new Error('result card buttons missing');
  if(/Beat their/.test(lockTxt)) throw new Error('play card leaked through — one-shot lock broken');
  await pg.reload(); await pg.waitForTimeout(700);
  lockTxt = await pg.$eval('#app', e=>e.innerText);
  if(!/challenge result/i.test(lockTxt)) throw new Error('result card lost after reload');
  // the result card's send-back is reply-flavored too (recipient side)
  await pg.click('#app button:has-text("Send result")');
  await pg.waitForTimeout(300);
  const replyTxt2 = await pg.evaluate(()=>window.__shared);
  if(!replyTxt2 || !/I played your Yearworm challenge/.test(replyTxt2))
    throw new Error('result-card send-back not reply-flavored: '+replyTxt2);
  console.log('challenge result card: verdict + rematch shown, lock holds (incl. reload), reply-flavored send-back');
  await ctx.close();

  // --- fresh self-made challenge: create, play, share, card resets ---
  ({ctx,pg} = await newPage(browser, base));
  const createCard = await pg.$eval('#app', e=>e.innerText);
  if(!/challenge a friend/i.test(createCard)) throw new Error('create-a-challenge card missing on setup');
  // whole card triggers it — tap the description text instead of the Go button
  await pg.click('.modecard:has-text("Challenges")');
  await placeN(pg, 5);
  sheet = await pg.$eval('#sheet', e=>e.innerText.replace(/\s+/g,' '));
  if(!/CHALLENGE/.test(sheet)) throw new Error('fresh challenge results wrong: '+sheet.slice(0,140));
  if(!/Challenge friends/.test(sheet)) throw new Error('fresh challenge missing challenge button');
  await pg.click('#sheet button:has-text("Challenge friends")');   // opens the pass-on sheet
  await pg.waitForTimeout(300);
  await pg.click('#sheet button:has-text("Share a link")');
  await pg.waitForTimeout(300);
  const shared2 = await pg.evaluate(()=>window.__shared);
  if(!shared2 || !/#c=[\d.]+&s=\d/.test(shared2)) throw new Error('fresh challenge share link missing: '+shared2);
  await pg.click('#sheet button:has-text("Done")');
  await pg.waitForTimeout(400);
  const after = await pg.$eval('#app', e=>e.innerText);
  if(!/challenge a friend/i.test(after) || /Beat their/.test(after)) throw new Error('setup should show the CREATE card again, not an incoming one');
  console.log('fresh challenge: create → play → share link → setup resets OK');
  await ctx.close();

  console.log('ALL RUN-MODE TESTS PASS ✓');
  await browser.close(); server.close();
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1);});
