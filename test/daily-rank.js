// Run with: node test/daily-rank.js
// Executes the real app's storage and achievement functions with in-memory storage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const from = html.indexOf('function loadDaily()');
const to = html.indexOf('function dailyPlayedToday()', from);
assert(from >= 0 && to > from, 'Daily storage functions must exist');
const storageCode = html.slice(from, to);
function declaration(name) {
  const start = html.indexOf(`function ${name}(`);
  const end = html.indexOf('\n}', start);
  assert(start >= 0 && end > start, `${name} must exist`);
  return html.slice(start, end + 2);
}
const appCode = storageCode + '\n' + declaration('achievementsList') + '\n' + declaration('checkAchievements');
function game(entries = {}, shared) {
  const data = shared || new Map(Object.entries(entries));
  const context = vm.createContext({
    store: { get: k => data.get(k) ?? null, set: (k, v) => data.set(k, v) },
    loadBest: () => ({}), loadLife: () => ({}), _social: { friends: [] },
    RUN_LEN: 5, ACH_SEEN: 'tl_achseen', _achT: [],
    setTimeout: () => 1, achPop: () => {},
  });
  vm.runInContext(appCode, context);
  return { data, run: code => vm.runInContext(code, context) };
}
function withDaily(d, seen) {
  const entries = { tl_daily: JSON.stringify(d) };
  if (seen !== undefined) entries.tl_achseen = JSON.stringify(seen);
  return game(entries);
}
let passed = 0;
function test(name, fn) {
  try { fn(); } catch (error) { console.error(`FAIL ${name}`); throw error; }
  passed++; console.log(`PASS ${name}`);
}
function badge(g, name) { return g.run(`achievementsList().find(a => a.name === ${JSON.stringify(name)}).done`); }

test('next Daily preserves World Beater and Champion', () => {
  const g = withDaily({ bestRank: 1, last: '2026-09-06', score: 5 });
  g.run('saveDaily({last:"2026-09-07", score:0, p:1})');
  assert.equal(g.run('loadDaily().bestRank'), 1);
  assert.equal(badge(g, 'World Beater'), true);
  assert.equal(badge(g, 'Champion'), true);
});
test('a worse rank cannot replace a previous #1', () => {
  const g = withDaily({ bestRank: 1 });
  g.run('saveDaily({bestRank:4, score:3})');
  assert.equal(g.run('loadDaily().bestRank'), 1);
});
test('top-10 rank survives later non-top-10 results', () => {
  const g = withDaily({ bestRank: 7 });
  g.run('saveDaily({score:0, p:1}); saveDaily({bestRank:25, score:2})');
  assert.equal(g.run('loadDaily().bestRank'), 7);
  assert.equal(badge(g, 'Champion'), true);
  assert.equal(badge(g, 'World Beater'), false);
});
test('a better result still improves the best rank', () => {
  const g = withDaily({ bestRank: 7 });
  g.run('saveDaily({bestRank:3}); saveDaily({bestRank:1})');
  assert.equal(g.run('loadDaily().bestRank'), 1);
});
test('full completion clears the partial flag and old run fields', () => {
  const g = withDaily({ bestRank: 1, p:1, results:[false], idx:[1,2], last:'yesterday' });
  g.run('saveDaily({score:5, results:[true], last:"today"})');
  const d = JSON.parse(g.data.get('tl_daily'));
  assert.equal(d.bestRank, 1); assert.equal(d.score, 5); assert.equal(d.last, 'today');
  assert.equal('p' in d, false); assert.equal('idx' in d, false);
  assert.deepEqual(d.results, [true]);
});
test('saving does not mutate the caller object', () => {
  const g = withDaily({bestRank:1});
  assert.equal(g.run('const input={score:2}; saveDaily(input); "bestRank" in input'), false);
});
test('reload retains best rank', () => {
  const g = withDaily({bestRank:1}); g.run('saveDaily({score:2})');
  const reopened = game({}, g.data);
  assert.equal(reopened.run('loadDaily().bestRank'), 1);
});
test('stale snapshots cannot downgrade a newly saved best rank', () => {
  const g = withDaily({bestRank:8});
  g.run('const stale=loadDaily(); saveDaily({bestRank:1}); saveDaily(stale)');
  assert.equal(g.run('loadDaily().bestRank'), 1);
});
test('old World Beater unlock restores an already-lost #1', () => {
  const g = withDaily({bestRank:23, score:2}, ['Champion', 'World Beater']);
  assert.equal(g.run('loadDaily().bestRank'), 1);
  assert.equal(badge(g, 'World Beater'), true);
  g.run('saveDaily({score:0, p:1})');
  assert.equal(JSON.parse(g.data.get('tl_daily')).bestRank, 1);
});
test('World Beater can recover when the Daily record is missing', () => {
  const g = game({tl_achseen:JSON.stringify(['World Beater'])});
  assert.equal(g.run('loadDaily().bestRank'), 1);
});
test('new players and Champion-only history are not granted #1', () => {
  for (const seen of [[], ['Champion']]) {
    const g = withDaily({}, seen); g.run('saveDaily({score:3})');
    assert.equal(g.run('loadDaily().bestRank'), undefined);
    assert.equal(badge(g, 'World Beater'), false);
  }
});
test('invalid ranks do not unlock badges or overwrite a valid rank', () => {
  for (const rank of ['0','-1','1.5','"1"','null','undefined','NaN','Infinity']) {
    const g = withDaily({bestRank:7}); g.run(`saveDaily({bestRank:${rank}})`);
    assert.equal(g.run('loadDaily().bestRank'), 7);
    const fresh = game(); fresh.run(`saveDaily({bestRank:${rank}})`);
    assert.equal(fresh.run('loadDaily().bestRank'), undefined);
  }
});
test('corrupt stored data is tolerated without fabricated awards', () => {
  for (const raw of ['{', 'null', '[]', '5', '"text"']) {
    const g = game({tl_daily:raw, tl_achseen:'{'});
    g.run('saveDaily({score:2})');
    assert.equal(g.run('loadDaily().score'), 2);
    assert.equal(g.run('loadDaily().bestRank'), undefined);
  }
});
test('unlock checks keep existing achievement history', () => {
  const g = withDaily({bestRank:1}, ['Previously Earned']);
  g.run('checkAchievements()');
  const seen = JSON.parse(g.data.get('tl_achseen'));
  for (const name of ['Previously Earned', 'Champion', 'World Beater']) assert(seen.includes(name));
  g.run('checkAchievements()');
  assert.deepEqual(JSON.parse(g.data.get('tl_achseen')), seen);
});
test('all inline scripts and service worker parse; release versions match', () => {
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (m[1].trim()) new vm.Script(m[1]);
  }
  new vm.Script(sw);
  const build = html.match(/const BUILD = "([^"]+)"/)[1];
  const cache = sw.match(/const CACHE_NAME = 'yearworm-([^']+)'/)[1];
  assert.equal(build, cache);
});
console.log(`DAILY RANK REGRESSION: ${passed} tests passed`);
