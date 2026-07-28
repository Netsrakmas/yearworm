// Harvest the whole catalogue's previews ONCE, from somewhere Apple answers,
// and ship the result as a static file.
//
// Why: Apple rate-limits its Search API per client IP. Players behind iCloud
// Private Relay or carrier CGNAT share an egress IP with thousands of others
// and get blocked before their first lookup. Proxying through the Cloudflare
// Worker made that WORSE, not better — Workers egress from IPs shared by every
// Cloudflare customer, and Apple answers them with:
//   429 "Rate limit has been exceeded for: itunes-apple-com|general|2a06:98c0:…"
// So no runtime path is reliable. The fix is to stop looking songs up at play
// time at all: resolve them ahead of time here, commit previews.json, and let
// the app read it. The audio itself streams from Apple's CDN, a different host
// that is NOT rate-limited this way — which is why playback keeps working even
// for the players the Search API refuses.
//
// Run:  node tools/harvest.js [--limit N] [--refresh]
// Resumable by design: existing entries are kept and skipped, so a run cut
// short by throttling can simply be run again.

const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'previews.json');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// Apple's preview and store URLs share long fixed prefixes; stripping them
// takes ~40% off the file for zero risk. The client rebuilds them.
const AUDIO_PREFIX = 'https://audio-ssl.itunes.apple.com/itunes-assets/';
const VIEW_PREFIX  = 'https://music.apple.com/';

const args = process.argv.slice(2);
const argN = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i+1]) : dflt; };
const LIMIT   = argN('--limit', Infinity);
const REFRESH = args.includes('--refresh');
// ~17 calls/min. The first run used 1.2s (≈29/min), got 725 songs through and
// was then blocked for the remaining 1458 — Apple tolerates roughly 20/min.
const PAUSE   = argN('--pause', 3500);
const GIVE_UP_AFTER = argN('--giveup', 20);   // consecutive failures = we're blocked

const sleep = ms => new Promise(r => setTimeout(r, ms));

// the app's own picking rules, lifted from index.html so this can never choose
// a different version than the game would (test/pickparity.js guards the pair)
function loadPicker(){
  const h = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const start = h.indexOf('const BADVER =');
  const end = h.indexOf('\n}', h.indexOf('function pickBest(results, song){')) + 2;
  if(start < 0 || end < 2) throw new Error('could not find the picker in index.html');
  const src = `function norm(s){ return (s||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim(); }
function yearOf(d){ const y = parseInt(String(d||"").slice(0,4),10); return y||null; }
` + h.slice(start, end) + '\nmodule.exports = { pickBest };';
  const ctx = { module: { exports: {} } };
  vm.runInNewContext(src, ctx);
  return ctx.module.exports.pickBest;
}

// ask the APP for its song list rather than re-parsing the decks here — one
// definition of "every song", and it can't drift from what the game plays
async function catalogue(){
  const server = http.createServer((req,res)=>{
    let p = decodeURIComponent(req.url.split('?')[0]); if(p==='/')p='/index.html';
    const f = path.join(ROOT,p);
    if(!f.startsWith(ROOT)||!fs.existsSync(f)){res.writeHead(404);return res.end();}
    res.writeHead(200,{'Content-Type':p.endsWith('.html')?'text/html':'application/octet-stream'});
    fs.createReadStream(f).pipe(res);
  });
  await new Promise(r=>server.listen(8123,r));
  const browser = await chromium.launch({ executablePath: CHROME });
  const pg = await (await browser.newContext({ serviceWorkers:'block' })).newPage();
  // the page must not reach the network while we only want its data
  await pg.route(/itunes\.apple\.com|workers\.dev/, r=>r.abort());
  await pg.goto('http://localhost:8123/', { waitUntil:'load' });
  await pg.waitForTimeout(400);
  const songs = await pg.evaluate(()=>{
    // include the per-song search override, which decides the lookup term
    const out = [], seen = new Set();
    for(const d of allDecks()){
      for(const s of d.songs){
        const k = norm(s.title)+"|"+norm(s.artist);
        if(seen.has(k)) continue; seen.add(k);
        out.push({ title:s.title, artist:s.artist, year:s.year, q:s.q||null });
      }
    }
    return out;
  });
  await browser.close(); server.close();
  return songs;
}

async function fetchSearch(term){
  const url = 'https://itunes.apple.com/search?media=music&entity=song&limit=10&term=' + encodeURIComponent(term);
  for(let attempt = 0; attempt < 6; attempt++){
    let r;
    try{ r = await fetch(url, { headers: { 'User-Agent': 'Yearworm-harvest/1.0 (+https://playyearworm.com)' } }); }
    catch(e){ await sleep(2000 * (attempt + 1)); continue; }
    // 403 AND 429 both mean "too much" — Apple switches to 403 once it decides
    // to shut you out, and the first run treated that as a hard error and
    // sprinted through 1458 songs achieving nothing.
    if(r.status === 429 || r.status === 403){
      const wait = Math.min(90000, 5000 * Math.pow(2, attempt));
      process.stderr.write(`  ${r.status} — backing off ${Math.round(wait/1000)}s\n`);
      await sleep(wait);
      continue;
    }
    if(!r.ok) return { error: 'HTTP ' + r.status };
    try{ return { results: (await r.json()).results || [] }; }
    catch(e){ return { error: 'bad JSON' }; }
  }
  return { error: 'rate limited after 6 attempts' };
}

(async()=>{
  const pickBest = loadPicker();
  const songs = await catalogue();
  console.log('catalogue: ' + songs.length + ' distinct songs');

  let out = {};
  if(fs.existsSync(OUT) && !REFRESH){
    try{ out = JSON.parse(fs.readFileSync(OUT, 'utf8')).songs || {}; }catch(e){ out = {}; }
    console.log('existing file: ' + Object.keys(out).length + ' resolved — resuming');
  }

  const key = s => ((s.q || (s.artist + ' ' + s.title)) || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const todo = songs.filter(s => !out[key(s)]).slice(0, LIMIT);
  console.log('to resolve: ' + todo.length + (todo.length < songs.length ? ' (rest already done)' : ''));

  let ok = 0, miss = 0, failed = 0, streak = 0;
  for(let i = 0; i < todo.length; i++){
    const s = todo[i];
    const term = s.q || (s.artist + ' ' + s.title);
    const res = await fetchSearch(term);
    if(res.error){
      failed++; streak++;
      process.stderr.write(`[${i+1}/${todo.length}] ${term} — ${res.error}\n`);
      // Once Apple shuts the door it stays shut for a while. Grinding through
      // the rest of the list gains nothing and hides how far we actually got —
      // stop, keep what we have, and let the next run resume from here.
      if(streak >= GIVE_UP_AFTER){
        console.error(`blocked: ${streak} failures in a row — stopping, ${ok} resolved this run`);
        break;
      }
      await sleep(PAUSE);
      continue;
    }
    streak = 0;
    const hit = pickBest(res.results, s);
    if(hit && hit.previewUrl){
      out[key(s)] = {
        u: hit.previewUrl.startsWith(AUDIO_PREFIX) ? hit.previewUrl.slice(AUDIO_PREFIX.length) : hit.previewUrl,
        i: hit.trackId || 0,
        v: (hit.trackViewUrl || '').startsWith(VIEW_PREFIX) ? hit.trackViewUrl.slice(VIEW_PREFIX.length) : (hit.trackViewUrl || ''),
      };
      ok++;
    } else {
      miss++;
      process.stdout.write(`[${i+1}/${todo.length}] no usable version: ${term}\n`);
    }
    if((i + 1) % 25 === 0){
      write(out);
      console.log(`[${i+1}/${todo.length}] resolved ${ok}, no-version ${miss}, failed ${failed} — saved`);
    }
    await sleep(PAUSE);
  }

  write(out);
  console.log(`done: ${Object.keys(out).length}/${songs.length} in previews.json (this run: +${ok}, ${miss} without a usable version, ${failed} failed)`);
})().catch(e=>{ console.error('HARVEST FAILED', e); process.exit(1); });

function write(songs){
  const body = { v: 1, audioPrefix: AUDIO_PREFIX, viewPrefix: VIEW_PREFIX, songs };
  fs.writeFileSync(OUT, JSON.stringify(body));
}
