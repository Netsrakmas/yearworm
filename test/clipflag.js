// A preview can be unguessable without being WRONG: a long instrumental intro,
// a 12" mix that previews its build-up, an upload with the vocal stripped out.
// pickBest reads track and album TEXT, so it is structurally blind to all of
// it — players are the only sensor. This covers the vote → retire path.
const fs = require('fs');
const Database = require('better-sqlite3');
const ROOT = '/home/user/Timeline';

(async () => {
  const sqlite = new Database(':memory:');
  let schema = fs.readFileSync(ROOT + '/server/schema.sql', 'utf8');
  schema = schema.replace(/^\s*--.*$/gm, '').replace(/CREATE INDEX[\s\S]*?;/gi, '');
  sqlite.exec(schema);
  const P = a => a.length ? [Object.fromEntries(a.map((v, i) => [i + 1, v === undefined ? null : v]))] : [];
  const DB = { prepare(sql){ const st = sqlite.prepare(sql); let a = []; const api = {
    bind(...x){ a = x; return api; },
    first(){ const r = st.get(...P(a)); return r === undefined ? null : r; },
    all(){ return { results: st.all(...P(a)) }; },
    run(){ const i = st.run(...P(a)); return { meta: { changes: i.changes } }; } }; return api; } };

  globalThis.fetch = async () => { throw new Error('this test must not reach the network'); };
  const worker = (await import(ROOT + '/server/worker.js')).default;
  const ctx = { waitUntil: () => {} };
  const env = { DB, GOOGLE_CLIENT_ID: '' };

  let ip = 0;
  const flag = async (device, track) => {
    // a fresh IP per call: the worker's rate limiter is per-IP and in-memory
    const r = await worker.fetch(new Request('https://x/flagclip', { method: 'POST',
      headers: { 'content-type': 'application/json', 'Origin': 'https://playyearworm.com',
                 'CF-Connecting-IP': '5.5.' + (++ip) + '.1' },
      body: JSON.stringify({ device, track }) }), env, ctx);
    return { status: r.status, body: await r.json() };
  };
  const TRACK = 1706916906;
  const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32);
  const isDead = id => !!sqlite.prepare('SELECT 1 FROM dead_ids WHERE track_id=?').get(id);

  // the track is pinned and cached, the way a real one would be
  sqlite.prepare("INSERT INTO pins (term, track_id, at) VALUES ('new order blue monday', ?, ?)").run(TRACK, Date.now());
  sqlite.prepare("INSERT INTO previews (term, json, at) VALUES ('new order blue monday', '[]', ?)").run(Date.now());

  // garbage is refused before it can touch the table
  for(const bad of [{ device: 'nothex', track: TRACK }, { device: A, track: 0 }, { device: A, track: 'x' }]){
    const r = await flag(bad.device, bad.track);
    if(r.status !== 400) throw new Error('bad input accepted: ' + JSON.stringify(bad));
  }
  if(sqlite.prepare('SELECT COUNT(*) n FROM clip_flags').get().n !== 0) throw new Error('rejected input still stored a vote');
  console.log('flagclip: bad device / bad track refused, nothing stored OK');

  // ONE report is not enough — "I didn't recognise it" is not "there is no
  // voice in it", and a single misread must not delete a good recording
  const r1 = await flag(A, TRACK);
  if(!r1.body.ok || r1.body.votes !== 1) throw new Error('first vote wrong: ' + JSON.stringify(r1.body));
  if(isDead(TRACK)) throw new Error('one report retired the track');
  // …and the same device shouting twice is still one vote
  const again = await flag(A, TRACK);
  if(again.body.votes !== 1) throw new Error('a device voted twice: ' + JSON.stringify(again.body));
  if(isDead(TRACK)) throw new Error('one device retired the track by repeating itself');
  console.log('flagclip: one device = one vote, no retirement OK');

  // a SECOND device agreeing retires it: blacklisted, pin dropped, and the
  // cached search dropped too — otherwise the next lookup serves it from cache
  const r2 = await flag(B, TRACK);
  if(r2.body.votes !== 2) throw new Error('second vote not counted: ' + JSON.stringify(r2.body));
  if(!isDead(TRACK)) throw new Error('two devices did not retire the track');
  if(sqlite.prepare('SELECT COUNT(*) n FROM pins WHERE track_id=?').get(TRACK).n !== 0) throw new Error('pin survived retirement');
  if(sqlite.prepare("SELECT COUNT(*) n FROM previews WHERE term='new order blue monday'").get().n !== 0)
    throw new Error('cached search survived retirement — the next lookup would serve the retired track');
  console.log('flagclip: two devices retire it, pin + cached search cleared OK');

  // reporting an already-retired track is harmless, not an error
  const r3 = await flag(C, TRACK);
  if(!r3.body.ok || r3.body.votes !== 3) throw new Error('late vote broke: ' + JSON.stringify(r3.body));
  console.log('flagclip: reporting an already-retired track is a no-op OK');

  // votes are per TRACK — flagging one must not touch its neighbours
  const OTHER = 1874711522;
  await flag(A, OTHER);
  if(isDead(OTHER)) throw new Error('a single vote on a different track retired it');
  console.log('flagclip: votes do not leak between tracks OK');

  // no handle, no score, no nickname: a flag says which track and which device,
  // and the device token is the same anonymous one the boards already use
  const cols = sqlite.prepare('PRAGMA table_info(clip_flags)').all().map(c => c.name).sort();
  if(cols.join(',') !== 'at,device,track_id') throw new Error('clip_flags grew a column: ' + cols.join(','));
  console.log('flagclip: table carries nothing but track, device, timestamp OK');

  console.log('CLIP FLAG TEST PASS ✓');
})().catch(e => { console.error('CLIP FLAG FAIL ✗', e.message); process.exit(1); });
