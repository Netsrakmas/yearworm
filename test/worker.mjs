// Unit test for server/worker.js with an in-memory fake of the D1 subset used.
// (SQL itself is exercised on deploy via a curl smoke test — this validates
// routing, validation, one-shot upsert semantics and rank math.)
const worker = (await import('/home/user/Timeline/server/worker.js')).default;

const rows = [];    // {day, device, nick, score, time_ms, created}
const chals = [];   // {setkey, device, nick, score, time_ms, created}
const users = [];   // {id, handle, handle_lc, code, created}
const devices = []; // {device, user_id, created}
const friends = []; // {a, b, requester, status, created}
const inbox = [];   // {id, to_user, from_user, kind, payload, created, seen}
const logins = [];  // {provider, subject, user_id, email, created}
const duels = [];   // {msg_id, a, b, score_a, score_b, time_a, time_b, winner, created}
let inboxSeq = 0;
function fakeDB(){
  return { prepare(sql){ return { bind(...a){ return {
    async run(){
      if(/^INSERT INTO scores/.test(sql)){
        const [day, device, nick, score, time_ms, created] = a;
        const ex = rows.find(r=>r.day===day && r.device===device);
        if(ex){ ex.nick = nick; }   // ON CONFLICT: nick only
        else rows.push({day, device, nick, score, time_ms, created});
        return {};
      }
      if(/^INSERT INTO chals/.test(sql)){
        const [setkey, device, nick, score, time_ms, created] = a;
        const ex = chals.find(r=>r.setkey===setkey && r.device===device);
        if(ex){ ex.nick = nick; }
        else chals.push({setkey, device, nick, score, time_ms, created});
        return {};
      }
      if(/^INSERT INTO users/.test(sql)){ const [id,handle,handle_lc,code,created]=a; users.push({id,handle,handle_lc,code,created}); return {}; }
      if(/^INSERT INTO devices/.test(sql)){ const [device,user_id,created]=a;
        const ex=devices.find(d=>d.device===device); if(ex) ex.user_id=user_id; else devices.push({device,user_id,created}); return {}; }
      if(/^UPDATE users SET handle/.test(sql)){ const [handle,handle_lc,id]=a; const u=users.find(x=>x.id===id); if(u){u.handle=handle;u.handle_lc=handle_lc;} return {}; }
      if(/^INSERT INTO friends/.test(sql)){ const [x,y,requester,created]=a;
        friends.push({a:x,b:y,requester,status:sql.includes("'accepted'")?'accepted':'pending',created}); return {}; }
      if(/^UPDATE friends SET status='accepted'/.test(sql)){ const [x,y]=a; const f=friends.find(r=>r.a===x&&r.b===y); if(f) f.status='accepted'; return {}; }
      if(/^DELETE FROM friends/.test(sql)){ const [x,y]=a; const i=friends.findIndex(r=>r.a===x&&r.b===y); if(i>=0) friends.splice(i,1); return {}; }
      if(/^INSERT INTO inbox/.test(sql)){ const kind = sql.includes("'react'") ? 'react' : sql.includes("'result'") ? 'result' : sql.includes("'friend'") ? 'friend' : 'challenge';
        const [to_user,from_user,payload,created]=a; inbox.push({id:++inboxSeq,to_user,from_user,kind,payload,created,seen:0}); return {}; }
      if(/^INSERT OR IGNORE INTO duels/.test(sql)){ const [msg_id,x,y,score_a,score_b,time_a,time_b,winner,created]=a;
        if(duels.some(d=>d.msg_id===msg_id)) return {meta:{changes:0}};
        duels.push({msg_id,a:x,b:y,score_a,score_b,time_a,time_b,winner,created}); return {meta:{changes:1}}; }
      if(/^UPDATE inbox SET seen=1/.test(sql)){ const [id,to_user]=a; const m=inbox.find(r=>r.id===id&&r.to_user===to_user); if(m) m.seen=1; return {}; }
      if(/^INSERT INTO logins/.test(sql)){ const [subject,user_id,email,created]=a; logins.push({provider:'google',subject,user_id,email,created}); return {}; }
      throw new Error('unexpected run: '+sql);
    },
    async first(){
      if(/SELECT COUNT\(\*\) AS n FROM scores WHERE day=\?1 AND/.test(sql)){
        const [day, score, time_ms, created] = a;
        return { n: rows.filter(r=>r.day===day && (r.score>score || (r.score===score && r.time_ms<time_ms) || (r.score===score && r.time_ms===time_ms && r.created<created))).length };
      }
      if(/SELECT COUNT\(\*\) AS n FROM scores WHERE day=\?1$/.test(sql))
        return { n: rows.filter(r=>r.day===a[0]).length };
      if(/SELECT nick, score, time_ms, created FROM scores/.test(sql))
        return rows.find(r=>r.day===a[0] && r.device===a[1]) || null;
      if(/SELECT u\.id, u\.handle, u\.code FROM devices/.test(sql)){
        const d=devices.find(x=>x.device===a[0]); if(!d) return null;
        const u=users.find(x=>x.id===d.user_id); return u?{id:u.id,handle:u.handle,code:u.code}:null;
      }
      if(/SELECT id, handle, code FROM users WHERE id=/.test(sql)){ const u=users.find(x=>x.id===a[0]); return u?{id:u.id,handle:u.handle,code:u.code}:null; }
      if(/SELECT id, handle FROM users WHERE id=/.test(sql)){ const u=users.find(x=>x.id===a[0]); return u?{id:u.id,handle:u.handle}:null; }
      if(/SELECT user_id FROM logins WHERE provider='google' AND subject=/.test(sql)){ const l=logins.find(x=>x.subject===a[0]); return l?{user_id:l.user_id}:null; }
      if(/SELECT user_id FROM logins WHERE user_id=/.test(sql)){ const l=logins.find(x=>x.user_id===a[0]); return l?{user_id:l.user_id}:null; }
      if(/SELECT handle FROM users WHERE id=/.test(sql)){ const u=users.find(x=>x.id===a[0]); return u?{handle:u.handle}:null; }
      if(/SELECT id FROM users WHERE handle_lc=/.test(sql)){ const u=users.find(x=>x.handle_lc===a[0]); return u?{id:u.id}:null; }
      if(/SELECT id, handle FROM users WHERE code=/.test(sql)){ const u=users.find(x=>x.code===a[0]); return u?{id:u.id,handle:u.handle}:null; }
      if(/SELECT from_user, kind, payload FROM inbox WHERE id=/.test(sql)){
        const m=inbox.find(r=>r.id===a[0]&&r.to_user===a[1]); return m?{from_user:m.from_user,kind:m.kind,payload:m.payload}:null; }
      if(/SELECT requester, status FROM friends/.test(sql)){ const f=friends.find(r=>r.a===a[0]&&r.b===a[1]); return f?{requester:f.requester,status:f.status}:null; }
      if(/SELECT status FROM friends/.test(sql)){ const f=friends.find(r=>r.a===a[0]&&r.b===a[1]); return f?{status:f.status}:null; }
      // "have they played this set before" — drives the play-notification, which
      // must fire for a NEW player only. The mock had gone stale on this one.
      if(/SELECT 1 AS x FROM chals WHERE setkey=/.test(sql)){
        return chals.some(r=>r.setkey===a[0] && r.device===a[1]) ? { x:1 } : null; }
      // reaction bundling: an unseen result row from the same sender absorbs it
      if(/SELECT id, payload FROM inbox WHERE to_user=\?1 AND from_user=\?2 AND kind='result'/.test(sql)){
        const m = inbox.filter(r=>r.to_user===a[0]&&r.from_user===a[1]&&r.kind==='result'&&!r.seen)
          .sort((x,y)=>y.created-x.created)[0];
        return m ? { id:m.id, payload:m.payload } : null; }
      throw new Error('unexpected first: '+sql);
    },
    async all(){
      if(/SELECT nick, score, time_ms FROM scores WHERE day=\?1 ORDER BY/.test(sql)){
        const day=a[0];
        const s=[...rows.filter(r=>r.day===day)].sort((x,y)=> y.score-x.score || x.time_ms-y.time_ms || x.created-y.created);
        return { results: s.slice(0,25) };
      }
      if(/SELECT nick, score, time_ms, device FROM chals WHERE setkey=\?1 ORDER BY/.test(sql)){
        const s=[...chals.filter(r=>r.setkey===a[0])].sort((x,y)=> y.score-x.score || x.time_ms-y.time_ms || x.created-y.created);
        return { results: s.slice(0,50) };
      }
      if(/SELECT a, b, requester, status FROM friends/.test(sql)){
        return { results: friends.filter(r=>r.a===a[0]||r.b===a[0]).map(r=>({...r})) };
      }
      if(/SELECT a, b, winner, score_a, score_b, created FROM duels/.test(sql)){
        return { results: duels.filter(d=>d.a===a[0]||d.b===a[0])
          .sort((x,y)=>y.created-x.created)
          .map(d=>({a:d.a,b:d.b,winner:d.winner,score_a:d.score_a,score_b:d.score_b,created:d.created})) };
      }
      if(/FROM inbox WHERE to_user=/.test(sql)){
        return { results: inbox.filter(m=>m.to_user===a[0]&&!m.seen).sort((x,y)=>y.created-x.created).slice(0,20)
          .map(m=>({id:m.id,from_user:m.from_user,kind:m.kind,payload:m.payload,created:m.created,shown:m.shown||0})) };
      }
      // challenges I sent that are still unanswered — the "⏳ waiting" list
      if(/FROM inbox WHERE from_user=/.test(sql)){
        return { results: inbox.filter(m=>m.from_user===a[0]&&m.kind==='challenge'&&!m.seen)
          .sort((x,y)=>y.created-x.created).slice(0,20).map(m=>({to_user:m.to_user,created:m.created})) };
      }
      throw new Error('unexpected all: '+sql);
    },
  };}};}};
}
const env = { DB: fakeDB() };
const call = (method, path, body, origin) => worker.fetch(new Request('https://api.test'+path, {
  method, body: body?JSON.stringify(body):undefined,
  headers: { 'Origin': origin||'https://playyearworm.com', 'CF-Connecting-IP': '1.2.3.'+Math.floor(Math.random()*250) }
}), env);
const js = async r => ({ status: r.status, body: await r.json(), cors: r.headers.get('Access-Control-Allow-Origin') });

const DAILY_EPOCH = Date.UTC(2026, 6, 1);
const today = Math.max(1, Math.floor((Date.now()-DAILY_EPOCH)/864e5)+1);
const dev = n => n.repeat(32).slice(0,32);

// health + CORS
let r = await js(await call('GET','/health'));
if(!r.body.ok || r.body.day!==today) throw new Error('health wrong: '+JSON.stringify(r));
if(r.cors!=='https://playyearworm.com') throw new Error('cors wrong');
r = await js(await call('GET','/health',null,'https://evil.example'));
if(r.cors!=='https://playyearworm.com') throw new Error('foreign origin must not be echoed');

// validation
for(const bad of [
  {day:today+5, device:dev('a'), score:3, timeMs:9000},
  {day:today, device:'xyz', score:3, timeMs:9000},
  {day:today, device:dev('a'), score:9, timeMs:9000},
  {day:today, device:dev('a'), score:3, timeMs:10},
]){
  r = await js(await call('POST','/daily',bad));
  if(r.status!==400) throw new Error('should reject: '+JSON.stringify(bad));
}

// three players, ranking: score desc, then time asc
r = await js(await call('POST','/daily',{day:today, device:dev('a'), nick:'Sam', score:4, timeMs:20000}));
if(r.body.me.rank!==1) throw new Error('first submit should rank 1');
await call('POST','/daily',{day:today, device:dev('b'), nick:'B<script>', score:5, timeMs:30000});
r = await js(await call('POST','/daily',{day:today, device:dev('c'), nick:'Cee', score:4, timeMs:9000}));
if(r.body.total!==3) throw new Error('total wrong: '+r.body.total);
if(r.body.me.rank!==2) throw new Error('faster tie should rank 2, got '+r.body.me.rank);
if(r.body.top[0].nick!=='Bscript') throw new Error('nick not sanitized: '+r.body.top[0].nick);
if(r.body.top.map(t=>t.nick).join()!=='Bscript,Cee,Sam') throw new Error('order wrong: '+r.body.top.map(t=>t.nick));

// one-shot: resubmitting a better score must NOT overwrite, only the nick updates
r = await js(await call('POST','/daily',{day:today, device:dev('a'), nick:'Sammy', score:5, timeMs:1000}));
if(r.body.me.score!==4 || r.body.me.nick!=='Sammy') throw new Error('one-shot upsert broken: '+JSON.stringify(r.body.me));

// GET board with rank for a device
r = await js(await call('GET','/daily?device='+dev('a')));
if(r.body.me.rank!==3) throw new Error('GET rank wrong: '+JSON.stringify(r.body.me));
if(r.body.top.length!==3) throw new Error('top wrong');

// --- challenge-set boards ---
for(const bad of [
  {set:'abc', device:dev('a'), score:3, timeMs:9000},
  {set:'12', device:dev('a'), score:3, timeMs:9000},          // single index: not a set
  {set:'1.2.3', device:dev('a'), score:7, timeMs:9000},
]){
  r = await js(await call('POST','/chal',bad));
  if(r.status!==400) throw new Error('chal should reject: '+JSON.stringify(bad));
}
r = await js(await call('POST','/chal',{set:'10.20.30.40.50.60', device:dev('a'), nick:'Sam', score:3, timeMs:9000}));
if(r.body.total!==1 || !r.body.results[0].you) throw new Error('chal first submit wrong: '+JSON.stringify(r.body));
await call('POST','/chal',{set:'10.20.30.40.50.60', device:dev('b'), nick:'Jesse', score:4, timeMs:12000});
r = await js(await call('POST','/chal',{set:'10.20.30.40.50.60', device:dev('a'), nick:'Sammy', score:5, timeMs:800}));
const me2 = r.body.results.find(x=>x.you);
if(r.body.total!==2 || me2.score!==3 || me2.nick!=='Sammy') throw new Error('chal one-shot broken: '+JSON.stringify(r.body));
if(r.body.results[0].nick!=='Jesse') throw new Error('chal ranking wrong: '+JSON.stringify(r.body.results));
r = await js(await call('GET','/chal?set=10.20.30.40.50.60&device='+dev('b')));
if(r.body.total!==2 || !r.body.results.find(x=>x.you && x.nick==='Jesse')) throw new Error('chal GET wrong: '+JSON.stringify(r.body));
if(r.body.results.some(x=>x.device)) throw new Error('device tokens must not leak in chal results');
console.log('chal boards: validation, one-shot, ranking, you-flag, no device leak ✓');

// --- social: claim, friends, direct challenges ---
r = await js(await call('POST','/social',{device:dev('a'), action:'claim', handle:'x'}));
if(r.status!==400) throw new Error('short handle should be rejected');
r = await js(await call('POST','/social',{device:dev('a'), action:'claim', handle:'Sam K'}));
if(!r.body.me || r.body.me.handle!=='Sam K' || !/^YW-/.test(r.body.me.code)) throw new Error('claim failed: '+JSON.stringify(r.body));
const codeA = r.body.me.code;
r = await js(await call('POST','/social',{device:dev('b'), action:'claim', handle:'sam k'}));
if(r.status!==409) throw new Error('case-insensitive handle collision not rejected');
r = await js(await call('POST','/social',{device:dev('b'), action:'claim', handle:'Jesse'}));
if(!r.body.me || r.body.me.handle!=='Jesse') throw new Error('second claim failed');
// B adds A by code (self-add rejected first)
r = await js(await call('POST','/social',{device:dev('b'), action:'add', code:r.body.me.code}));
if(r.status!==400) throw new Error('adding your own code should fail');
r = await js(await call('POST','/social',{device:dev('b'), action:'add', code:codeA}));
if(!r.body.friends.length || r.body.friends[0].handle!=='Sam K') throw new Error('add-by-code should be instant friendship: '+JSON.stringify(r.body));
// the code owner gets a courtesy note, NOT an accept chore
r = await js(await call('GET','/social?device='+dev('a')));
if(!r.body.friends.length || r.body.friends[0].handle!=='Jesse') throw new Error('friendship not mutual: '+JSON.stringify(r.body));
if(r.body.requests.length) throw new Error('no request should remain after add-by-code');
const fnote = r.body.inbox.find(m=>m.kind==='friend');
if(!fnote || fnote.handle!=='Jesse') throw new Error('friend note missing: '+JSON.stringify(r.body.inbox));
await call('POST','/social',{device:dev('a'), action:'seen', ids:[fnote.id]});
// legacy pending rows (pre-instant-add) still resolve through accept
r = await js(await call('POST','/social',{device:dev('9'), action:'claim', handle:'Lego'}));
const legoId = users.find(u=>u.handle==='Lego').id, samId = users.find(u=>u.handle==='Sam K').id;
friends.push({ a: legoId < samId ? legoId : samId, b: legoId < samId ? samId : legoId,
  requester: legoId, status:'pending', created: 1 });
r = await js(await call('GET','/social?device='+dev('a')));
if(!r.body.requests.length || r.body.requests[0].handle!=='Lego') throw new Error('legacy request missing: '+JSON.stringify(r.body.requests));
r = await js(await call('POST','/social',{device:dev('a'), action:'accept', user:legoId}));
if(!r.body.friends.some(f=>f.handle==='Lego')) throw new Error('legacy accept failed: '+JSON.stringify(r.body.friends));
// direct challenge B -> A (friend) and to a stranger (403)
r = await js(await call('POST','/social',{device:dev('b'), action:'challenge', to:'deadbeef', set:'1.2.3.4.5.6', score:4, timeMs:9000}));
if(r.status!==403) throw new Error('challenging a non-friend should 403');
const aId = (await js(await call('GET','/social?device='+dev('b')))).body.friends[0].id;
r = await js(await call('POST','/social',{device:dev('b'), action:'challenge', to:aId, set:'1.2.3.4.5.6', score:4, timeMs:9000}));
if(r.status!==200) throw new Error('friend challenge failed: '+JSON.stringify(r.body));
r = await js(await call('GET','/social?device='+dev('a')));
if(!r.body.inbox.length || r.body.inbox[0].handle!=='Jesse' || r.body.inbox[0].payload.set!=='1.2.3.4.5.6') throw new Error('inbox challenge missing: '+JSON.stringify(r.body.inbox));
const msgId = r.body.inbox[0].id;
r = await js(await call('POST','/social',{device:dev('a'), action:'seen', ids:[msgId]}));
if(r.body.inbox.length!==0) throw new Error('seen did not clear the inbox');
// unregistered device: GET is a soft null, POST actions require a profile
r = await js(await call('GET','/social?device='+dev('c')));
if(r.body.me!==null) throw new Error('unknown device should get me:null');
r = await js(await call('POST','/social',{device:dev('c'), action:'add', code:codeA}));
if(r.status!==401) throw new Error('actions without a profile should 401');
// POST action 'state' mirrors GET /social (keeps the device token out of URLs)
r = await js(await call('POST','/social',{device:dev('c'), action:'state'}));
if(r.status!==200 || r.body.me!==null) throw new Error('state for unknown device should be 200 me:null: '+JSON.stringify(r.body));
r = await js(await call('POST','/social',{device:dev('a'), action:'state'}));
if(!r.body.me || r.body.me.handle!=='Sam K') throw new Error('state for known device wrong: '+JSON.stringify(r.body.me));
console.log('social: claim/uniqueness, instant add, POST state, direct challenge inbox, seen, auth guards ✓');

// --- /auth: Google sign-in (self-signed JWT + stubbed JWKS) ---
const kp = await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5', modulusLength:2048, publicExponent:new Uint8Array([1,0,1]), hash:'SHA-256'}, true, ['sign','verify']);
const pubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
pubJwk.kid = 'testkid'; pubJwk.alg = 'RS256'; pubJwk.use = 'sig';
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  if(String(u).includes('googleapis.com/oauth2/v3/certs'))
    return new Response(JSON.stringify({keys:[pubJwk]}), {headers:{'content-type':'application/json'}});
  return realFetch(u, o);
};
const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
async function forge(payload, kid){
  const h = b64u(JSON.stringify({alg:'RS256', kid: kid||'testkid'}));
  const p = b64u(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(h+'.'+p));
  return h+'.'+p+'.'+b64u(sig);
}
const env2 = { DB: env.DB, GOOGLE_CLIENT_ID: 'test-client' };
const call2 = (method, path, body) => worker.fetch(new Request('https://api.test'+path, {
  method, body: JSON.stringify(body), headers: {'Origin':'https://playyearworm.com','CF-Connecting-IP':'9.9.9.'+Math.floor(Math.random()*250)}
}), env2);
const nowSec = Math.floor(Date.now()/1000);

// disabled without a client id
r = await js(await call('POST','/auth',{device:dev('d'), credential:'x.y.z'}));
if(r.status!==503) throw new Error('auth without client id should 503');
// garbage + wrong aud + expired all rejected
r = await js(await call2('POST','/auth',{device:dev('d'), credential:'not.a.jwt'}));
if(r.status!==401) throw new Error('garbage credential should 401');
r = await js(await call2('POST','/auth',{device:dev('d'), credential: await forge({iss:'https://accounts.google.com', aud:'OTHER', sub:'g1', exp:nowSec+600})}));
if(r.status!==401) throw new Error('wrong audience should 401');
r = await js(await call2('POST','/auth',{device:dev('d'), credential: await forge({iss:'https://accounts.google.com', aud:'test-client', sub:'g1', exp:nowSec-10})}));
if(r.status!==401) throw new Error('expired token should 401');

// fresh device, unknown sub -> account created from the Google name
const tok1 = await forge({iss:'https://accounts.google.com', aud:'test-client', sub:'g1', exp:nowSec+600, given_name:'Tim'});
r = await js(await call2('POST','/auth',{device:dev('d'), credential: tok1}));
if(r.status!==200 || !r.body.me || r.body.me.handle!=='Tim' || !r.body.me.linked) throw new Error('fresh sign-in failed: '+JSON.stringify(r.body));
const timCode = r.body.me.code;
// same Google account on ANOTHER device -> same account restored (same code)
r = await js(await call2('POST','/auth',{device:dev('e'), credential: tok1}));
if(r.body.me.code!==timCode || r.body.me.handle!=='Tim') throw new Error('account not restored on second device: '+JSON.stringify(r.body.me));
// device with an existing claimed profile links a NEW sub to that profile
const tok2 = await forge({iss:'https://accounts.google.com', aud:'test-client', sub:'g2', exp:nowSec+600, given_name:'Sam'});
r = await js(await call2('POST','/auth',{device:dev('a'), credential: tok2}));
if(r.body.me.handle!=='Sam K' || !r.body.me.linked) throw new Error('link-to-existing failed: '+JSON.stringify(r.body.me));
// name collision on auto-handle: another Google Tim gets 'Tim 2'
const tok3 = await forge({iss:'https://accounts.google.com', aud:'test-client', sub:'g3', exp:nowSec+600, given_name:'Tim'});
r = await js(await call2('POST','/auth',{device:'f'.repeat(32), credential: tok3}));
if(r.body.me.handle!=='Tim 2') throw new Error('handle dedup failed: '+JSON.stringify(r.body.me));
globalThis.fetch = realFetch;
console.log('auth: 503-off, JWT checks (garbage/aud/expiry), create-from-Google, restore-on-new-device, link-to-profile, handle dedup ✓');

// --- reactions: whitelist only, friends only, lands in the inbox ---
r = await js(await call('POST','/social',{device:dev('b'), action:'react', to:aId, emoji:'lol', score:3}));
if(r.status!==400) throw new Error('non-whitelisted reaction should 400');
r = await js(await call('POST','/social',{device:dev('b'), action:'react', to:'deadbeef', emoji:'🔥', score:3}));
if(r.status!==403) throw new Error('reacting to a non-friend should 403');
r = await js(await call('POST','/social',{device:dev('b'), action:'react', to:aId, emoji:'🔥', score:3}));
if(r.status!==200) throw new Error('friend reaction failed: '+JSON.stringify(r.body));
r = await js(await call('GET','/social?device='+dev('a')));
const rx = r.body.inbox.find(m=>m.kind==='react');
if(!rx || rx.handle!=='Jesse' || rx.payload.emoji!=='🔥') throw new Error('reaction not in inbox: '+JSON.stringify(r.body.inbox));
console.log('reactions: whitelist, friends-only, inbox delivery ✓');

// --- duels: reporting an inbox-challenge result records the head-to-head ---
// msgId is B(Jesse)->A(Sam K) with score 4, timeMs 9000 (already marked seen —
// results must still resolve seen messages)
r = await js(await call('POST','/social',{device:dev('a'), action:'result', id:msgId, score:99}));
if(r.status!==400) throw new Error('out-of-range result score should 400');
r = await js(await call('POST','/social',{device:dev('a'), action:'result', id:12345, score:5}));
if(r.status!==404) throw new Error('unknown message id should 404');
r = await js(await call('POST','/social',{device:dev('b'), action:'result', id:msgId, score:5, timeMs:1000}));
if(r.status!==404) throw new Error('only the recipient may report a result');
r = await js(await call('POST','/social',{device:dev('a'), action:'result', id:msgId, score:5, timeMs:8000}));
if(r.status!==200) throw new Error('result report failed: '+JSON.stringify(r.body));
let fJesse = r.body.friends.find(f=>f.handle==='Jesse');
if(!fJesse || fJesse.w!==1 || fJesse.l!==0 || fJesse.t!==0) throw new Error('winner tally wrong: '+JSON.stringify(r.body.friends));
r = await js(await call('GET','/social?device='+dev('b')));
const res = r.body.inbox.find(m=>m.kind==='result');
if(!res || res.handle!=='Sam K' || res.payload.score!==5 || res.payload.w!=='them') throw new Error('challenger result message wrong: '+JSON.stringify(r.body.inbox));
let fSam = r.body.friends.find(f=>f.handle==='Sam K');
if(!fSam || fSam.w!==0 || fSam.l!==1) throw new Error('loser tally wrong: '+JSON.stringify(r.body.friends));
// duplicate report is a no-op: first result stands, no second inbox message
r = await js(await call('POST','/social',{device:dev('a'), action:'result', id:msgId, score:0, timeMs:99}));
if(r.status!==200) throw new Error('duplicate report should still 200');
fJesse = r.body.friends.find(f=>f.handle==='Jesse');
if(fJesse.w!==1 || fJesse.l!==0) throw new Error('duplicate report changed the tally');
r = await js(await call('GET','/social?device='+dev('b')));
if(r.body.inbox.filter(m=>m.kind==='result').length!==1) throw new Error('duplicate report sent a second message');
// equal score falls to the fastest time; equal everything is a tie
r = await js(await call('POST','/social',{device:dev('b'), action:'challenge', to:aId, set:'2.3.4.5.6.7', score:4, timeMs:9000}));
let m2 = (await js(await call('GET','/social?device='+dev('a')))).body.inbox.find(m=>m.kind==='challenge');
r = await js(await call('POST','/social',{device:dev('a'), action:'result', id:m2.id, score:4, timeMs:5000}));
fJesse = r.body.friends.find(f=>f.handle==='Jesse');
if(fJesse.w!==2 || fJesse.l!==0) throw new Error('tie-broken-by-time not a win: '+JSON.stringify(fJesse));
r = await js(await call('POST','/social',{device:dev('b'), action:'challenge', to:aId, set:'3.4.5.6.7.8', score:4, timeMs:9000}));
m2 = (await js(await call('GET','/social?device='+dev('a')))).body.inbox.find(m=>m.kind==='challenge');
r = await js(await call('POST','/social',{device:dev('a'), action:'result', id:m2.id, score:4, timeMs:9000}));
fJesse = r.body.friends.find(f=>f.handle==='Jesse');
if(fJesse.w!==2 || fJesse.l!==0 || fJesse.t!==1) throw new Error('dead-even duel not a tie: '+JSON.stringify(fJesse));
// rolling 7-day window + recent duels ride along on each friend entry
r = await js(await call('GET','/social?device='+dev('a')));
fJesse = r.body.friends.find(f=>f.handle==='Jesse');
if(fJesse.w7!==2 || fJesse.l7!==0 || fJesse.t7!==1) throw new Error('7-day tally wrong: '+JSON.stringify(fJesse));
if(!Array.isArray(fJesse.recent) || fJesse.recent.length!==3) throw new Error('recent duels missing: '+JSON.stringify(fJesse.recent));
if(!fJesse.recent.every(x=>Number.isFinite(x.mine) && Number.isFinite(x.theirs) && x.at && ['w','l','t'].includes(x.r)))
  throw new Error('recent duel shape wrong: '+JSON.stringify(fJesse.recent));
if(!fJesse.recent.some(x=>x.r==='t' && x.mine===4 && x.theirs===4)) throw new Error('tie duel not in recent: '+JSON.stringify(fJesse.recent));
console.log('duels: validation, recipient-only, winner/tie math, one-shot dedupe, challenger notified, 7-day window + recent ✓');

console.log('WORKER TEST PASS ✓ (validation, sanitizing, one-shot upsert, tie-by-time ranking, CORS, chal boards, social, auth, duels)');
