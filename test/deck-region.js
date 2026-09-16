// Run with: node test/deck-region.js [baseline-git-ref]
// Runs the real app and renderers without network or browser dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, webcrypto } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const noop = () => {};

function game(options = {}, source = html) {
  const data = options.data || new Map(Object.entries(options.entries || {}));
  const nodes = new Map();
  function node() {
    return { innerHTML: '', textContent: '', style: {}, dataset: {},
      classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      addEventListener: noop, setAttribute: noop, removeAttribute: noop,
      querySelector: () => null, querySelectorAll: () => [], closest: () => null,
      focus: noop, pause: noop, load: noop, play: async () => {}, appendChild: noop };
  }
  const navigator = options.navigator === undefined
    ? { languages: ['en-US'], language: 'en-US', userAgent: 'Yearworm test', onLine: true }
    : options.navigator;
  const context = vm.createContext({
    navigator, crypto: webcrypto, console, URL, URLSearchParams,
    location: { hash: options.hash || '', pathname: '/', origin: 'http://localhost' },
    history: { replaceState: noop },
    localStorage: {
      getItem(k) { if(options.blockStorage) throw Error('blocked'); return data.get(k) ?? null; },
      setItem(k, v) { if(options.blockStorage) throw Error('blocked'); data.set(k, String(v)); },
      removeItem(k) { if(options.blockStorage) throw Error('blocked'); data.delete(k); },
    },
    document: { addEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
      createElement: node, body: node(), head: node(), documentElement: node(),
      getElementById(id) { if(!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); } },
    addEventListener: noop, scrollTo: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
    fetch: options.fetch || (async () => ({ ok: false, status: 503, json: async () => ({}) })),
  });
  context.window = context;
  const script = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .find(m => m[1].includes('const BUILD ='))[1];
  assert.match(script, /\nboot\(\);\s*$/);
  vm.runInContext(script.replace(/\nboot\(\);\s*$/, ''), context);
  // Keep actual boot, state, song selection and UI. Disable external refreshes.
  vm.runInContext('afterLobby = () => {}; ' + (options.analytics ? '' : 'beacon = () => {}; ') + 'boot();', context);
  return { data, nodes,
    run: code => vm.runInContext(code, context),
    json: code => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context)) };
}

let passed = 0;
function test(name, fn) {
  try { fn(); } catch(error) { console.error(`FAIL ${name}`); throw error; }
  console.log(`PASS ${name}`); passed++;
}
function pickerIds(g) {
  return [...g.run('deckCarouselHTML()').matchAll(/data-id="([^"]+)"/g)].map(m => m[1]);
}
function profileIds(g) {
  return [...g.run('profileTabHTML()').matchAll(/data-deck="([^"]+)"/g)].map(m => m[1]);
}
function sharedSongs(g) {
  return g.json(`({ pool: stablePool(),
    draws: Array.from({length: 84}, (_, i) => {
      dailyNumber = () => i + 1;
      return dailySongs(10);
    }),
    links: [0, 10, 100, 999, stablePool().length - 1].map(i => stablePool()[i]) })`);
}
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

module.exports = { game };
if (require.main === module) {
test('Dutch primary or secondary language shows the deck and selects it at boot', () => {
  for (const languages of [['nl'], ['nl-NL'], ['nl-BE'], ['en-US', 'nl-NL'], ['NL-nl']]) {
    const g = game({ navigator: { languages, language: languages[0] } });
    assert.deepEqual(g.json('S.selectedIds'), ['top10']);
    assert.equal(pickerIds(g)[0], 'top10');
    assert.match(g.run('deckCarouselHTML()'), /Dutch Top 10 Hits/);
    assert.deepEqual(profileIds(g), pickerIds(g));
  }
});
test('international and missing languages use Every Era and six visible decks', () => {
  for (const navigator of [{ languages: ['en-US', 'de-DE'] }, {},
    { languages: [], language: 'en-GB' }, { languages: ['en-NL', 'nld'] }]) {
    const g = game({ navigator });
    assert.deepEqual(g.json('S.selectedIds'), ['everything']);
    assert.equal(pickerIds(g).length, 6);
    assert.equal(pickerIds(g)[0], 'everything');
    assert.equal(pickerIds(g).includes('top10'), false);
    assert.deepEqual(profileIds(g), pickerIds(g));
  }
});
test('navigator.language is used when the language list is missing or empty', () => {
  for (const navigator of [{ language: 'nl-NL' }, { languages: [], language: 'nl-BE' }]) {
    assert.deepEqual(game({ navigator }).json('S.selectedIds'), ['top10']);
  }
});
test('manual Show persists across reload and overrides an English browser', () => {
  const g = game(); g.run('setDutchDeckPreference("show")');
  assert.equal(g.data.get('tl_dutchdeck'), 'show');
  assert.deepEqual(g.json('S.selectedIds'), ['top10']);
  assert(pickerIds(g).includes('top10'));
  const reload = game({ data: g.data });
  assert.deepEqual(reload.json('S.selectedIds'), ['top10']);
  assert.match(reload.run('regionalDeckPreferenceHTML()'), /value="show" selected/);
});
test('manual Hide persists and overrides a Dutch browser', () => {
  const navigator = { languages: ['nl-NL'] };
  const g = game({ navigator }); g.run('setDutchDeckPreference("hide")');
  assert.equal(g.data.get('tl_dutchdeck'), 'hide');
  assert.deepEqual(g.json('S.selectedIds'), ['everything']);
  assert.equal(pickerIds(g).includes('top10'), false);
  const reload = game({ navigator, data: g.data });
  assert.deepEqual(reload.json('S.selectedIds'), ['everything']);
});
test('Automatic clears the saved override and follows languages again', () => {
  const g = game({ navigator: { languages: ['en-US', 'nl'] }, entries: { tl_dutchdeck: 'hide' } });
  g.run('setDutchDeckPreference("auto")');
  assert.equal(g.data.has('tl_dutchdeck'), false);
  assert.deepEqual(g.json('S.selectedIds'), ['top10']);
});
test('invalid preferences fall back safely; blocked storage still allows a session choice', () => {
  const corrupt = game({ entries: { tl_dutchdeck: 'garbage' } });
  assert.deepEqual(corrupt.json('S.selectedIds'), ['everything']);
  corrupt.run('setDutchDeckPreference("garbage")');
  assert.equal(corrupt.run('dutchDeckPreference()'), 'auto');
  const blocked = game({ blockStorage: true });
  blocked.run('setDutchDeckPreference("show")');
  assert.equal(blocked.run('dutchDeckVisible()'), true);
  assert.deepEqual(blocked.json('S.selectedIds'), ['top10']);
});
test('hiding the Dutch deck preserves other selected and custom decks', () => {
  const g = game({ entries: { tl_dutchdeck: 'show' } });
  g.run('S.selectedIds = ["top10", "classicrock", "my-custom"]; setDutchDeckPreference("hide")');
  assert.deepEqual(g.json('S.selectedIds'), ['classicrock', 'my-custom']);
  g.run('S.selectedIds = ["classicrock"]; setDutchDeckPreference("show")');
  assert.deepEqual(g.json('S.selectedIds'), ['classicrock']);
});
test('all three mode setups expose the full deck grid and regional override', () => {
  for (const pref of ['show', 'hide']) {
    const g = game({ entries: { tl_dutchdeck: pref } });
    for (const mode of ['survival', 'turbo', 'passplay']) {
      g.run(`openMode(${JSON.stringify(mode)})`);
      const screen = g.nodes.get('app').innerHTML;
      assert.match(screen, /<summary>Regional decks<\/summary>/);
      assert.match(screen, /onchange="setDutchDeckPreference\(this.value\)"/);
      assert.equal(screen.includes('data-id="top10"'), pref === 'show');
      assert.match(screen, /<section id="modeDeckPicker"/);
      assert.doesNotMatch(screen, /<details[^>]*id="modeDeckPicker"/);
    }
    const grid = g.run('deckCarouselHTML()');
    assert.equal([...grid.matchAll(/data-id=/g)].length, pref === 'show' ? 7 : 6);
    assert.doesNotMatch(grid, /deck-page|hidden/);
  }
});
test('hidden outgoing challenge preference falls back to Every Era and can be restored', () => {
  const g = game({ entries: { tl_chaldeck: 'top10' } });
  assert.equal(g.run('chalDeckId()'), 'everything');
  assert.equal(g.run('chalDeckFilter()'), null);
  g.run('setDutchDeckPreference("show")');
  assert.equal(g.run('chalDeckId()'), 'top10');
  assert.equal(g.run('typeof chalDeckFilter()'), 'function');
  assert(profileIds(g).includes('top10'));
});
test('saved Dutch games keep their original songs; a new mode uses visible decks', () => {
  const g = game({ entries: { tl_game: JSON.stringify({ mode: 'survival', lives: 2,
    sel: ['top10'], players: [{ name: 'Player', timeline: [] }], deck: [], used: [] }) } });
  g.run('let resumedSongs; loadRest = songs => { resumedSongs = songs; }; unlockAudio = () => {}; renderGame = () => {}; resumeSaved();');
  assert.deepEqual(g.json('S.selectedIds'), ['top10']);
  assert.equal(g.run('resumedSongs.length'), g.run('TOP10_SONGS.length'));
  g.run('openMode("survival")');
  assert.deepEqual(g.json('S.selectedIds'), ['everything']);
});
test('Every Era, 84 Daily draws and shared link indices are identical across preferences', () => {
  const expected = digest(sharedSongs(game()));
  for (const options of [{ navigator: { languages: ['nl-NL'] } },
    { entries: { tl_dutchdeck: 'show' } }, { entries: { tl_dutchdeck: 'hide' } }]) {
    assert.equal(digest(sharedSongs(game(options))), expected);
  }
});
if (process.argv[2]) {
  test('shared songs and Daily draws match the release before this change', () => {
    const baseline = execFileSync('git', ['-c', `safe.directory=${root.replace(/\\/g, '/')}`,
      'show', `${process.argv[2]}:index.html`], { cwd: root, encoding: 'utf8', maxBuffer: 4e6 });
    assert.equal(digest(sharedSongs(game())), digest(sharedSongs(game({}, baseline))));
  });
}
console.log(`DECK REGION REGRESSION: ${passed} tests passed`);
}
