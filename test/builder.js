// The custom deck builder. It has had NO coverage, which is how a rename in
// 4.38.0 left it calling a function that no longer existed — it would have
// thrown the moment anyone typed a search. It also exercises searchRaw, the
// path that needs Apple's RAW candidate list rather than the server's pick.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = '/home/user/Timeline';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const server = http.createServer((req,res)=>{
  let p = decodeURIComponent(req.url.split('?')[0]); if(p==='/')p='/index.html';
  const f = path.join(ROOT,p);
  if(!f.startsWith(ROOT)||!fs.existsSync(f)){res.writeHead(404);return res.end();}
  res.writeHead(200,{'Content-Type':p.endsWith('.html')?'text/html':'application/octet-stream'});
  fs.createReadStream(f).pipe(res);
});

const song = (id, name) => ({ trackId:id, trackName:name, artistName:'ABBA', collectionName:'Gold',
  releaseDate:'1974-04-06', previewUrl:'https://p/'+id+'.m4a', trackViewUrl:'https://music.apple.com/'+id,
  trackTimeMillis:167000 });

(async()=>{
  await new Promise(r=>server.listen(8110,r));
  const browser = await chromium.launch({executablePath:CHROME});
  const ctx = await browser.newContext({viewport:{width:430,height:900},hasTouch:true,serviceWorkers:'block'});
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', e=>errs.push(e.message));

  let proxyCalls = 0, proxyUp = true, jsonpCalls = 0;
  await pg.route(/\/lookup$/, route=>{
    proxyCalls++;
    const b = JSON.parse(route.request().postData()||'{}');
    if(!proxyUp) return route.fulfill({status:200, contentType:'application/json',
      headers:{'Access-Control-Allow-Origin':'*'}, body:JSON.stringify({ results:[], pick:null, ok:false })});
    // no title in the request => the server must hand back the RAW list
    if(b.title) return route.fulfill({status:200, contentType:'application/json',
      headers:{'Access-Control-Allow-Origin':'*'}, body:JSON.stringify({ ok:true, pick:song(1,'Waterloo'), results:[song(1,'Waterloo')] })});
    route.fulfill({status:200, contentType:'application/json', headers:{'Access-Control-Allow-Origin':'*'},
      body: JSON.stringify({ ok:true, pick:null, results:[song(1,'Waterloo'), song(2,'Mamma Mia'), song(3,'No Preview')].map(
        (s,i)=> i===2 ? Object.assign({}, s, {previewUrl:undefined}) : s) })});
  });
  await pg.route(/itunes\.apple\.com/, route=>{
    jsonpCalls++;
    const u = new URL(route.request().url()), cb = u.searchParams.get('callback');
    route.fulfill({contentType:'text/javascript', body:`${cb}(${JSON.stringify({resultCount:1, results:[song(9,'Direct Hit')]})})`});
  });

  await pg.goto('http://localhost:8110/',{waitUntil:'load'});
  await pg.waitForTimeout(500);
  await pg.evaluate(()=>{ LB.url = 'https://api.test'; });

  // 1) open the builder and search — the case that was silently broken
  await pg.evaluate(()=>newDeck());
  await pg.waitForSelector('#sq', {timeout:5000});
  await pg.fill('#sq', 'abba');
  await pg.click('button:has-text("Search")');
  await pg.waitForTimeout(600);
  if(errs.length) throw new Error('builder search threw: '+errs.join(' | '));
  const results = await pg.evaluate(()=>(S.builder.results||[]).map(r=>r.trackName));
  if(!results.length) throw new Error('search returned nothing');
  if(!results.includes('Waterloo') || !results.includes('Mamma Mia'))
    throw new Error('builder needs the RAW candidate list, got: '+JSON.stringify(results));
  if(results.includes('No Preview')) throw new Error('unplayable result was not filtered out');
  console.log('builder search: raw candidate list via the proxy, unplayable filtered OK · '+JSON.stringify(results));

  // 2) the builder must NOT get the server's single pick — it's a menu to choose
  // from, so asking for a pick would collapse it to one row
  if(proxyCalls < 1) throw new Error('builder never used the proxy');
  console.log('builder search: went through the lookup proxy OK');

  // 3) proxy down → falls back to a direct Apple search rather than dying
  proxyUp = false;
  const jBefore = jsonpCalls;
  await pg.fill('#sq', 'direct');
  await pg.click('button:has-text("Search")');
  await pg.waitForTimeout(600);
  if(errs.length) throw new Error('fallback search threw: '+errs.join(' | '));
  if(jsonpCalls <= jBefore) throw new Error('no direct fallback when the proxy is down');
  const fb = await pg.evaluate(()=>(S.builder.results||[]).map(r=>r.trackName));
  if(!fb.includes('Direct Hit')) throw new Error('direct fallback produced nothing: '+JSON.stringify(fb));
  console.log('builder search: proxy down → direct Apple fallback OK');

  // 4) picking a song and saving builds a usable deck
  proxyUp = true;
  await pg.fill('#sq', 'abba');
  await pg.click('button:has-text("Search")');
  await pg.waitForTimeout(600);
  await pg.evaluate(()=>{ addResult(0); });
  await pg.fill('#deckName', 'My Mixtape');
  await pg.evaluate(()=>{ S.builder.name = 'My Mixtape'; });
  const picked = await pg.evaluate(()=>S.builder.songs.length);
  if(picked !== 1) throw new Error('picking a search result did not add it: '+picked);
  console.log('builder: a found song can be added to the deck OK');

  if(errs.length) throw new Error('page errors during the run: '+errs.join(' | '));
  console.log('DECK BUILDER TEST PASS ✓');
  await browser.close(); server.close();
})().catch(e=>{ console.error('BUILDER TEST FAIL ✗', e.message); process.exit(1); });
