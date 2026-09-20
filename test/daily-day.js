// Run with Node 22+: node test/daily-day.js
// Real client functions/renderers and Worker SQL, with clocks near midnight.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const { game } = require('./deck-region');

function at(g, time) { g.run(`testNow = ${Date.parse(time)}`); }
function client(time, options = {}) {
  const g = game(options);
  g.run(`let testNow; Date = class extends Date {
    constructor(...args) { super(...(args.length ? args : [testNow])); }
    static now() { return testNow; }
  }`);
  at(g, time);
  return g;
}
function progress(g, tries = 5, score = 4) {
  g.run(`S.players = [{tries:${tries}, hits:${score}, timeMs:20000,
    results:Array.from({length:${tries}}, (_,i)=>i<${score})}]; recordRunProgress()`);
}
function begin(g) { g.run('S.mode="daily"; S.dailyNum=dailyNumber()'); }
let passed = 0, failed = 0;
async function test(name, fn) {
  process.env.TZ = 'Europe/Amsterdam';
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch(e) { failed++; console.error(`FAIL ${name}\n${e.stack}`); }
}

(async () => {
  const originalTZ = process.env.TZ;
  const originalNow = Date.now;
  try {
    process.env.TZ = 'Europe/Amsterdam';
    await test('00:30 Netherlands result does not mark the next puzzle Done at 21:49', () => {
      const g = client('2026-09-19T00:30:00+02:00');
      assert.equal(g.run('localDay(0)'), '2026-09-19');
      assert.equal(g.run('dailyNumber()'), 80);
      begin(g); progress(g);
      assert.equal(g.run('dailyPlayedToday()'), true);
      at(g, '2026-09-19T21:49:00+02:00');
      assert.equal(g.run('dailyNumber()'), 81);
      assert.equal(g.run('dailyPlayedToday()'), false);
      const home = g.run('homeHTML()');
      assert.match(home, /#81/);
      assert.doesNotMatch(home, /Done ·/);
      assert.match(home, /onclick="startDaily\(\)"/);
      assert.equal(g.run('loadDaily().num'), 80);
      assert.equal(g.run('loadDaily().score'), 4);
      const reload = client('2026-09-19T21:49:00+02:00', {data:g.data});
      assert.equal(reload.run('dailyPlayedToday()'), false);
    });

    await test('two consecutive puzzles on the same local date both save and extend the streak', () => {
      const g = client('2026-09-19T00:30:00+02:00');
      begin(g); progress(g);
      at(g, '2026-09-19T21:49:00+02:00');
      begin(g); progress(g, 1, 1);
      assert.equal(g.run('loadDaily().num'), 81);
      assert.equal(g.run('loadDaily().p'), 1);
      assert.equal(g.run('loadDaily().streak'), 2);
      progress(g, 5, 3);
      assert.equal(g.run('loadDaily().score'), 3);
      assert.equal(g.run('loadDaily().p'), undefined);
      assert.equal(g.run('loadDaily().streak'), 2);
      assert.equal(g.run('loadDaily().maxStreak'), 2);
    });

    await test('crossing local midnight during one puzzle does not increment the streak twice', () => {
      const g = client('2026-09-18T23:59:00+02:00');
      begin(g); progress(g, 1, 1);
      at(g, '2026-09-19T00:01:00+02:00');
      progress(g);
      assert.equal(g.run('loadDaily().num'), 80);
      assert.equal(g.run('loadDaily().streak'), 1);
      assert.equal(g.run('loadDaily().p'), undefined);
    });

    await test('crossing UTC midnight keeps the result on its starting puzzle and unlocks the next', () => {
      const g = client('2026-09-19T01:59:00+02:00');
      begin(g); progress(g, 1, 1);
      at(g, '2026-09-19T02:01:00+02:00');
      progress(g);
      assert.equal(g.run('loadDaily().num'), 80);
      assert.equal(g.run('dailyPlayedToday()'), false);
      assert.equal(g.run('loadDaily().streak'), 1);
    });

    await test('partial attempts stay locked, and finished results cannot be downgraded after local midnight', () => {
      const g = client('2026-09-18T23:59:00+02:00');
      begin(g); progress(g, 1, 1);
      assert.equal(g.run('dailyPlayedToday()'), true);
      progress(g);
      at(g, '2026-09-19T00:01:00+02:00');
      progress(g, 1, 0);
      assert.equal(g.run('dailyPlayedToday()'), true);
      assert.equal(g.run('loadDaily().score'), 4);
      assert.equal(g.run('loadDaily().p'), undefined);
    });

    await test('skipping a UTC puzzle resets the streak even on consecutive local dates', () => {
      const g = client('2026-09-18T00:30:00+02:00');
      begin(g); progress(g);
      at(g, '2026-09-19T21:49:00+02:00');
      begin(g); progress(g);
      assert.equal(g.run('loadDaily().streak'), 1);
    });

    await test('a local-date-only record cannot claim a numbered puzzle', () => {
      const g = client('2026-09-19T21:49:00+02:00');
      g.run('saveDaily({last:localDay(0), score:4})');
      assert.equal(g.run('dailyPlayedToday()'), false);
    });

    await test('UTC rollover works west of UTC, during winter, and through DST changes', () => {
      for(const [zone, before, after] of [
        ['America/Los_Angeles', '2026-09-19T16:59:00-07:00', '2026-09-19T17:01:00-07:00'],
        ['Europe/Amsterdam', '2026-12-19T00:59:00+01:00', '2026-12-19T01:01:00+01:00'],
        ['Europe/Amsterdam', '2026-10-25T01:59:00+02:00', '2026-10-25T02:01:00+02:00'],
        ['Europe/Amsterdam', '2027-03-28T00:59:00+01:00', '2027-03-28T01:01:00+01:00'],
      ]) {
        process.env.TZ = zone;
        const g = client(before); begin(g); progress(g);
        at(g, after);
        assert.equal(g.run('dailyPlayedToday()'), false, zone + ' ' + after);
        begin(g); progress(g);
        assert.equal(g.run('loadDaily().streak'), 2);
      }
      process.env.TZ = 'America/Los_Angeles';
      const g = client('2026-09-19T23:59:00-07:00'); begin(g); progress(g);
      at(g, '2026-09-20T00:01:00-07:00');
      assert.equal(g.run('dailyPlayedToday()'), true, 'local midnight cannot unlock a replay');
      process.env.TZ = 'Europe/Amsterdam';
      for(const [before, after] of [
        ['2026-10-25T02:59:00+02:00', '2026-10-25T02:01:00+01:00'],
        ['2027-03-28T01:59:00+01:00', '2027-03-28T03:01:00+02:00'],
      ]) {
        const dst = client(before); begin(dst); progress(dst);
        at(dst, after);
        assert.equal(dst.run('dailyPlayedToday()'), true, 'DST cannot unlock a replay');
      }
    });

    await test('starting across midnight pins the songs and theme to the original puzzle', async () => {
      const g = client('2026-09-23T01:59:59+02:00');
      const day = g.run('dailyNumber()');
      const songs = g.json('dailySongs(10)');
      const theme = g.run('weekTheme(dailyNumber()).key');
      g.run(`stashRoster=()=>{testNow+=2000};
        unlockAudio=()=>{}; renderLoading=()=>{}; startGame=()=>{}; loadRest=()=>{};
        let selectedTestSongs;
        resolveInitial=async songs=>{selectedTestSongs=songs; S.deck=[{},{}]; return songs.length}`);
      await g.run('startDaily()');
      assert.equal(g.run('S.dailyNum'), day);
      assert.notEqual(g.run('weekTheme(dailyNumber()).key'), theme);
      assert.deepEqual(g.json('selectedTestSongs'), songs);
      assert.deepEqual(g.json(`dailySongs(10, ${day})`), songs);
      assert.notDeepEqual(g.json('dailySongs(10)'), songs);
    });

    await test('client submits and reads the matching Worker board across midnight; first score stands', async () => {
      const db = new DatabaseSync(':memory:');
      db.exec(fs.readFileSync(path.join(__dirname, '../server/schema.sql'), 'utf8'));
      const DB = {prepare(sql) {
        const st = db.prepare(sql); let args = [];
        const params = () => args.length ? [Object.fromEntries(args.map((v,i)=>[i+1,v]))] : [];
        const api = {bind(...values) { args = values; return api; },
          first: () => st.get(...params()) || null,
          all: () => ({results:st.all(...params())}),
          run: () => st.run(...params())};
        return api;
      }};
      const worker = (await import(pathToFileURL(path.join(__dirname, '../server/worker.js')).href)).default;
      let serverNow = Date.parse('2026-09-18T22:30:00Z');
      Date.now = () => serverNow;
      const requests = [];
      const g = client('2026-09-19T00:30:00+02:00', {fetch:async (url, init) => {
        assert.equal(new URL(url).pathname, '/daily');
        assert.equal(new URL(url).search, '', 'credentials must stay out of URLs');
        requests.push(JSON.parse(init.body));
        return worker.fetch(new Request(url, init), {DB});
      }});
      try {
        begin(g); progress(g);
        const submit = await g.run('lbSubmitDaily(4, 20000, S.dailyNum)');
        assert.equal(submit.day, 80); assert.equal(submit.me.score, 4);
        // The response can arrive after the server rolls over: reads must name the puzzle.
        serverNow = Date.parse('2026-09-19T00:00:01Z');
        const previous = await g.run('lbFetchDaily()');
        assert.equal(requests.at(-1).day, 80);
        assert.equal(previous.day, 80); assert.equal(previous.me.score, 4);
        at(g, '2026-09-19T21:49:00+02:00');
        serverNow = Date.parse('2026-09-19T19:49:00Z');
        const today = await g.run('lbFetchDaily()');
        assert.equal(today.day, 81); assert.equal(today.me, null);
        assert.equal(g.run('dailyPlayedToday()'), false);
        begin(g); progress(g, 5, 3);
        const next = await g.run('lbSubmitDaily(3, 20000, S.dailyNum)');
        assert.equal(next.day, 81); assert.equal(next.me.score, 3);
        const duplicate = await g.run('lbSubmitDaily(5, 500, S.dailyNum)');
        assert.equal(duplicate.me.score, 3);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scores').get().n, 2);
      } finally { Date.now = originalNow; db.close(); }
    });

    await test('rename refreshes a finished puzzle after local midnight, without submitting partial runs', async () => {
      const requests = [];
      const g = client('2026-09-18T23:59:00+02:00', {fetch:async (url, init) => {
        requests.push(JSON.parse(init.body)); return {ok:false};
      }});
      g.run('claimHandle=()=>{}; renameOnServer=()=>{}');
      begin(g); progress(g, 1, 1);
      g.run('saveNick("New name")');
      assert.equal(requests.length, 0);
      progress(g);
      at(g, '2026-09-19T00:01:00+02:00');
      g.run('saveNick("Updated name")');
      assert.equal(requests.length, 1);
      assert.equal(requests[0].day, 80);
      assert.equal(requests[0].score, 4);
      at(g, '2026-09-19T21:49:00+02:00');
      g.run('saveNick("Another name")');
      assert.equal(requests.length, 1, 'yesterday must not be submitted as today');
    });
  } finally {
    Date.now = originalNow;
    if(originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ;
  }
  console.log(`DAILY DAY REGRESSION: ${passed} passed, ${failed} failed`);
  if(failed) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
