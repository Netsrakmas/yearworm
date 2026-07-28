// Regression test: after merging the handoff into the reveal button, the next
// clip must KEEP PLAYING when the reveal button is tapped (bug: unlockAudio's
// deferred pause() used to silence every track after the first).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = '/home/user/Timeline';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const MIME = { '.html':'text/html', '.json':'application/manifest+json', '.js':'text/javascript', '.png':'image/png', '.wav':'audio/wav' };

// tiny valid WAV: 8kHz 16-bit mono, 0.4s of a soft square wave (audible, loopable)
function makeWav(){
  const sr = 8000, n = Math.floor(sr*0.4);
  const data = Buffer.alloc(n*2);
  for(let i=0;i<n;i++) data.writeInt16LE((Math.floor(i/40)%2) ? 4000 : -4000, i*2);
  const h = Buffer.alloc(44);
  h.write('RIFF',0); h.writeUInt32LE(36+data.length,4); h.write('WAVEfmt ',8);
  h.writeUInt32LE(16,16); h.writeUInt16LE(1,20); h.writeUInt16LE(1,22);
  h.writeUInt32LE(sr,24); h.writeUInt32LE(sr*2,28); h.writeUInt16LE(2,32); h.writeUInt16LE(16,34);
  h.write('data',36); h.writeUInt32LE(data.length,40);
  return Buffer.concat([h,data]);
}
const WAV = makeWav();

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p === '/clip.wav') { res.writeHead(200, {'Content-Type':'audio/wav','Access-Control-Allow-Origin':'*'}); return res.end(WAV); }
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, {'Content-Type': MIME[path.extname(f)] || 'application/octet-stream'});
  fs.createReadStream(f).pipe(res);
});

let trackId = 1000;
(async () => {
  await new Promise(r => server.listen(8094, r));
  const base = 'http://localhost:8094/';
  const browser = await chromium.launch({ executablePath: CHROME, args:['--autoplay-policy=no-user-gesture-required'] });
  // block the service worker: SW-mediated fetches bypass page.route, which would
  // send the JSONP lookups to the real (blocked) network and starve the deck
  const page = await (await browser.newContext({ viewport:{width:540,height:960}, hasTouch:true, serviceWorkers:'block' })).newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));

  // stub the iTunes JSONP: echo the search term back so pickBest always matches
  // previews.json now ships in the repo and every test server serves ROOT.
  // These suites exercise the LOOKUP path, so hide it — otherwise songs
  // resolve from the static file and point at a CDN this test doesn't stub.
  await page.route(/previews\.json/, r=>r.fulfill({status:404, body:''}));
  await page.route(/itunes\.apple\.com/, route => {
    const u = new URL(route.request().url());
    const cb = u.searchParams.get('callback');
    const term = u.searchParams.get('term') || 'x';
    const results = [{ trackId: ++trackId, trackName: term, artistName: term,
      collectionName: 'Test', releaseDate: '1999-01-01', previewUrl: base + 'clip.wav' }];
    route.fulfill({ contentType:'text/javascript', body: `${cb}(${JSON.stringify({resultCount:1, results})})` });
  });

  const audioState = () => page.evaluate(() => {
    const a = document.getElementById('aud');
    return a ? { paused: a.paused, src: a.currentSrc } : null;
  });
  const turnName = () => page.$eval('.turn-name', e => e.textContent).catch(()=>null);

  await page.goto(base, { waitUntil:'load' });
  await page.waitForTimeout(800);

  // default is two players now — just start
  await page.click('.modecard:has-text("Pass & Play")');
  await page.click('text=▶ Start game');

  // wait for the first clip to actually play
  await page.waitForFunction(() => { const a = document.getElementById('aud'); return a && !a.paused && a.currentSrc.includes('clip.wav'); }, null, { timeout: 25000 });
  const p1 = await turnName();
  console.log('turn 1:', p1, '| audio:', JSON.stringify(await audioState()));

  // regression guard: the in-game header (.topbar) must NOT be fixed-positioned.
  // A nickchip CSS class collision once pinned it top-right, wrecking the header.
  const barPos = await page.$eval('.topbar', e => getComputedStyle(e).position);
  const barW = await page.$eval('.topbar', e => Math.round(e.getBoundingClientRect().width));
  if (barPos === 'fixed' || barW < 300) { console.error('FAIL: in-game header is misplaced (position:'+barPos+', width:'+barW+') — .topbar collision'); process.exit(1); }
  console.log('in-game header layout OK (position:'+barPos+', width:'+barW+')');

  // next turn's clip pre-buffers in the hidden #pre element while we think
  // (may arrive a beat later while the background loader fills the deck)
  await page.waitForFunction(() => S.nextPick && document.getElementById('pre').src === S.nextPick.previewUrl,
    null, { timeout: 15000 }).catch(() => { console.error('FAIL: next clip never primed'); process.exit(1); });
  console.log('next clip primed in the preloader OK');

  for (let round = 1; round <= 3; round++) {
    const expected = await page.evaluate(() => S.nextPick && S.nextPick.id);
    await page.click('.slot.active');                          // place the card
    await page.waitForSelector('#overlay.show', { timeout: 5000 });
    const btn = await page.$eval('#sheet .btn.primary', e => e.textContent);
    await page.click('#sheet .btn.primary');                   // the merged pass/advance tap
    await page.waitForTimeout(900);                            // old bug paused audio within ~50ms
    const st = await audioState();
    const tn = await turnName();
    const overlayOpen = await page.$eval('#overlay', e => e.classList.contains('show'));
    console.log(`round ${round}: btn="${btn.trim()}" → turn:"${tn}" playing:${!st.paused} overlay:${overlayOpen?'OPEN':'closed'}`);
    if (st.paused) { console.error('FAIL: audio paused after advance (regression!)'); process.exit(1); }
    if (round === 1 && !/Pass to/.test(btn)) { console.error('FAIL: reveal button does not name next player'); process.exit(1); }
    const nowId = await page.evaluate(() => S.current && S.current.id);
    if (expected && nowId !== expected) { console.error('FAIL: primed card was not the one played ('+expected+' vs '+nowId+')'); process.exit(1); }
  }
  console.log('primed card is the card that plays next OK');
  console.log('page errors:', errs.length ? errs : 'none');
  console.log('PASS ✓ — audio keeps playing across turn handoffs');
  await browser.close(); server.close();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
