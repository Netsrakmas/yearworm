// One event must produce ONE push. A friend playing your direct challenge is
// reported through TWO endpoints — /chal (the set's leaderboard) and /social
// action:'result' (the duel record) — and both used to notify the challenger,
// so the same moment arrived twice in the same minute.
//
// Runs the REAL worker.js over a better-sqlite3-backed D1 shim and counts the
// pushes. The VAPID keypair is generated at run time on purpose: this file is
// tracked, and a test that ships a private key is a test nobody can commit.
const fs = require('fs');
const Database = require('better-sqlite3');

const ROOT = '/home/user/Timeline';
const C = globalThis.crypto.subtle;

(async () => {
  // --- a VAPID pair the worker will accept: PKCS8 base64 + raw base64url ---
  const kp = await C.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const VAPID_PRIVATE = Buffer.from(await C.exportKey('pkcs8', kp.privateKey)).toString('base64');
  const VAPID_PUBLIC = Buffer.from(await C.exportKey('raw', kp.publicKey)).toString('base64url');
  // the subscriber's own key, used by the payload encryption
  const ua = await C.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPub = Buffer.from(await C.exportKey('raw', ua.publicKey)).toString('base64url');
  const auth = require('crypto').randomBytes(16).toString('base64url');

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

  const pushes = [];
  globalThis.fetch = async (url, opts) => { pushes.push(String(url)); return { status: 201 }; };

  const worker = (await import(ROOT + '/server/worker.js')).default;
  const tasks = []; const ctx = { waitUntil: p => tasks.push(p) };
  const settle = async () => { await Promise.all(tasks.splice(0)); };
  const env = { DB, VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT: 'mailto:a@b.co', GOOGLE_CLIENT_ID: '' };

  const hit = async (path, body, ip) => {
    const r = await worker.fetch(new Request('https://x' + path, { method: 'POST',
      headers: { 'content-type': 'application/json', 'Origin': 'https://playyearworm.com', 'CF-Connecting-IP': ip || '8.8.8.8' },
      body: JSON.stringify(body) }), env, ctx);
    return { status: r.status, body: await r.json() };
  };
  const social = (b, ip) => hit('/social', b, ip);
  const chal = (b, ip) => hit('/chal', b, ip);

  const A = 'a'.repeat(32), B = 'b'.repeat(32), D = 'd'.repeat(32);
  const ca = await social({ device: A, action: 'claim', handle: 'Alice' });
  const aCode = ca.body.me.code, aId = ca.body.me.id;
  await social({ device: B, action: 'claim', handle: 'Bob' });
  await social({ device: B, action: 'add', code: aCode }); await settle();
  // Alice is the one being notified, so she is the one who needs a subscription
  await social({ device: A, action: 'push-sub', sub: { endpoint: 'https://cap/alice', keys: { p256dh: uaPub, auth } } });

  // Alice plays her own run first — that registers her as the set's owner —
  // then challenges Bob with it
  const SET = '11.12.13.14.15.16';
  await chal({ device: A, set: SET, nick: 'Alice', score: 4, timeMs: 20000 }); await settle();
  const bId = (await social({ device: A, action: 'state' })).body.friends.find(f => f.handle === 'Bob').id;
  await social({ device: A, action: 'challenge', to: bId, set: SET, score: 4, timeMs: 20000 }); await settle();

  // Bob finishes it. The client reports BOTH ways, exactly as index.html does.
  pushes.length = 0;
  const msg = (await social({ device: B, action: 'state' })).body.inbox.find(m => m.kind === 'challenge');
  if(!msg) throw new Error('setup: Bob never received the challenge');
  await social({ device: B, action: 'result', id: msg.id, score: 2, timeMs: 30000 }); await settle();
  await chal({ device: B, set: SET, nick: 'Bob', score: 2, timeMs: 30000, duel: true }); await settle();
  if(pushes.length !== 1)
    throw new Error('a direct challenge should notify Alice ONCE, got ' + pushes.length + ' pushes');
  console.log('direct challenge: reported twice, notified once OK');

  // …and the /chal push is NOT dead code: a stranger playing a SHARED LINK has
  // no duel record, so that path is the only notification there is
  pushes.length = 0;
  await chal({ device: D, set: SET, nick: 'Dave', score: 3, timeMs: 25000 }); await settle();
  if(pushes.length !== 1)
    throw new Error('a link-played run should still notify the owner once, got ' + pushes.length);
  console.log('shared link: no duel record, /chal push still fires OK');

  // ownership is recorded even for a duel submission — only the push stands down
  const owner = sqlite.prepare("SELECT user_id FROM chal_owner WHERE setkey=?").get(SET);
  if(!owner || owner.user_id !== aId) throw new Error('set ownership was lost: ' + JSON.stringify(owner));
  // and Bob's score really is on the board, it was not silently dropped
  const rows = sqlite.prepare("SELECT nick FROM chals WHERE setkey=? ORDER BY nick").all(SET).map(r => r.nick);
  if(rows.join(',') !== 'Alice,Bob,Dave') throw new Error('board rows wrong: ' + rows.join(','));
  console.log('duel submission still records ownership + board row OK');

  console.log('PUSH DEDUPE TEST PASS ✓');
})().catch(e => { console.error('PUSH DEDUPE FAIL ✗', e.message); process.exit(1); });
