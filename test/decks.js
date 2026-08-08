// Deck integrity. Every themed deck except the meta ones is thrown away by
// `DECKS.splice(6)` and survives only as pool food, so a curated deck that
// isn't explicitly pushed back becomes invisible without any error — the whole
// point of this file is that a deck you added is actually PICKABLE.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = '/home/user/Timeline';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if(p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if(!f.startsWith(ROOT) || !fs.existsSync(f)){ res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': p.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(8131, r));
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
  const pg = await ctx.newPage();
  pg.on('pageerror', e => { throw new Error('PAGEERROR: ' + e.message); });
  await pg.route(/itunes\.apple\.com/, r => r.abort());
  await pg.goto('http://localhost:8131/', { waitUntil: 'load' });
  await pg.waitForTimeout(700);

  const d = await pg.evaluate(() => ({
    ids: DECKS.map(x => x.id),
    first: DECKS[0].id,
    sizes: Object.fromEntries(DECKS.map(x => [x.id, x.songs.length])),
    selected: S.selectedIds.slice(),
    poolHas: (() => { const p = DECKS.find(x => x.id === 'everything').songs;
      const k = s => (s.artist + '|' + s.title).toLowerCase();
      const set = new Set(p.map(k));
      return { golden: set.has('golden earring|radar love'), focus: set.has('focus|hocus pocus') }; })(),
  }));

  if(d.first !== 'top10') throw new Error('DECKS[0] must stay Top 10 Hits (it is the boot default), got ' + d.first);
  if(d.selected.join() !== 'top10') throw new Error('boot selection changed: ' + d.selected.join());
  if(!d.ids.includes('classicrock')) throw new Error('classicrock deck was spliced away — it is not pickable: ' + d.ids.join(','));
  if(d.sizes.classicrock !== 200) throw new Error('classicrock should hold 200 songs, has ' + d.sizes.classicrock);
  // the carousel spreads 7 decks as 4+3, so the first FOUR ids are page one —
  // Sam picked this page: Top 10 · Every Era · Classic Rock · Party
  if(d.ids.slice(0, 4).join() !== 'top10,everything,classicrock,party')
    throw new Error('picker page one is not the chosen four: ' + d.ids.slice(0, 4).join(','));
  console.log('decks: classicrock survives the splice, 200 songs, Top 10 still the default OK ·', d.ids.join(','));

  // its songs must ALSO reach the shared pool, or the daily can never draw them
  if(!d.poolHas.golden || !d.poolHas.focus)
    throw new Error('new deck songs missing from the pool: ' + JSON.stringify(d.poolHas));
  console.log('decks: the new songs reach the shared pool (daily can draw them) OK');

  // every deck's data must be well-formed — a bad year is a wrong ANSWER
  const bad = await pg.evaluate(() => {
    const out = [];
    for(const dk of DECKS){
      const seen = new Set();
      for(const s of dk.songs){
        if(!s || typeof s.year !== 'number' || s.year < 1950 || s.year > 2030) out.push(['year', dk.id, JSON.stringify(s)]);
        else if(!s.artist || !s.title) out.push(['blank', dk.id, JSON.stringify(s)]);
        const k = (s.artist + '|' + s.title).toLowerCase();
        if(seen.has(k)) out.push(['dupe', dk.id, k]);
        seen.add(k);
      }
    }
    return out.slice(0, 12);
  });
  if(bad.length) throw new Error('malformed deck entries: ' + JSON.stringify(bad));
  console.log('decks: every entry has a sane year, an artist, a title, and is unique within its deck OK');

  // ONE song, ONE year across the whole app — the same track dated differently
  // in two decks makes the reveal contradict itself depending on what you picked
  const clashes = await pg.evaluate(() => {
    const by = new Map(), out = [];
    for(const dk of DECKS) for(const s of dk.songs){
      const k = (s.artist + '|' + s.title).toLowerCase();
      if(by.has(k) && by.get(k) !== s.year) out.push(k + ': ' + by.get(k) + ' vs ' + s.year);
      else by.set(k, s.year);
    }
    return [...new Set(out)].slice(0, 20);
  });
  if(clashes.length) throw new Error('same song, different year: ' + JSON.stringify(clashes));
  console.log('decks: no song carries two different years OK');

  // and the deck is reachable in the UI, not just in memory. The picker lives on
  // the per-mode config screen, not the lobby — and the carousel pages by SIX,
  // so a seventh deck lands alone on page 2 and is easy to add without noticing
  // it never got a dot to scroll to.
  await pg.evaluate(() => { goTab('play'); openMode('survival'); });
  await pg.waitForTimeout(400);
  const car = await pg.$$eval('.deck-page', els => els.map(e => e.children.length));
  const dots = await pg.$$eval('.car-dot', e => e.length);
  if(car.length !== dots) throw new Error('carousel has ' + car.length + ' pages but ' + dots + ' dots');
  // every page is as tall as the fullest one, so an almost-empty last page is
  // rows of nothing — the counts must stay within one of each other
  if(Math.max(...car) - Math.min(...car) > 1) throw new Error('carousel pages unbalanced: ' + car.join('+'));
  if(car.reduce((a2, b2) => a2 + b2, 0) !== d.ids.length) throw new Error('carousel drops decks: ' + car.join('+') + ' of ' + d.ids.length);
  const chip = await pg.$('.deck[data-id="classicrock"], .dchip[data-id="classicrock"]');
  if(!chip) throw new Error('deck not offered in the lobby: ' +
    (await pg.evaluate(() => [...document.querySelectorAll('[data-id]')].map(e => e.dataset.id).join(','))));
  await chip.click();
  await pg.waitForTimeout(250);
  const picked = await pg.evaluate(() => S.selectedIds.slice());
  if(!picked.includes('classicrock')) throw new Error('tapping the deck did not select it: ' + picked.join(','));
  console.log('decks: Classic Rock 200 is offered in the lobby and selectable OK');

  // ---- challenge deck picker (Profile) ----
  // The pref narrows which songs an OUTGOING challenge draws, but the link a
  // recipient gets must stay full-pool indices — they resolve it without ever
  // knowing a deck was involved.
  await pg.evaluate(() => { closeOverlay(); goTab('profile'); });
  await pg.waitForTimeout(400);
  const chips = await pg.$$eval('#chalDeckRow [data-deck]', els => els.map(e => e.dataset.deck));
  if(chips.join() !== d.ids.join()) throw new Error('challenge-deck chips do not match the decks: ' + chips.join(','));
  const before = await pg.evaluate(() => chalDeckId());
  if(before !== 'everything') throw new Error('default challenge deck should be everything, got ' + before);
  await pg.click('#chalDeckRow [data-deck="classicrock"]');
  await pg.waitForTimeout(300);
  const after = await pg.evaluate(() => ({ id: chalDeckId(), stored: store.get('tl_chaldeck'),
    marked: document.querySelector('#chalDeckRow [data-deck="classicrock"]').textContent }));
  if(after.id !== 'classicrock' || after.stored !== 'classicrock') throw new Error('tap did not persist: ' + JSON.stringify(after));
  if(!/✓/.test(after.marked)) throw new Error('chosen deck not marked after re-render');
  const draw = await pg.evaluate(() => {
    const pool = stablePool();
    const deck = new Set(DECKS.find(x => x.id === 'classicrock').songs.map(s => norm(s.title) + '|' + norm(s.artist)));
    // three different seeds — one lucky draw proves nothing
    const bad = [];
    for(const seed of [7, 12345, 987654321]){
      for(const i of seededIdx(seed, 10, chalDeckFilter())){
        const s = pool[i];
        if(!deck.has(norm(s.title) + '|' + norm(s.artist))) bad.push(s.artist + ' - ' + s.title);
        if(i < 0 || i >= pool.length) bad.push('out-of-pool index ' + i);
      }
    }
    return bad.slice(0, 5);
  });
  if(draw.length) throw new Error('filtered draw left the chosen deck: ' + JSON.stringify(draw));
  // a stale/unknown stored id must widen to everything, never crash or narrow wrongly
  const stale = await pg.evaluate(() => { store.set('tl_chaldeck', 'deck-that-was-removed'); return chalDeckId(); });
  if(stale !== 'everything') throw new Error('unknown stored deck id should fall back to everything: ' + stale);
  // and the outgoing path is actually WIRED to the filter — capture the call
  // rather than trust the source: a refactor that drops the argument would
  // pass every check above while challenges quietly ignore the pref again
  const wired = await pg.evaluate(async () => {
    store.set('tl_chaldeck', 'classicrock');
    const real = seededIdx; let got = 'never-called';
    window.seededIdx = (seed, n, filter) => { got = typeof filter; throw new Error('probe-stop'); };
    try{ await startFreshChallenge(); }catch(e){ /* the probe aborts the run on purpose */ }
    window.seededIdx = real;
    return got;
  });
  if(wired !== 'function') throw new Error('startFreshChallenge does not pass the deck filter (got ' + wired + ')');
  console.log('decks: challenge-deck picker persists, filters the draw, wired into the run, falls back safely OK');

  // ---- turbo runs cluster by era ----
  // A turbo result can be passed on as a challenge, inheriting the run's
  // actual cards — so an unclustered turbo leaked 1964-2019 sets into
  // challenges. The working set now sorts by closeness to a random center:
  // with lookups stubbed instant, the resolved deck is the ~dozen closest
  // years, so its spread must be far below the deck's full 55-year span.
  await pg.route(/itunes\.apple\.com/, route => {
    const u = new URL(route.request().url()); const cb = u.searchParams.get('callback'); const term = u.searchParams.get('term') || 'x';
    route.fulfill({ contentType: 'text/javascript',
      body: cb + '(' + JSON.stringify({ resultCount: 1, results: [{ trackId: Math.floor(Math.random()*1e9), trackName: term,
        artistName: term, collectionName: 'T', releaseDate: '1990-01-01', previewUrl: 'data:audio/wav;base64,' }] }) + ')' });
  });
  for(let round = 0; round < 2; round++){
    await pg.evaluate(() => { store.set('tl_chaldeck', 'everything'); S.selectedIds = ['classicrock']; goTab('play'); openMode('turbo'); });
    await pg.waitForTimeout(300);
    await pg.evaluate(() => onStart());
    await pg.waitForFunction(() => S.deck.length >= 8, { timeout: 20000 });
    const spread = await pg.evaluate(() => {
      const ys = S.deck.map(c => c.year);
      return { n: ys.length, span: Math.max(...ys) - Math.min(...ys) };
    });
    if(spread.span > 34) throw new Error('turbo deck not era-clustered: ' + JSON.stringify(spread) + ' (full deck spans ~55y)');
    await pg.evaluate(() => { bgRun++; S.mode = null; backToSetup(); });
    await pg.waitForTimeout(200);
  }
  console.log('decks: turbo working set clusters around an era center OK');

  await browser.close(); server.close();
  console.log('DECKS TEST PASS ✓');
})().catch(e => { console.error('DECKS FAIL ✗', e.message); process.exit(1); });
