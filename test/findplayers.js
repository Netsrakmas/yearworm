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

  console.log('FIND PLAYERS TEST PASS ✓');

  await browser.close(); server.close();
})().catch(e=>{ console.error('FIND TEST FAIL ✗', e.message); process.exit(1); });
