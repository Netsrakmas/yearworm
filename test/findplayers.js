// FULL-STACK: the real index.html talking to the real worker.js over a
// better-sqlite3 D1 shim. Stubbed-network tests proved the wiring; this proves
// the feature — Sam reported search "does not seem to work" in production.
const http = require('http');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { chromium } = require('playwright-core');

const ROOT = '/home/user/Timeline';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

(async()=>{
  // ---- real worker over an in-memory D1 ----
  const sqlite = new Database(':memory:');
  let schema = fs.readFileSync(ROOT+'/server/schema.sql','utf8');
  schema = schema.replace(/^\s*--.*$/gm,'').replace(/CREATE INDEX[\s\S]*?;/gi,'');
  sqlite.exec(schema);
  const P = a => a.length ? [Object.fromEntries(a.map((v,i)=>[i+1, v===undefined?null:v]))] : [];
  const DB = { prepare(sql){ const st = sqlite.prepare(sql); let a=[]; const api = {
    bind(...x){ a=x; return api; },
    first(){ const r = st.get(...P(a)); return r===undefined?null:r; },
    all(){ return { results: st.all(...P(a)) }; },
    run(){ const i = st.run(...P(a)); return { meta:{ changes:i.changes } }; } }; return api; } };
  const worker = (await import(ROOT+'/server/worker.js')).default;
  const env = { DB, VAPID_PUBLIC:'', VAPID_PRIVATE:'', GOOGLE_CLIENT_ID:'' };
  const ctxW = { waitUntil:p=>p };

  const server = http.createServer(async (req,res)=>{
    const u = new URL(req.url, 'http://localhost:8107');
    // anything the worker owns goes to the worker, exactly as in production
    if(/^\/(social|daily|chal|sboard|health|auth|push-rotate)$/.test(u.pathname)){
      const chunks=[]; for await(const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks).toString() : undefined;
      const wreq = new Request('https://api.test'+u.pathname+u.search, {
        method:req.method, headers:{ 'content-type':'application/json', 'Origin':'http://localhost:8107' },
        body: (req.method==='GET'||req.method==='HEAD') ? undefined : body });
      let wres; try{ wres = await worker.fetch(wreq, env, ctxW); }
      catch(e){ res.writeHead(500); return res.end(JSON.stringify({error:String(e && e.message)})); }
      const text = await wres.text();
      res.writeHead(wres.status, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'content-type' });
      return res.end(text);
    }
    let p = decodeURIComponent(u.pathname); if(p==='/')p='/index.html';
    const f = path.join(ROOT,p);
    if(!f.startsWith(ROOT)||!fs.existsSync(f)){res.writeHead(404);return res.end();}
    res.writeHead(200,{'Content-Type':p.endsWith('.html')?'text/html':'application/octet-stream'});
    fs.createReadStream(f).pipe(res);
  });
  await new Promise(r=>server.listen(8107,r));
  const base = 'http://localhost:8107/';

  const browser = await chromium.launch({executablePath:CHROME});
  const mkPlayer = async (name) => {
    const c = await browser.newContext({viewport:{width:430,height:900},hasTouch:true,serviceWorkers:'block'});
    const pg = await c.newPage();
    pg.on('pageerror',e=>console.log('PAGEERROR['+name+']:',e.message));
    await pg.goto(base,{waitUntil:'load'});
    await pg.waitForTimeout(500);
    await pg.evaluate(()=>{ LB.url = location.origin; });
    await pg.evaluate(n=>claimHandle(n), name);
    await pg.waitForTimeout(400);
    const prof = await pg.evaluate(()=>loadProfile());
    if(!prof || prof.handle !== name) throw new Error('claim failed for '+name+': '+JSON.stringify(prof));
    return { c, pg };
  };

  const sam   = await mkPlayer('Sam');
  const turbo = await mkPlayer('TurboPinguin');
  const jesse = await mkPlayer('Jesse');
  console.log('three real accounts claimed against the real worker OK');

  const search = async (q) => {
    await sam.pg.evaluate(()=>goTab('friends'));
    await sam.pg.waitForTimeout(500);
    await sam.pg.fill('#findIn', q);
    await sam.pg.waitForTimeout(700);
    return (await sam.pg.$eval('#findOut', e=>e.innerText)).replace(/\s+/g,' ').trim();
  };

  // 1) the ordinary case: type the start of a real player's name
  const r1 = await search('Turbo');
  if(!/TurboPinguin/.test(r1)) throw new Error('searching the start of a name found nothing: "'+r1+'"');
  console.log('search "Turbo" → TurboPinguin OK');

  // 2) case-insensitivity: nobody types capitals on a phone keyboard
  const r2 = await search('turbo');
  if(!/TurboPinguin/.test(r2)) throw new Error('lowercase search failed: "'+r2+'"');
  console.log('search "turbo" (lowercase) → TurboPinguin OK');

  // 3) THE REPORTED CASE: a word from the middle/end of the name. Prefix-only
  // found nothing here, and to the player that IS "it does not work".
  const r3 = await search('pinguin');
  if(!/TurboPinguin/.test(r3)) throw new Error('mid-name search still finds nothing: "'+r3+'"');
  console.log('search "pinguin" (mid-name) → TurboPinguin OK');

  // prefix matches must still rank above mid-name ones: searching "Jes" with a
  // "Jesse" and a "TurboJesper" around should put Jesse first
  await mkPlayer('TurboJesper');
  const r5 = await search('Jes');
  if(r5.indexOf('Jesse') === -1 || (r5.indexOf('TurboJesper') !== -1 && r5.indexOf('Jesse') > r5.indexOf('TurboJesper')))
    throw new Error('prefix match should rank first: "'+r5+'"');
  console.log('ranking: prefix match ahead of mid-name match OK');

  // 4) searching your OWN name finds nothing (you are excluded by design) —
  // which reads as broken unless the app says why
  const r4 = await search('Sam');
  if(!/your own name/i.test(r4)) throw new Error('own-name search not explained: "'+r4+'"');
  console.log('search own name → explained, not a blank "not found" OK');

  // a genuinely absent name still says so plainly
  const r6 = await search('Zzzz');
  if(!/claimed a name/.test(r6)) throw new Error('absent name message wrong: "'+r6+'"');
  console.log('absent name → explains that they must claim a name first OK');

  // 5) REPORTED: searching a person's full real name when their handle is only
  // part of it. You know her as "Carmen Sophie"; she claimed "Carmen".
  // the empty state ECHOES the query, so "contains the name" is not proof of a
  // hit — assert on the result row markup instead
  const hits = async (q) => {
    await search(q);
    return await sam.pg.$$eval('#findOut b', els => els.map(e=>e.textContent));
  };
  await mkPlayer('Carmen');
  const h7 = await hits('Carmen Sophie');
  if(!h7.includes('Carmen')) throw new Error('full name did not find the shorter handle: '+JSON.stringify(h7));
  console.log('search "Carmen Sophie" → finds handle "Carmen" OK');

  // …and the reverse: she claimed the full name, you type one word
  await mkPlayer('Sophie de Vries');
  const h8 = await hits('Vries');
  if(!h8.includes('Sophie de Vries')) throw new Error('single word did not find the full handle: '+JSON.stringify(h8));
  console.log('search "Vries" → finds "Sophie de Vries" OK');

  // the handle matching the MOST words of the query ranks first
  const h9 = await hits('Sophie de Vries');
  if(h9[0] !== 'Sophie de Vries') throw new Error('fullest match should lead: '+JSON.stringify(h9));
  console.log('ranking: the handle matching most words comes first OK');

  // 6) A FAILED search must never be reported as "that person doesn't exist".
  // The per-IP rate limiter is 30/min across every social endpoint, and typing
  // burns several — so someone testing repeatedly sits at 429 and is told,
  // confidently and wrongly, that their friend has no account.
  await sam.pg.route(/\/social/, r => r.fulfill({ status:429, contentType:'application/json',
    headers:{'Access-Control-Allow-Origin':'*'}, body:JSON.stringify({error:'slow down'}) }));
  const r429 = await search('Carmen');
  if(/claimed a name|Nobody|No “/.test(r429))
    throw new Error('a rate-limited search claims the player does not exist: "'+r429+'"');
  if(!/again/i.test(r429)) throw new Error('rate-limited search gives no way forward: "'+r429+'"');
  console.log('rate-limited search → says the search failed, not that she is missing OK');

  await sam.pg.route(/\/social/, r => r.abort());
  const rOff = await search('Carmen');
  if(/claimed a name|Nobody|No “/.test(rOff))
    throw new Error('an offline search claims the player does not exist: "'+rOff+'"');
  console.log('offline search → says the search failed, not that she is missing OK');
  await sam.pg.unroute(/\/social/);

  // 7) ADD FRIEND STRAIGHT FROM THE LEADERBOARD. Most players never rename
  // themselves ("Shady Penguin"), so their real name is unsearchable — seeing
  // them on the board is often the only way you'll recognise anyone.
  const stranger = await mkPlayer('Retro Walrus');
  await stranger.pg.evaluate(()=>socialPost({action:'srun', score: 42}));
  await sam.pg.evaluate(()=>socialPost({action:'srun', score: 7}));
  await sam.pg.waitForTimeout(400);

  await sam.pg.evaluate(()=>goTab('ranks'));
  await sam.pg.waitForTimeout(1200);
  const board = await sam.pg.$eval('#ranksSurvDay', e=>e.innerText.replace(/\s+/g,' '));
  if(!/Retro Walrus/.test(board)) throw new Error('stranger missing from the world board: '+board);
  // my own row must never offer "add yourself"
  const rows = await sam.pg.$$('#ranksSurvDay .row');
  const mineHasBtn = await sam.pg.evaluate(()=>{
    const r = [...document.querySelectorAll('#ranksSurvDay .row')].find(x=>/\(you\)/.test(x.innerText));
    return !!(r && r.querySelector('button[aria-label*="friend"]'));
  });
  if(mineHasBtn) throw new Error('own board row offers an add-friend button');
  const addBtn = await sam.pg.$('#ranksSurvDay button[aria-label="Add as friend"]');
  if(!addBtn) throw new Error('no add-friend button on the stranger row (rows: '+rows.length+')');
  await addBtn.click();
  await sam.pg.waitForTimeout(800);
  // it must become a PENDING request, not an instant friendship
  const st = await sam.pg.evaluate(()=>socialPost({action:'state'}).then(r=>r.body));
  if((st.friends||[]).some(f=>f.handle==='Retro Walrus')) throw new Error('board add created an instant friendship');
  if(!(st.outgoingIds||[]).length) throw new Error('board add did not create an outgoing request: '+JSON.stringify(st.outgoing));
  console.log('board add: request sent (pending), own row exempt OK');

  // and the row now shows "asked" instead of another + button
  await sam.pg.evaluate(()=>goTab('ranks'));
  await sam.pg.waitForTimeout(1200);
  if(await sam.pg.$('#ranksSurvDay button[aria-label="Add as friend"]'))
    throw new Error('already-requested player still offers an add button');
  console.log('board add: row flips to ⏳ after the request OK');

  // once they accept, the button is gone for good
  const wSt = await stranger.pg.evaluate(()=>socialPost({action:'state'}).then(r=>r.body));
  const samId = wSt.requests[0] && wSt.requests[0].id;
  if(!samId) throw new Error('stranger never received the request: '+JSON.stringify(wSt.requests));
  await stranger.pg.evaluate(id=>socialPost({action:'accept', user:id}), samId);
  await sam.pg.evaluate(()=>goTab('ranks'));
  await sam.pg.waitForTimeout(1200);
  const after = await sam.pg.$eval('#ranksSurvDay', e=>e.innerText.replace(/\s+/g,' '));
  if(!/Retro Walrus/.test(after)) throw new Error('friend vanished from the board');
  if(await sam.pg.$('#ranksSurvDay button[aria-label="Add as friend"]'))
    throw new Error('an existing friend still offers an add button');
  console.log('board add: existing friend offers no button OK');

  // 7) RENAMING must reach the server. Everyone starts on a generated name
  // ("Groovy Flamingo"), so renaming is the ONE step that makes a person
  // findable — and it only ever touched localStorage, so nobody could search
  // the name their friend had actually picked.
  const carmen = await mkPlayer('Shady Penguin');
  await carmen.pg.evaluate(()=>goTab('profile'));
  await carmen.pg.waitForTimeout(400);
  await carmen.pg.fill('#nickTop', 'Carmen Sophie');
  await carmen.pg.$eval('#nickTop', e=>e.dispatchEvent(new Event('change')));
  await carmen.pg.waitForTimeout(700);
  const hRen = await hits('Carmen Sophie');
  if(!hRen.includes('Carmen Sophie')) throw new Error('renamed player is not searchable: '+JSON.stringify(hRen));
  const hOld = await hits('Shady Penguin');
  if(hOld.includes('Shady Penguin')) throw new Error('the OLD name still resolves after a rename: '+JSON.stringify(hOld));
  console.log('rename → server updated, new name searchable, old name gone OK');

  // a rename to a name someone else holds must be refused, not silently kept
  await carmen.pg.fill('#nickTop', 'Jesse');
  await carmen.pg.$eval('#nickTop', e=>e.dispatchEvent(new Event('change')));
  await carmen.pg.waitForTimeout(700);
  const stillHers = await hits('Carmen Sophie');
  if(!stillHers.includes('Carmen Sophie')) throw new Error('a rejected rename lost the original name: '+JSON.stringify(stillHers));
  console.log('rename to a taken name → refused, original kept OK');

  // 8) the leaderboard add-friend button: + for a stranger, ✓ for a friend,
  // nothing for yourself. With few players every row is a friend, and rendering
  // NOTHING there reads as "the button was never built".
  const day = await sam.pg.evaluate(()=>dailyNumber());
  await sam.pg.evaluate(d=>lbSubmitDaily(4, 30000, d), day);
  await carmen.pg.evaluate(d=>lbSubmitDaily(5, 25000, d), day);
  await turbo.pg.evaluate(d=>lbSubmitDaily(3, 40000, d), day);
  await sam.pg.waitForTimeout(400);
  // Sam befriends Turbo so the board has one of each kind
  const turboId = (await hits('TurboPinguin'))[0] && await sam.pg.evaluate(async()=>{
    const r = await socialPost({action:'find', q:'TurboPinguin'}); return r.body.results[0].id; });
  await sam.pg.evaluate(id=>socialPost({action:'request', user:id}), turboId);
  await turbo.pg.evaluate(async()=>{ const r = await socialPost({action:'state'});
    if(r.body.requests[0]) await socialPost({action:'accept', user:r.body.requests[0].id}); });
  await sam.pg.evaluate(()=>goTab('ranks'));
  await sam.pg.waitForTimeout(1500);
  const drows = await sam.pg.$$eval('#ranksDaily .row', rows => rows.map(r => ({
    name: (r.querySelector('b')||{}).textContent || '',
    btn: (r.querySelector('button')||{}).textContent || '',
    tick: /✓/.test(r.textContent) })));
  const rowFor = n => drows.find(r => r.name.indexOf(n) === 0);
  if(!rowFor('Carmen Sophie') || rowFor('Carmen Sophie').btn !== '+')
    throw new Error('no add button for a stranger on the daily board: '+JSON.stringify(drows));
  if(!rowFor('TurboPinguin') || !rowFor('TurboPinguin').tick)
    throw new Error('existing friend not marked on the daily board: '+JSON.stringify(drows));
  if(rowFor('Sam') && (rowFor('Sam').btn || rowFor('Sam').tick))
    throw new Error('your own row should carry no add control: '+JSON.stringify(drows));
  console.log('daily board: + for a stranger, ✓ for a friend, nothing for you OK');

  // tapping it actually sends the request
  const askedBefore = await sam.pg.evaluate(()=>((_social&&_social.outgoingIds)||[]).length);
  await sam.pg.click('#ranksDaily .row:has-text("Carmen Sophie") button');
  await sam.pg.waitForTimeout(900);
  const askedAfter = await sam.pg.evaluate(async()=>{ const r = await socialPost({action:'state'});
    return (r.body.outgoingIds||[]).length; });
  if(askedAfter <= askedBefore) throw new Error('board add button did not send a request ('+askedBefore+'→'+askedAfter+')');
  console.log('daily board: tapping + sends a friend request OK');

  // 9) A player with NO account who renames themselves in Profile. This is the
  // real Carmen case: she typed her name, it rode along with her daily score so
  // the board showed "Carmen Sophie" — but no profile existed, so she could not
  // be searched or added, and her row carried no "+" at all.
  const anon = await browser.newContext({viewport:{width:430,height:900},hasTouch:true,serviceWorkers:'block'});
  const apg = await anon.newPage();
  apg.on('pageerror',e=>console.log('PAGEERROR[anon]:',e.message));
  await apg.goto(base,{waitUntil:'load'}); await apg.waitForTimeout(500);
  await apg.evaluate(()=>{ LB.url = location.origin; });
  if(await apg.evaluate(()=>!!loadProfile())) throw new Error('fresh device should have no profile');
  const anonDay = await apg.evaluate(()=>dailyNumber());
  await apg.evaluate(d=>lbSubmitDaily(1, 50000, d), anonDay);   // plays before naming herself
  await apg.evaluate(()=>goTab('profile')); await apg.waitForTimeout(400);
  await apg.fill('#nickTop', 'Nina Kropf');
  await apg.$eval('#nickTop', e=>e.dispatchEvent(new Event('change')));
  await apg.waitForTimeout(900);
  const anonProf = await apg.evaluate(()=>loadProfile());
  if(!anonProf || anonProf.handle !== 'Nina Kropf')
    throw new Error('renaming without an account did not claim one: '+JSON.stringify(anonProf));
  const hNina = await hits('Nina Kropf');
  if(!hNina.includes('Nina Kropf')) throw new Error('auto-claimed player is not searchable: '+JSON.stringify(hNina));
  console.log('no account + rename → claims the name, immediately searchable OK');

  // …and a row that genuinely has no account explains itself instead of
  // rendering a blank cell (which reads as a broken button)
  const ghost = await browser.newContext({viewport:{width:430,height:900},hasTouch:true,serviceWorkers:'block'});
  const gpg = await ghost.newPage();
  await gpg.goto(base,{waitUntil:'load'}); await gpg.waitForTimeout(500);
  await gpg.evaluate(()=>{ LB.url = location.origin; store.set('tl_nick','Ghost Player'); });
  await gpg.evaluate(d=>lbSubmitDaily(2, 45000, d), anonDay);
  await sam.pg.evaluate(()=>goTab('play'));
  await sam.pg.evaluate(()=>goTab('ranks'));
  await sam.pg.waitForTimeout(1500);
  const gRow = await sam.pg.$$eval('#ranksDaily .row', rows => rows.map(r => ({
    name:(r.querySelector('b')||{}).textContent||'', btn:(r.querySelector('button')||{}).textContent||'' })));
  const ghostRow = gRow.find(r => r.name.indexOf('Ghost Player') === 0);
  if(!ghostRow) throw new Error('account-less player missing from the board: '+JSON.stringify(gRow));
  if(ghostRow.btn !== '?') throw new Error('account-less row should explain itself, got: '+JSON.stringify(ghostRow));
  await sam.pg.click('#ranksDaily .row:has-text("Ghost Player") button');
  await sam.pg.waitForTimeout(400);
  const tip = await sam.pg.$eval('body', e=>e.innerText);
  if(!/claimed a name yet/.test(tip)) throw new Error('no explanation toast for an account-less row');
  console.log('board row without an account → "?" explains why, no blank cell OK');
  await anon.close(); await ghost.close();

  console.log('FIND PLAYERS TEST PASS ✓');

  await browser.close(); server.close();
})().catch(e=>{ console.error('FIND TEST FAIL ✗', e.message); process.exit(1); });
