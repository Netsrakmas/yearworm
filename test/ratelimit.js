// E2E: resilience when Apple's search API rate-limits (403/empty) — the case an
// iPhone behind iCloud Private Relay / carrier CGNAT hits, since the limit is
// PER EGRESS IP and thousands of devices share one.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = '/home/user/Timeline';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
function makeWav(){
  const sr=8000,n=1600,d=Buffer.alloc(n*2),h=Buffer.alloc(44);
  h.write('RIFF',0);h.writeUInt32LE(36+d.length,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);
  h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(sr,24);h.writeUInt32LE(sr*2,28);
  h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(d.length,40);
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
  await new Promise(r=>server.listen(8106,r));
  const browser = await chromium.launch({executablePath:CHROME,args:['--autoplay-policy=no-user-gesture-required']});
  const ctx = await browser.newContext({viewport:{width:540,height:1200},hasTouch:true,serviceWorkers:'block'});
  const pg = await ctx.newPage();
  pg.on('pageerror',e=>console.log('PAGEERROR:',e.message));

  let tid = 1, calls = 0, blockUntil = Infinity;   // start fully rate-limited
  await pg.route(/itunes\.apple\.com/, route=>{
    const u = new URL(route.request().url());
    const cb = u.searchParams.get('callback'), term = u.searchParams.get('term')||'x';
    calls++;
    if(calls <= blockUntil){   // emulate a 403: JSONP callback never fires
      return route.fulfill({contentType:'text/javascript', body:''});
    }
    route.fulfill({contentType:'text/javascript', body:`${cb}(${JSON.stringify({resultCount:1,results:[{trackId:++tid,trackName:term,artistName:term,collectionName:'T',releaseDate:'1999-01-01',previewUrl:'http://localhost:8106/clip.wav',trackTimeMillis:210000}]})})`});
  });
  await pg.goto('http://localhost:8106/',{waitUntil:'load'});
  await pg.waitForTimeout(600);

  // 1) every song is retried 3x with backoff before giving up
  calls = 0;
  const t0 = Date.now();
  const got = await pg.evaluate(async()=>{
    S.deck=[]; S.deckSeen=new Set();
    const added = await resolveBatch([{title:'Nope', artist:'Nobody', year:2000}]);
    return { added, deck:S.deck.length };
  });
  const elapsed = Date.now() - t0;
  if(calls !== 3) throw new Error('expected 3 attempts per song, saw '+calls);
  if(elapsed < 2000) throw new Error('retries had no backoff delay ('+elapsed+'ms)');
  if(got.added !== 0 || got.deck !== 0) throw new Error('a blocked lookup should add nothing: '+JSON.stringify(got));
  console.log('rate-limited lookup: 3 attempts with backoff ('+elapsed+'ms) OK');

  // 2) the daily dead-ends with a RETRY button, not a bare error
  await pg.evaluate(()=>{ startDaily(); });
  await pg.waitForSelector('#errbar', {state:'visible', timeout:60000});
  const errTxt = await pg.$eval('#errbar', e=>e.innerText);
  if(!/Try again/.test(errTxt)) throw new Error('no retry button on the daily failure: '+errTxt);
  if(!/lookups one network can make/.test(errTxt)) throw new Error('error copy not updated: '+errTxt);
  console.log('daily failure: honest copy + Try again button OK');

  // 3) tapping Try again while the API is healthy starts the game
  blockUntil = calls;   // API recovers from here on
  await pg.click('#errbar button');
  await pg.waitForSelector('.slot.active', {timeout:60000});
  const mode = await pg.evaluate(()=>S.mode);
  if(mode !== 'daily') throw new Error('retry did not start the daily, mode='+mode);
  console.log('Try again after recovery: daily starts OK');

  // 4) resolved previews are cached — a second resolve makes NO api call
  const before = calls;
  const cachedHit = await pg.evaluate(async()=>{
    const sg = { title:'CacheMe', artist:'Tester', year:1999 };
    S.deck=[]; S.deckSeen=new Set();
    await resolveBatch([sg]);            // one real lookup, then cached
    const cache = JSON.parse(localStorage.getItem('tl_pv')||'{}');
    const key = Object.keys(cache).find(k=>/cacheme/.test(k));
    S.deck=[]; S.deckSeen=new Set();
    const added = await resolveBatch([sg]);  // must come from cache
    return { url: key && cache[key].u, added };
  });
  const spent = calls - before;
  if(spent !== 1) throw new Error('cache did not prevent the second lookup (api calls: '+spent+')');
  if(!cachedHit.url) throw new Error('song was not written to the preview cache');
  if(cachedHit.added !== 1) throw new Error('cached resolve did not produce a card: '+cachedHit.added);
  console.log('preview cache: second resolve served from localStorage OK');

  // 5) a dead clip drops its cache entry so it is never served again
  const dropped = await pg.evaluate(()=>{
    const key = Object.keys(JSON.parse(localStorage.getItem('tl_pv')||'{}'))[0];
    const url = JSON.parse(localStorage.getItem('tl_pv'))[key].u;
    pvDrop(url);
    return Object.values(JSON.parse(localStorage.getItem('tl_pv')||'{}')).some(v=>v.u===url);
  });
  if(dropped) throw new Error('pvDrop left the stale entry in the cache');
  console.log('stale preview: dropped from the cache OK');

  // 6) THE REPORTED iPHONE CASE: direct JSONP to Apple is blocked for this
  // network (Private Relay / CGNAT share the egress IP), but our server can
  // still reach Apple. The daily must start anyway — before the lookup proxy
  // this dead-ended at "Couldn't load today's songs" every single time.
  let proxied = 0, proxyUp = true;
  await pg.route(/\/lookup$/, route=>{
    if(!proxyUp) return route.fulfill({ status:200, contentType:'application/json',
      headers:{'Access-Control-Allow-Origin':'*'}, body:JSON.stringify({ results:[], ok:false }) });
    proxied++;
    const term = (JSON.parse(route.request().postData()||'{}').term)||'x';
    route.fulfill({ status:200, contentType:'application/json', headers:{'Access-Control-Allow-Origin':'*'},
      body: JSON.stringify({ ok:true, results:[{ trackId:++tid, trackName:term, artistName:term,
        collectionName:'T', releaseDate:'1999-01-01', previewUrl:'http://localhost:8106/clip.wav', trackTimeMillis:210000 }] }) });
  });
  blockUntil = Infinity;                  // every DIRECT Apple call fails again
  await pg.evaluate(()=>{ localStorage.removeItem('tl_pv'); LB.url = 'https://api.test'; });
  const jsonpBefore = calls;
  await pg.evaluate(()=>{ store.del('tl_daily'); backToMenu(); startDaily(); });
  await pg.waitForSelector('.slot.active', {timeout:60000});
  if((await pg.evaluate(()=>S.mode)) !== 'daily') throw new Error('daily did not start through the proxy');
  if(!proxied) throw new Error('client never used the lookup proxy');
  if(calls !== jsonpBefore) throw new Error('client still hit Apple directly ('+(calls-jsonpBefore)+' calls) when the proxy answered');
  console.log('blocked network + working proxy: daily starts, zero direct Apple calls OK');

  // …and when OUR server can't reach Apple either (ok:false), the client must
  // still try direct rather than trusting an empty answer
  proxyUp = false; blockUntil = calls;     // direct works again
  const jsonpBefore2 = calls;
  await pg.evaluate(async()=>{ S.deck=[]; S.deckSeen=new Set();
    await resolveBatch([{title:'Fallback', artist:'Test', year:2001}]); });
  if(calls <= jsonpBefore2) throw new Error('client trusted ok:false instead of falling back to direct');
  console.log('proxy reports ok:false → client falls back to a direct lookup OK');

  await browser.close(); server.close();
  console.log('RATE LIMIT TEST PASS ✓');
})().catch(e=>{ console.error('RATE LIMIT TEST FAIL ✗', e.message); process.exit(1); });
