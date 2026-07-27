// Yearworm API — daily leaderboard. Cloudflare Worker + D1 (SQLite).
// No accounts, no personal data: a random device token, a nickname, a score.
// First submission per (day, device) stands — same one-shot rule as the client.

const DAILY_EPOCH = Date.UTC(2026, 6, 1);        // #1 = 1 July 2026 (mirrors index.html)
const RUN_LEN = 5;
const TOP_N = 25;

const dayNow = () => Math.max(1, Math.floor((Date.now() - DAILY_EPOCH) / 864e5) + 1);

function corsHeaders(origin){
  const ok = origin && (origin === "https://playyearworm.com" || /^http:\/\/localhost(:\d+)?$/.test(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin : "https://playyearworm.com",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin",
  };
}
const json = (obj, status, cors) =>
  new Response(JSON.stringify(obj), { status: status || 200, headers: { ...cors, "content-type": "application/json" } });

function cleanNick(n){
  const s = String(n == null ? "" : n).replace(/[^\p{L}\p{N} _\-.]/gu, "").replace(/\s+/g, " ").trim().slice(0, 20);
  return s || "Player";
}

// best-effort burst limit per isolate (D1 stays the source of truth for one-shot)
const hits = new Map();
const lookupHits = new Map();          // song lookups get their own, larger budget
function limited(ip, max, bucket){
  const m = bucket || hits;
  const now = Date.now();
  const h = m.get(ip) || { n: 0, t: now };
  if(now - h.t > 60000){ h.n = 0; h.t = now; }
  h.n++;
  m.set(ip, h);
  if(m.size > 10000) m.clear();
  if(max) return h.n > max;
  // 30/min was set when a screen made one call. The Ranks tab alone now fires
  // four (social state + daily board + both survival windows), typing a name
  // adds more, and a household or office shares one IP — so 30 was throttling
  // ordinary use and, worse, the failures read as "that player doesn't exist".
  // These are cheap reads; 90 still bounds any scraping worth the name.
  return h.n > 90;
}

/* ---------- version picking ----------
   PORTED VERBATIM from index.html. The SERVER picks the version now, so that
   one algorithm decides for everyone; the client keeps its copy only for the
   fallback path (Worker unreachable → straight to Apple).
   Two copies is a real hazard: if they drift, a player hears a different
   recording depending on which path answered, and nobody would notice for
   weeks. test/pickparity.js extracts BOTH copies and runs them over the same
   fixtures — it fails on any divergence. Change one, change the other. */
function norm(s){ return (s||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim(); }
function yearOf(releaseDate){ const y = parseInt(String(releaseDate||"").slice(0,4),10); return y||null; }
const BADVER = /karaoke|tribute|made famous|originally performed|as made popular|8[\- ]?bit|lullaby|meditation|piano tribute/i;
// compare on the CORE title: "(feat. …)" / "[Club Mix]" suffixes off. Apple's
// canonical track is often "Title (feat. X)", which never matched exactly and
// could tie with a DIFFERENT same-artist song whose short title is a substring
// (want "I Like to Move It": real "…(feat. The Mad Stuntman)" and other track
// "Move It!" both scored 1 — iTunes result order then decided the audio).
function coreNorm(s){
  return norm(String(s||"")
    .replace(/\(.*?\)|\[.*?\]/g, " ")                 // "(feat. X)" / "[Club Mix]"
    .replace(/\b(feat\.?|ft\.?|featuring)\b.*$/i, " ")); // unbracketed "feat. X" tails
}
// versions that defeat the GAME, not just taste: an instrumental has no voice
// to recognize, sped-up/slowed uploads distort the era. HARD-reject these —
// unless the curated title itself asks for one.
const NOVOCAL = /\b(instrumental|sped[- ]?up|slowed(?:\s*(?:\+|and|&)\s*reverb)?|8d audio|nightcore)\b/i;
// versions that are merely OFF (live, acoustic, covers, remixes): penalized so
// any clean take wins, but still allowed as a last resort — a live cut of the
// right song beats no song. "unless wanted" guard: "Live Is Life" stays fine.
const OFFVER = /\b(live|acoustic|unplugged|demo|remix|cover|re-?recorded|orchestral|reprise|version)\b/i;
// extended / club / 12" mixes: technically the right song, but their 30s preview
// is usually an instrumental build-up — the radio edit's clip lands on the hook.
// Penalized (any shorter cut wins) and reinforced by a track-length preference.
const LONGVER = /\b(extended|club mix|12["”]|dance mix|dub|megamix|long version)\b/i;
function pickBest(results, song){
  const wantT = norm(song.title), wantA = norm(song.artist);
  const wantTC = coreNorm(song.title) || wantT;
  let best=null, bestScore=-1;
  for(const r of results){
    if(!r.previewUrl) continue;
    if(BADVER.test(r.artistName||"") || BADVER.test(r.collectionName||"")) continue;
    if(NOVOCAL.test(r.trackName||"") && !NOVOCAL.test(song.title||"")) continue;
    const t = norm(r.trackName), tc = coreNorm(r.trackName) || t, a = norm(r.artistName);
    let tScore = 0, aScore = 0;
    if(t===wantT || tc===wantTC) tScore = 3;
    else if(t.includes(wantT)||tc.includes(wantTC)) tScore = 1;             // result extends want: mixes/edits
    else if((wantT.includes(t)||wantTC.includes(tc)) && tc.length >= wantTC.length*0.7) tScore = 1;
    // reverse containment (result much SHORTER than want) is a wrong-song
    // vector — "Move It!" ⊂ "I Like to Move It" — so it needs ≥70% length
    if(a===wantA) aScore = 2; else if(a.includes(wantA)||wantA.includes(a)) aScore = 1;
    // BOTH must match at least partially — artist-only allowed wrong-song swaps.
    // Skipping is always better than playing the wrong song.
    if(tScore===0 || aScore===0) continue;
    // prefer releases from the curated era: original single/album beats a
    // "(2010 Mixes)" reissue or sped-up upload when the text scores tie
    const ry = yearOf(r.releaseDate);
    const yBonus = (ry && song.year && Math.abs(ry - song.year) <= 3) ? 1 : 0;
    const offPenalty = (OFFVER.test(r.trackName||"") && !OFFVER.test(song.title||"")) ? 2 : 0;
    const longPenalty = (LONGVER.test(r.trackName||"") && !LONGVER.test(song.title||"")) ? 2 : 0;
    // radio-single length (~2:20–5:30) gives the best clip; long 12"/album cuts
    // (>6 min) usually preview an instrumental section. Nudge, don't dictate.
    const ms = r.trackTimeMillis || 0;
    const lenScore = ms ? (ms >= 140000 && ms <= 330000 ? 1 : ms > 390000 ? -1 : 0) : 0;
    const score = tScore + aScore + yBonus + lenScore - offPenalty - longPenalty;
    if(score>bestScore){ bestScore=score; best=r; }
  }
  return best;
}

/* ---------- iTunes lookup proxy + shared cache ----------
   Apple rate-limits its Search API per CLIENT IP. iCloud Private Relay and
   carrier CGNAT put thousands of phones behind a single egress IP, so a player
   who has looked up nothing can be blocked before their first song — which is
   exactly what an iPhone tester hit on the daily, over and over.
   Going through the Worker fixes both halves at once: Apple sees our IP, and
   every answer is cached for EVERYONE. The daily is the same five songs
   worldwide, so it costs five lookups per TTL globally instead of five per
   player. Clients keep the direct JSONP path as a fallback, so this can only
   add a route to success, never remove one. */
const PV_TTL_MS = 7 * 864e5;        // resolved records: Apple's preview URLs rot
const PV_MISS_TTL_MS = 10 * 60e3;   // never bake in an empty caused by a throttle
const PV_FIELDS = ["trackId","trackName","artistName","collectionName","releaseDate","previewUrl","trackViewUrl","trackTimeMillis"];

// null = we could not reach Apple (client should try direct); [] = Apple
// answered but nothing usable. The difference matters: one is our problem.
async function itunesFetch(url){
  try{
    const r = await fetch(url, { headers: { "User-Agent": "Yearworm/1.0 (+https://playyearworm.com)" } });
    if(!r.ok) return null;
    const b = await r.json();
    return ((b && b.results) || []).map(x => {
      const o = {}; for(const f of PV_FIELDS) if(x[f] != null) o[f] = x[f];
      return o;
    }).filter(x => x.previewUrl);
  }catch(e){ return null; }
}
async function pvCachePut(env, key, results){
  try{
    await env.DB.prepare("INSERT INTO previews (term, json, at) VALUES (?1,?2,?3) " +
      "ON CONFLICT(term) DO UPDATE SET json=excluded.json, at=excluded.at")
      .bind(key, JSON.stringify(results), Date.now()).run();
  }catch(e){}
}
async function deadSet(env, ids){
  const out = new Set();
  if(!ids.length) return out;
  try{
    const ph = ids.map((_, i) => "?" + (i + 1)).join(",");
    for(const r of ((await env.DB.prepare("SELECT track_id FROM dead_ids WHERE track_id IN (" + ph + ")").bind(...ids).all()).results || []))
      out.add(r.track_id);
  }catch(e){}
  return out;
}
// Resolve a search term to Apple records. Order: fresh cache → PINNED track (one
// cheap record, and a FRESH preview url, which is why pinning also fixes clips
// that rot mid-TTL) → full search.
async function resolveTerm(env, term, limit){
  const key = term.toLowerCase().slice(0, 120);
  const lim = Math.min(Math.max(parseInt(limit, 10) || 8, 1), 15);
  let pin = null;
  try{ const p = await env.DB.prepare("SELECT track_id FROM pins WHERE term=?1").bind(key).first(); pin = p && p.track_id; }catch(e){}

  try{
    const row = await env.DB.prepare("SELECT json, at FROM previews WHERE term=?1").bind(key).first();
    if(row){
      const cached = JSON.parse(row.json || "[]");
      const age = Date.now() - (row.at || 0);
      if(age < (cached.length ? PV_TTL_MS : PV_MISS_TTL_MS)) return { ok: true, results: cached, pin };
    }
  }catch(e){ /* table not migrated yet — fall through to a live lookup */ }

  if(pin){
    const got = await itunesFetch("https://itunes.apple.com/lookup?id=" + encodeURIComponent(pin));
    if(got === null) return { ok: false, results: [], pin };
    if(got.length){ await pvCachePut(env, key, got); return { ok: true, results: got, pin }; }
    // the pinned track is gone. Record it BEFORE re-searching, or the search
    // picks the same dead track again and re-pins it — a fresh failure for
    // every player, forever.
    try{ await env.DB.prepare("INSERT OR IGNORE INTO dead_ids (track_id, at) VALUES (?1,?2)").bind(pin, Date.now()).run(); }catch(e){}
    try{ await env.DB.prepare("DELETE FROM pins WHERE term=?1").bind(key).run(); }catch(e){}
    pin = null;
  }

  const res = await itunesFetch("https://itunes.apple.com/search?media=music&entity=song&limit=" + lim +
    "&term=" + encodeURIComponent(term));
  if(res === null) return { ok: false, results: [], pin };
  await pvCachePut(env, key, res);
  return { ok: true, results: res, pin };
}
// The whole endpoint: resolve, then CHOOSE — and remember the choice.
async function lookupSong(env, term, song, limit){
  const r = await resolveTerm(env, term, limit);
  if(!r.ok) return { ok: false, pick: null, results: [] };
  if(!song) return { ok: true, pick: null, results: r.results };   // older client: raw list, as before
  const key = term.toLowerCase().slice(0, 120);
  // an existing pin decides, so the answer can't drift when Apple reshuffles
  let pick = r.pin ? (r.results.find(x => x.trackId === r.pin) || null) : null;
  if(!pick){
    const dead = await deadSet(env, r.results.map(x => x.trackId).filter(x => x != null));
    pick = pickBest(dead.size ? r.results.filter(x => !dead.has(x.trackId)) : r.results, song);
    if(pick && pick.trackId != null) try{
      await env.DB.prepare("INSERT INTO pins (term, track_id, at) VALUES (?1,?2,?3) " +
        "ON CONFLICT(term) DO UPDATE SET track_id=excluded.track_id, at=excluded.at")
        .bind(key, pick.trackId, Date.now()).run();
    }catch(e){}
  }
  return { ok: true, pick, results: pick ? [pick] : [] };
}

async function board(env, day, device, cors){
  // avatar rides along when the scoring device belongs to a claimed profile —
  // the world board shows real faces, not just initials. Wrapped fallback keeps
  // the board alive on a database without the avatar column.
  let top;
  try{
    // u.id rides along so the board can offer "add friend" — with a handful of
    // players, seeing someone score and adding them on the spot beats asking
    // them for a code. Anonymous rows (no claimed profile) simply carry no id.
    top = (await env.DB.prepare(
      "SELECT s.nick, s.score, s.time_ms, u.avatar, u.id AS uid FROM scores s " +
      "LEFT JOIN devices d ON d.device = s.device LEFT JOIN users u ON u.id = d.user_id " +
      "WHERE s.day=?1 ORDER BY s.score DESC, s.time_ms ASC, s.created ASC LIMIT " + TOP_N
    ).bind(day).all()).results || [];
  }catch(e){
    top = (await env.DB.prepare(
      "SELECT nick, score, time_ms FROM scores WHERE day=?1 ORDER BY score DESC, time_ms ASC, created ASC LIMIT " + TOP_N
    ).bind(day).all()).results || [];
  }
  const total = (await env.DB.prepare("SELECT COUNT(*) AS n FROM scores WHERE day=?1").bind(day).first()).n;
  let me = null;
  if(device){
    const row = await env.DB.prepare("SELECT nick, score, time_ms, created FROM scores WHERE day=?1 AND device=?2")
      .bind(day, device).first();
    if(row){
      const better = (await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM scores WHERE day=?1 AND (score>?2 OR (score=?2 AND time_ms<?3) OR (score=?2 AND time_ms=?3 AND created<?4))"
      ).bind(day, row.score, row.time_ms, row.created).first()).n;
      me = { nick: row.nick, score: row.score, timeMs: row.time_ms, rank: better + 1 };
    }
  }
  return json({ day, total, me,
    top: top.map(r => ({ nick: r.nick, score: r.score, timeMs: r.time_ms, avatar: r.avatar || null, id: r.uid || null })) }, 200, cors);
}

// World survival board for a WINDOW — today, or the rolling 7 days. Deliberately
// never all-time: survival has unlimited attempts, so an all-time world board
// rewards whoever grinds longest and then stays frozen forever, while a window
// puts everyone back on the start line. Only sscores rows count, and the client
// only submits those for built-in decks, so a custom deck can't buy a rank.
async function sboard(env, win, device, cors){
  const days = win === 7 ? 7 : 1, from = dayNow() - (days - 1);
  let rows = [], total = 0, me = null;
  try{
    rows = (await env.DB.prepare(
      "SELECT u.id AS uid, u.handle, u.avatar, MAX(s.score) sc, MIN(s.created) first FROM sscores s " +
      "JOIN users u ON u.id = s.user_id WHERE s.day >= ?1 " +
      "GROUP BY s.user_id ORDER BY sc DESC, first ASC LIMIT " + TOP_N
    ).bind(from).all()).results || [];
    total = ((await env.DB.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM sscores WHERE day >= ?1").bind(from).first()) || {}).n || 0;
    if(device){
      const u = await userByDevice(env, device);
      if(u){
        const mine = await env.DB.prepare("SELECT MAX(score) AS sc FROM sscores WHERE day >= ?1 AND user_id = ?2").bind(from, u.id).first();
        const sc = (mine && mine.sc) || 0;
        if(sc > 0){
          const better = ((await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM (SELECT user_id, MAX(score) AS m FROM sscores WHERE day >= ?1 GROUP BY user_id) t WHERE t.m > ?2"
          ).bind(from, sc).first()) || {}).n || 0;
          me = { nick: u.handle, score: sc, rank: better + 1 };
        }
      }
    }
  }catch(e){ /* sscores/avatar not migrated yet → empty board, never a 500 */ }
  return json({ win: days, total, me,
    top: rows.map(r => ({ nick: r.handle, score: r.sc, avatar: r.avatar || null, id: r.uid || null })) }, 200, cors);
}

const SET_RE = /^\d+(\.\d+){1,8}$/;   // pool indices joined with dots (anchor + up to 8)
const DEVICE_RE = /^[a-f0-9]{16,64}$/i;

/* ---------- social: users, friends, direct challenges ---------- */
const HANDLE_RE = /^[\p{L}\p{N}][\p{L}\p{N} _\-.]{1,18}[\p{L}\p{N}]$/u;   // 3–20 chars, no edge junk
// avatar token: a generated-avatar id (m:NN) or a short legacy emoji. The emoji
// branch requires non-ASCII code points only — never <>&"' or other HTML-relevant
// characters, so nothing attacker-shaped is stored and redistributed to friends.
const AVATAR_RE = /^(m:\d{1,3}|[^\x00-\x7F]{1,8})$/u;
function validAvatar(v){ v = String(v == null ? "" : v); return AVATAR_RE.test(v) ? v : null; }
function friendCode(){
  const A = "ABCDEFGHJKMNPQRSTVWXYZ23456789";   // no 0/O/1/I/L/U lookalikes
  let s = ""; for(let i=0;i<6;i++) s += A[Math.floor(Math.random()*A.length)];
  return "YW-" + s;
}
function randId(){
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map(x=>x.toString(16).padStart(2,"0")).join("");
}
const pair = (u1, u2) => u1 < u2 ? [u1, u2] : [u2, u1];

/* ---------- Google Sign-In (dark until GOOGLE_CLIENT_ID is set) ----------
   The client sends the Google ID token (a JWT); we verify it against
   Google's published keys — signature, issuer, audience, expiry — and use
   the stable `sub` as the account key. */
let _jwks = null, _jwksAt = 0;
async function googleKeys(){
  if(_jwks && _jwks.length && Date.now() - _jwksAt < 3600e3) return _jwks;
  try{
    const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
    if(!r.ok) return _jwks || [];        // don't cache a failure for an hour
    const b = await r.json();
    if(b && Array.isArray(b.keys) && b.keys.length){ _jwks = b.keys; _jwksAt = Date.now(); }
    return _jwks || [];
  }catch(e){ return _jwks || []; }
}
function b64uToBytes(s){
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while(s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------- Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) ----------
   Crypto verified against the `web-push` library (encrypt/decrypt round-trip
   and VAPID signature). Needs env.VAPID_PRIVATE (PKCS8 base64) + VAPID_PUBLIC
   (b64url, 65-byte point) + VAPID_SUBJECT (mailto:). Absent → push is a no-op. */
const PUSH_ENC = new TextEncoder();
function bytesToB64u(b){ b = new Uint8Array(b); let s = ""; for(const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function pushCat(...as){ let n = 0; for(const a of as) n += a.length; const o = new Uint8Array(n); let i = 0; for(const a of as){ o.set(a, i); i += a.length; } return o; }
async function pushHkdf(salt, ikm, info, len){
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name:"HKDF", hash:"SHA-256", salt, info }, key, len * 8));
}
async function pushEncrypt(uaPubB64u, authB64u, payloadStr){
  const uaPub = b64uToBytes(uaPubB64u), auth = b64uToBytes(authB64u);
  const eph = await crypto.subtle.generateKey({ name:"ECDH", namedCurve:"P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name:"ECDH", namedCurve:"P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name:"ECDH", public:uaKey }, eph.privateKey, 256));
  const ikm = await pushHkdf(auth, secret, pushCat(PUSH_ENC.encode("WebPush: info\0"), uaPub, asPub), 32);
  const cek = await pushHkdf(salt, ikm, PUSH_ENC.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await pushHkdf(salt, ikm, PUSH_ENC.encode("Content-Encoding: nonce\0"), 12);
  const aesKey = await crypto.subtle.importKey("raw", cek, { name:"AES-GCM" }, false, ["encrypt"]);
  const record = pushCat(PUSH_ENC.encode(payloadStr), new Uint8Array([2]));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name:"AES-GCM", iv:nonce, tagLength:128 }, aesKey, record));
  return pushCat(salt, new Uint8Array([0,0,0x10,0]), new Uint8Array([asPub.length]), asPub, ct);
}
async function vapidAuthHeader(endpoint, env){
  const aud = new URL(endpoint).origin;
  const header = bytesToB64u(PUSH_ENC.encode(JSON.stringify({ typ:"JWT", alg:"ES256" })));
  const now = Math.floor(Date.now() / 1000);
  const payload = bytesToB64u(PUSH_ENC.encode(JSON.stringify({ aud, exp: now + 12 * 3600, sub: env.VAPID_SUBJECT || "mailto:contact@playyearworm.com" })));
  const signingInput = header + "." + payload;
  const pk = Uint8Array.from(atob(env.VAPID_PRIVATE), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", pk, { name:"ECDSA", namedCurve:"P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name:"ECDSA", hash:"SHA-256" }, key, PUSH_ENC.encode(signingInput)));
  return "vapid t=" + signingInput + "." + bytesToB64u(sig) + ", k=" + env.VAPID_PUBLIC;
}
// send one push; returns the push service's HTTP status. 404/410 = the
// subscription is dead and should be pruned; 403 = it was created with a
// DIFFERENT VAPID public key than the one we sign with (i.e. it predates a key
// rotation) and can never receive our pushes again — also unusable. Callers use
// pushDead() rather than testing statuses by hand.
const pushDead = st => st === 404 || st === 410 || st === 403;
async function sendWebPush(env, sub, payloadStr){
  const body = await pushEncrypt(sub.p256dh, sub.auth, payloadStr);
  const r = await fetch(sub.endpoint, { method:"POST", headers:{
    "Authorization": await vapidAuthHeader(sub.endpoint, env),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    "TTL": "86400",
  }, body });
  return r.status;
}
// non-secret diagnostic for /health: are the VAPID keys present, and do the
// private (secret) and public (advertised in the app) form a MATCHING pair?
async function vapidStatus(env){
  const out = { configured: !!(env.VAPID_PRIVATE && env.VAPID_PUBLIC) };
  if(!out.configured) return out;
  try{
    const pk = Uint8Array.from(atob(env.VAPID_PRIVATE), c => c.charCodeAt(0));
    const priv = await crypto.subtle.importKey("pkcs8", pk, { name:"ECDSA", namedCurve:"P-256" }, false, ["sign"]);
    const pub = await crypto.subtle.importKey("raw", b64uToBytes(env.VAPID_PUBLIC), { name:"ECDSA", namedCurve:"P-256" }, false, ["verify"]);
    const msg = PUSH_ENC.encode("vapid-selftest");
    const sig = await crypto.subtle.sign({ name:"ECDSA", hash:"SHA-256" }, priv, msg);
    out.match = await crypto.subtle.verify({ name:"ECDSA", hash:"SHA-256" }, pub, sig, msg);
  }catch(e){ out.match = false; }
  return out;
}
// push a notification to every device a user has registered (best-effort, wrapped)
async function pushToUser(env, userId, payloadObj){
  if(!env.VAPID_PRIVATE || !env.VAPID_PUBLIC || !userId) return;
  try{
    const subs = ((await env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id=?1 LIMIT 20").bind(userId).all()).results) || [];
    const payload = JSON.stringify(payloadObj);
    for(const s of subs){
      try{ if(pushDead(await sendWebPush(env, s, payload)))
        await env.DB.prepare("DELETE FROM push_subs WHERE endpoint=?1").bind(s.endpoint).run(); }
      catch(e){ /* one dead endpoint shouldn't stop the rest */ }
    }
  }catch(e){ /* push_subs not migrated yet, or DB hiccup — never block the action */ }
}
async function verifyGoogleToken(cred, clientId){
  const parts = String(cred || "").split(".");
  if(parts.length !== 3) return null;
  let header, payload;
  try{
    header = JSON.parse(new TextDecoder().decode(b64uToBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64uToBytes(parts[1])));
  }catch(e){ return null; }
  if(header.alg !== "RS256") return null;
  if(payload.aud !== clientId) return null;
  if(payload.iss !== "accounts.google.com" && payload.iss !== "https://accounts.google.com") return null;
  if(!payload.exp || payload.exp * 1000 < Date.now()) return null;
  const jwk = (await googleKeys()).find(k => k.kid === header.kid);
  if(!jwk) return null;
  try{
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key,
      b64uToBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
    return ok ? payload : null;
  }catch(e){ return null; }
}
async function freeHandle(env, base){
  base = String(base || "").replace(/[^\p{L}\p{N} _\-.]/gu, "").replace(/\s+/g, " ").trim().slice(0, 16);
  if(base.length < 3) base = "Player";
  for(let n = 0; n < 100; n++){
    const h = n === 0 ? base : base + " " + (n + 1);
    if(!HANDLE_RE.test(h)) continue;
    const taken = await env.DB.prepare("SELECT id FROM users WHERE handle_lc=?1").bind(h.toLowerCase()).first();
    if(!taken) return h;
  }
  return "Player " + Math.floor(Math.random() * 100000);
}

async function userByDevice(env, device){
  return env.DB.prepare(
    "SELECT u.id, u.handle, u.code FROM devices d JOIN users u ON u.id = d.user_id WHERE d.device=?1"
  ).bind(device).first();
}
async function socialState(env, me, cors){
  const rows = (await env.DB.prepare(
    "SELECT a, b, requester, status FROM friends WHERE a=?1 OR b=?1"
  ).bind(me.id).all()).results || [];
  const ids = [...new Set(rows.map(r => r.a === me.id ? r.b : r.a))];
  const named = {};
  for(const id of ids.slice(0, 100)){
    const u = await env.DB.prepare("SELECT id, handle FROM users WHERE id=?1").bind(id).first();
    if(u) named[id] = u.handle;
  }
  // profile pictures for those users, one batched query. Wrapped so a server
  // running before the `avatar` column migration simply returns no avatars.
  const avatars = {}, bests = {};
  const capIds = ids.slice(0, 100);
  if(capIds.length){ try{
    const q = "SELECT id, avatar FROM users WHERE id IN (" + capIds.map((_, i) => "?" + (i + 1)).join(",") + ")";
    for(const r of ((await env.DB.prepare(q).bind(...capIds).all()).results || [])) if(r.avatar) avatars[r.id] = r.avatar;
  }catch(e){} }
  // survival/turbo bests, same shape — separate try so a server without the
  // sbest/tbest columns still returns avatars
  if(capIds.length){ try{
    const q = "SELECT id, sbest, tbest FROM users WHERE id IN (" + capIds.map((_, i) => "?" + (i + 1)).join(",") + ")";
    for(const r of ((await env.DB.prepare(q).bind(...capIds).all()).results || [])) bests[r.id] = { s: r.sbest || 0, t: r.tbest || 0 };
  }catch(e){} }
  // survival daily (today) + rolling-7-day best, per friend AND me
  const sToday = {}, s7 = {}, today = dayNow(), wkFrom = today - 6;
  const winIds = capIds.concat([me.id]);
  if(winIds.length){ try{
    const ph = winIds.map((_, i) => "?" + (i + 2)).join(",");
    for(const r of ((await env.DB.prepare("SELECT user_id, MAX(score) sc FROM sscores WHERE day=?1 AND user_id IN (" + ph + ") GROUP BY user_id").bind(today, ...winIds).all()).results || [])) sToday[r.user_id] = r.sc || 0;
    for(const r of ((await env.DB.prepare("SELECT user_id, MAX(score) sc FROM sscores WHERE day>=?1 AND user_id IN (" + ph + ") GROUP BY user_id").bind(wkFrom, ...winIds).all()).results || [])) s7[r.user_id] = r.sc || 0;
  }catch(e){} }
  // head-to-head duel tallies per friend, from my perspective (w = my wins),
  // plus a rolling last-7-days window and the most recent duels for the
  // friend-detail sheet
  const drows = (await env.DB.prepare(
    "SELECT a, b, winner, score_a, score_b, created FROM duels WHERE a=?1 OR b=?1 ORDER BY created DESC"
  ).bind(me.id).all()).results || [];
  const week = Date.now() - 7 * 864e5;
  const tally = {};
  for(const d of drows){
    const other = d.a === me.id ? d.b : d.a;
    const t = tally[other] || (tally[other] = { w:0, l:0, t:0, w7:0, l7:0, t7:0, recent:[] });
    const res = d.winner === me.id ? "w" : d.winner === other ? "l" : "t";
    t[res]++;
    if(d.created >= week) t[res + "7"]++;
    if(t.recent.length < 6) t.recent.push({
      r: res,
      mine: d.a === me.id ? d.score_a : d.score_b,
      theirs: d.a === me.id ? d.score_b : d.score_a,
      at: d.created
    });
  }
  // outgoingIds, not just a count: the boards' "add friend" button has to show
  // "asked" for someone you already requested, including after a reload
  const friends = [], requests = [], outgoingIds = []; let outgoing = 0;
  for(const r of rows){
    const other = r.a === me.id ? r.b : r.a;
    if(!(other in named)) continue;
    if(r.status === "accepted"){
      const t = tally[other] || { w:0, l:0, t:0, w7:0, l7:0, t7:0, recent:[] };
      const pb = bests[other] || {};
      friends.push({ id: other, handle: named[other], avatar: avatars[other] || null, w: t.w, l: t.l, t: t.t,
                     w7: t.w7, l7: t.l7, t7: t.t7, recent: t.recent, sbest: pb.s || 0, tbest: pb.t || 0,
                     sday: sToday[other] || 0, s7: s7[other] || 0 });
    }
    else if(r.requester === me.id){ outgoing++; outgoingIds.push(other); }
    else requests.push({ id: other, handle: named[other], avatar: avatars[other] || null });
  }
  const inbox = ((await env.DB.prepare(
    "SELECT id, from_user, kind, payload, created FROM inbox WHERE to_user=?1 AND seen=0 ORDER BY created DESC LIMIT 20"
  ).bind(me.id).all()).results || []).map(m => ({
    id: m.id, from: m.from_user, handle: named[m.from_user] || "?", avatar: avatars[m.from_user] || null, kind: m.kind,
    payload: (()=>{ try{ return JSON.parse(m.payload); }catch(e){ return {}; } })(), created: m.created
  }));
  // inbox senders might not be resolved yet (named only covers friend rows)
  for(const m of inbox){
    if(m.handle === "?"){
      const u = await env.DB.prepare("SELECT handle FROM users WHERE id=?1").bind(m.from).first();
      if(u) m.handle = u.handle;
    }
  }
  const linked = await env.DB.prepare("SELECT user_id FROM logins WHERE user_id=?1 LIMIT 1").bind(me.id).first();
  let myAv = null; try{ const a = await env.DB.prepare("SELECT avatar FROM users WHERE id=?1").bind(me.id).first(); myAv = a && a.avatar || null; }catch(e){}
  // challenges I sent that the recipient hasn't answered yet — "⏳ waiting" UI
  const sent = [];
  for(const r of ((await env.DB.prepare(
    "SELECT to_user, created FROM inbox WHERE from_user=?1 AND kind='challenge' AND seen=0 ORDER BY created DESC LIMIT 20"
  ).bind(me.id).all()).results || [])){
    let h = named[r.to_user];
    if(!h){ const u = await env.DB.prepare("SELECT handle FROM users WHERE id=?1").bind(r.to_user).first(); h = u && u.handle; }
    if(h) sent.push({ to: r.to_user, handle: h, at: r.created });
  }
  // id rides along so share links can carry WHO sent them (receiver matches it
  // against their friends list to enable react-back on link-played duels)
  return json({ me: { id: me.id, handle: me.handle, code: me.code, linked: !!linked, avatar: myAv,
    sday: sToday[me.id] || 0, s7: s7[me.id] || 0 }, friends, requests, outgoing, outgoingIds, inbox, sent }, 200, cors);
}
async function handleSocialPost(env, b, cors, ctx){
  // schedule a push without delaying the response (falls back to inline await)
  const push = (userId, payload) => { const p = pushToUser(env, userId, payload); if(ctx && ctx.waitUntil) ctx.waitUntil(p); return p; };
  const device = String(b.device || "");
  if(!DEVICE_RE.test(device)) return json({ error: "bad device" }, 400, cors);
  const action = String(b.action || "");
  let me = await userByDevice(env, device);

  // keep the caller's profile picture fresh on every state/claim/etc. Wrapped so
  // a server deployed before the `avatar` column migration can't 500 on it.
  const av = validAvatar(b.avatar);
  if(me && av){ try{ await env.DB.prepare("UPDATE users SET avatar=?1 WHERE id=?2").bind(av, me.id).run(); }catch(e){} }
  // personal bests ride along the same way (friends-level survival/turbo board).
  // MAX() server-side: a device with a stale local best can never downgrade the
  // account's number, and the caps keep absurd client-submitted values out.
  const sb = parseInt(b.sbest, 10), tb = parseInt(b.tbest, 10);
  if(me && Number.isFinite(sb) && sb > 0){ try{ await env.DB.prepare("UPDATE users SET sbest=MAX(COALESCE(sbest,0),?1) WHERE id=?2").bind(Math.min(sb, 999), me.id).run(); }catch(e){} }
  if(me && Number.isFinite(tb) && tb > 0){ try{ await env.DB.prepare("UPDATE users SET tbest=MAX(COALESCE(tbest,0),?1) WHERE id=?2").bind(Math.min(tb, RUN_LEN), me.id).run(); }catch(e){} }

  if(action === "claim"){
    const handle = String(b.handle || "").replace(/\s+/g, " ").trim();
    if(!HANDLE_RE.test(handle)) return json({ error: "bad handle" }, 400, cors);
    const taken = await env.DB.prepare("SELECT id FROM users WHERE handle_lc=?1").bind(handle.toLowerCase()).first();
    if(me){
      if(taken && taken.id !== me.id) return json({ error: "handle taken" }, 409, cors);
      await env.DB.prepare("UPDATE users SET handle=?1, handle_lc=?2 WHERE id=?3")
        .bind(handle, handle.toLowerCase(), me.id).run();
      me.handle = handle;
      return socialState(env, me, cors);
    }
    if(taken) return json({ error: "handle taken" }, 409, cors);
    const id = randId(), code = friendCode();
    await env.DB.prepare("INSERT INTO users (id, handle, handle_lc, code, created) VALUES (?1,?2,?3,?4,?5)")
      .bind(id, handle, handle.toLowerCase(), code, Date.now()).run();
    await env.DB.prepare("INSERT INTO devices (device, user_id, created) VALUES (?1,?2,?3) ON CONFLICT(device) DO UPDATE SET user_id=excluded.user_id")
      .bind(device, id, Date.now()).run();
    me = { id, handle, code };
    if(av){ try{ await env.DB.prepare("UPDATE users SET avatar=?1 WHERE id=?2").bind(av, id).run(); }catch(e){} }
    return socialState(env, me, cors);
  }

  if(action === "state"){
    // POST twin of GET /social — keeps the device token out of URL/proxy logs
    if(!me) return json({ me: null }, 200, cors);
    return socialState(env, me, cors);
  }

  if(!me) return json({ error: "no profile" }, 401, cors);

  if(action === "add"){
    const code = String(b.code || "").trim().toUpperCase();
    const other = await env.DB.prepare("SELECT id, handle FROM users WHERE code=?1").bind(code).first();
    if(!other) return json({ error: "code not found" }, 404, cors);
    if(other.id === me.id) return json({ error: "that is your own code" }, 400, cors);
    const [a, bb] = pair(me.id, other.id);
    const ex = await env.DB.prepare("SELECT requester, status FROM friends WHERE a=?1 AND b=?2").bind(a, bb).first();
    if(ex){
      // legacy pending rows (from the old request flow) resolve on any re-add
      if(ex.status === "pending")
        await env.DB.prepare("UPDATE friends SET status='accepted' WHERE a=?1 AND b=?2").bind(a, bb).run();
      // already friends: fine, fall through to state
    } else {
      // adding by code IS mutual consent — the code owner shared it, so no
      // accept round-trip: instant friendship + a courtesy note in their inbox
      await env.DB.prepare("INSERT INTO friends (a, b, requester, status, created) VALUES (?1,?2,?3,'accepted',?4)")
        .bind(a, bb, me.id, Date.now()).run();
      await env.DB.prepare("INSERT INTO inbox (to_user, from_user, kind, payload, created) VALUES (?1,?2,'friend',?3,?4)")
        .bind(other.id, me.id, "{}", Date.now()).run();
      push(other.id, { title: "New friend 🎧", body: me.handle + " added you as a friend", tab: "friends" });
    }
    return socialState(env, me, cors);
  }

  // Find players by name. Matches ANYWHERE in the handle: "pinguin" has to find
  // "TurboPinguin", or the player concludes the search is broken (it did — Sam
  // reported exactly that). Prefix-only was near-useless as an anti-scraping
  // measure anyway: 676 two-letter prefixes enumerate the whole table just as
  // well as substrings do. The real limits are the per-IP rate limiter and the
  // cap of 8 — and handles are already public on the world daily board.
  // Prefix matches still rank first, because that IS what you usually mean.
  if(action === "find"){
    const q = String(b.q || "").trim().replace(/\s+/g, " ").slice(0, 20);
    if(q.length < 2) return json({ results: [] }, 200, cors);
    const lk = s => s.replace(/[%_\\]/g, m => "\\" + m);
    // Search each WORD separately and accept any of them. You know someone as
    // "Carmen Sophie" but she claimed just "Carmen" — one substring over the
    // whole query finds nothing there, which is exactly how this got reported.
    // Words of one letter are dropped: they'd match half the table.
    let terms = q.split(" ").filter(t => t.length >= 2);
    if(!terms.length) terms = [q];
    terms = terms.slice(0, 3);
    const n = terms.length;
    const like = i => "handle LIKE ?" + (i + 1) + " ESCAPE '\\'";
    const where = terms.map((_, i) => like(i)).join(" OR ");
    // rank: most words matched first, then whoever starts with what you typed
    const score = terms.map((_, i) => "(CASE WHEN " + like(i) + " THEN 1 ELSE 0 END)").join(" + ");
    const sel = (cols) => "SELECT " + cols + " FROM users WHERE (" + where + ") AND id <> ?" + (n + 2) +
      " ORDER BY (" + score + ") DESC, (CASE WHEN handle LIKE ?" + (n + 1) + " ESCAPE '\\' THEN 0 ELSE 1 END), handle LIMIT 8";
    const binds = terms.map(t => "%" + lk(t) + "%").concat([lk(q) + "%", me.id]);
    let rows = [];
    try{ rows = (await env.DB.prepare(sel("id, handle, avatar")).bind(...binds).all()).results || []; }
    catch(e){ rows = (await env.DB.prepare(sel("id, handle")).bind(...binds).all()).results || []; }
    // annotate with the existing relationship so the UI offers the right button
    // instead of letting someone re-request a friend they already have
    const rel = {};
    for(const r of rows){
      const [x, y] = pair(me.id, r.id);
      const ex = await env.DB.prepare("SELECT requester, status FROM friends WHERE a=?1 AND b=?2").bind(x, y).first();
      rel[r.id] = !ex ? "none" : ex.status === "accepted" ? "friend"
        : ex.requester === me.id ? "sent" : "incoming";
    }
    return json({ results: rows.map(r => ({ id: r.id, handle: r.handle, avatar: r.avatar || null, rel: rel[r.id] })) }, 200, cors);
  }

  // Ask to be someone's friend. Unlike "add" (by code — sharing your code IS
  // consent) a name search gives no consent at all, so this only ever creates a
  // PENDING row the other player has to accept.
  if(action === "request"){
    const other = await env.DB.prepare("SELECT id, handle FROM users WHERE id=?1").bind(String(b.user || "")).first();
    if(!other) return json({ error: "player not found" }, 404, cors);
    if(other.id === me.id) return json({ error: "that is you" }, 400, cors);
    const [a, bb] = pair(me.id, other.id);
    const ex = await env.DB.prepare("SELECT requester, status FROM friends WHERE a=?1 AND b=?2").bind(a, bb).first();
    if(!ex){
      await env.DB.prepare("INSERT INTO friends (a, b, requester, status, created) VALUES (?1,?2,?3,'pending',?4)")
        .bind(a, bb, me.id, Date.now()).run();
      push(other.id, { title: "Friend request 🎧", body: me.handle + " wants to be friends", tab: "friends" });
    } else if(ex.status === "pending" && ex.requester !== me.id){
      // they asked first — our "request" is really an accept
      await env.DB.prepare("UPDATE friends SET status='accepted' WHERE a=?1 AND b=?2").bind(a, bb).run();
    }
    return socialState(env, me, cors);
  }

  if(action === "srun"){
    // a survival run finished — record today's score for the daily/7-day boards
    const sc = Math.min(999, Math.max(0, parseInt(b.score, 10) || 0));
    if(sc > 0){
      try{ await env.DB.prepare("INSERT INTO sscores (day, user_id, score, created) VALUES (?1,?2,?3,?4)")
        .bind(dayNow(), me.id, sc, Date.now()).run(); }catch(e){}
      try{ await env.DB.prepare("UPDATE users SET sbest=MAX(COALESCE(sbest,0),?1) WHERE id=?2").bind(sc, me.id).run(); }catch(e){}
    }
    return socialState(env, me, cors);
  }

  if(action === "accept" || action === "decline" || action === "remove"){
    const other = String(b.user || "");
    const [a, bb] = pair(me.id, other);
    if(action === "accept"){
      const ex = await env.DB.prepare("SELECT requester, status FROM friends WHERE a=?1 AND b=?2").bind(a, bb).first();
      if(ex && ex.status === "pending" && ex.requester !== me.id)
        await env.DB.prepare("UPDATE friends SET status='accepted' WHERE a=?1 AND b=?2").bind(a, bb).run();
    } else {
      await env.DB.prepare("DELETE FROM friends WHERE a=?1 AND b=?2").bind(a, bb).run();
    }
    return socialState(env, me, cors);
  }

  if(action === "challenge"){
    const to = String(b.to || "");
    const set = String(b.set || "");
    const score = parseInt(b.score, 10);
    // clamp like /daily and /chal do — no negative/absurd times into the tie-break
    const timeMs = Math.min(RUN_LEN * 70000, Math.max(0, parseInt(b.timeMs, 10) || 0));
    if(!SET_RE.test(set)) return json({ error: "bad set" }, 400, cors);
    if(!Number.isFinite(score) || score < 0 || score > RUN_LEN) return json({ error: "bad score" }, 400, cors);
    const [a, bb] = pair(me.id, to);
    const fr = await env.DB.prepare("SELECT status FROM friends WHERE a=?1 AND b=?2").bind(a, bb).first();
    if(!fr || fr.status !== "accepted") return json({ error: "not a friend" }, 403, cors);
    await env.DB.prepare("INSERT INTO inbox (to_user, from_user, kind, payload, created) VALUES (?1,?2,'challenge',?3,?4)")
      .bind(to, me.id, JSON.stringify({ set, score, timeMs }), Date.now()).run();
    push(to, { title: "You've been challenged ⚔️", body: me.handle + " challenged you — beat " + score + "/" + RUN_LEN, tab: "friends" });
    return socialState(env, me, cors);
  }

  if(action === "react"){
    // structured reactions only — a fixed set (emoji + quick phrases), no free text ever
    const REACTIONS = ["🔥","😱","😂","👏","🎯","🤯","💀","🐐","GG","Rematch?","So close!","Lucky 🍀"];
    const to = String(b.to || "");
    const emoji = String(b.emoji || "");
    const score = Number.isFinite(parseInt(b.score, 10)) ? parseInt(b.score, 10) : null;
    if(!REACTIONS.includes(emoji)) return json({ error: "bad reaction" }, 400, cors);
    const [a, bb] = pair(me.id, to);
    const fr = await env.DB.prepare("SELECT status FROM friends WHERE a=?1 AND b=?2").bind(a, bb).first();
    if(!fr || fr.status !== "accepted") return json({ error: "not a friend" }, 403, cors);
    // bundling: if my unseen RESULT for their challenge is still in their inbox,
    // attach the reaction to it — one message ("X played your challenge — 4/5 🔥")
    // instead of two separate rows
    const res = await env.DB.prepare(
      "SELECT id, payload FROM inbox WHERE to_user=?1 AND from_user=?2 AND kind='result' AND seen=0 ORDER BY created DESC LIMIT 1"
    ).bind(to, me.id).first();
    if(res){
      let pay = {}; try{ pay = JSON.parse(res.payload); }catch(e){}
      pay.emoji = emoji;
      await env.DB.prepare("UPDATE inbox SET payload=?1 WHERE id=?2").bind(JSON.stringify(pay), res.id).run();
    } else {
      await env.DB.prepare("INSERT INTO inbox (to_user, from_user, kind, payload, created) VALUES (?1,?2,'react',?3,?4)")
        .bind(to, me.id, JSON.stringify({ emoji, score }), Date.now()).run();
    }
    push(to, { title: me.handle + " reacted " + emoji, body: "on your challenge result", tab: "friends" });
    return socialState(env, me, cors);
  }

  if(action === "result"){
    // opponent finished an inbox challenge: record the duel (first report
    // stands — msg_id is UNIQUE) and tell the challenger how it went
    const msgId = parseInt(b.id, 10);
    const score = parseInt(b.score, 10);
    const timeMs = Math.min(RUN_LEN * 70000, Math.max(0, parseInt(b.timeMs, 10) || 0));
    if(!Number.isFinite(msgId)) return json({ error: "bad id" }, 400, cors);
    if(!Number.isFinite(score) || score < 0 || score > RUN_LEN) return json({ error: "bad score" }, 400, cors);
    const m = await env.DB.prepare(
      "SELECT from_user, kind, payload FROM inbox WHERE id=?1 AND to_user=?2"
    ).bind(msgId, me.id).first();
    if(!m || m.kind !== "challenge") return json({ error: "not found" }, 404, cors);
    let pay = {}; try{ pay = JSON.parse(m.payload); }catch(e){}
    const sa = Number.isFinite(parseInt(pay.score, 10)) ? parseInt(pay.score, 10) : null;
    const ta = parseInt(pay.timeMs, 10) || 0;
    // score first; equal scores fall to the fastest time; else a tie
    const winner = sa == null ? "" :
      score > sa ? me.id : score < sa ? m.from_user :
      (ta && timeMs && timeMs !== ta) ? (timeMs < ta ? me.id : m.from_user) : "";
    const ins = await env.DB.prepare(
      "INSERT OR IGNORE INTO duels (msg_id, a, b, score_a, score_b, time_a, time_b, winner, created) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)"
    ).bind(msgId, m.from_user, me.id, sa, score, ta, timeMs, winner, Date.now()).run();
    if(ins.meta && ins.meta.changes === 0) return socialState(env, me, cors);   // already recorded
    await env.DB.prepare("INSERT INTO inbox (to_user, from_user, kind, payload, created) VALUES (?1,?2,'result',?3,?4)")
      .bind(m.from_user, me.id, JSON.stringify({
        score, timeMs, w: winner === m.from_user ? "you" : winner === me.id ? "them" : "tie"
      }), Date.now()).run();
    push(m.from_user, { title: me.handle + " played your challenge",
      body: (winner === m.from_user ? "You won! " : winner === me.id ? "They beat you — " : "A tie — ") + "they scored " + score + "/" + RUN_LEN, tab: "friends" });
    return socialState(env, me, cors);
  }

  if(action === "seen"){
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(n => parseInt(n, 10)).filter(Number.isFinite).slice(0, 50);
    for(const id of ids)
      await env.DB.prepare("UPDATE inbox SET seen=1 WHERE id=?1 AND to_user=?2").bind(id, me.id).run();
    return socialState(env, me, cors);
  }

  if(action === "push-sub"){
    const s = b.sub || {};
    const endpoint = String(s.endpoint || "");
    const p256dh = String((s.keys && s.keys.p256dh) || "");
    const auth = String((s.keys && s.keys.auth) || "");
    if(!/^https:\/\//.test(endpoint) || endpoint.length > 800 || !p256dh || !auth)
      return json({ error: "bad subscription" }, 400, cors);
    try{
      await env.DB.prepare(
        "INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created) VALUES (?1,?2,?3,?4,?5) " +
        "ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth"
      ).bind(endpoint, me.id, p256dh, auth, Date.now()).run();
    }catch(e){ return json({ error: "push not available" }, 200, cors); }   // table not migrated → soft-ok
    // timezone (minutes east of UTC) for the evening streak-saver nudge —
    // separate statement: the column arrives via the cron's lazy migration
    const tz = parseInt(b.tz, 10);
    if(Number.isFinite(tz) && Math.abs(tz) <= 14 * 60)
      try{ await env.DB.prepare("UPDATE push_subs SET tz=?1 WHERE endpoint=?2").bind(tz, endpoint).run(); }catch(e){}
    return json({ ok: true }, 200, cors);
  }

  // Self-test: push to your OWN devices and report exactly what the push
  // service said. An iPhone has no devtools, so without this a failure is
  // indistinguishable from "nothing happened" — this turns it into a status
  // code the player can read out (403 = stale key, 410 = expired sub, 201 = ok).
  if(action === "push-test"){
    const v = await vapidStatus(env);
    if(!v.configured || !v.match) return json({ ok:false, vapid:v, subs:0, sent:[] }, 200, cors);
    let subs = [];
    try{ subs = ((await env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id=?1 LIMIT 20")
      .bind(me.id).all()).results) || []; }catch(e){}
    const sent = [];
    for(const s of subs){
      let st = 0;
      try{ st = await sendWebPush(env, s, JSON.stringify({ title:"Yearworm test 🔔",
        body:"Notifications work on this device.", tag:"test", tab:"profile" })); }
      catch(e){ st = -1; }
      if(pushDead(st)) try{ await env.DB.prepare("DELETE FROM push_subs WHERE endpoint=?1").bind(s.endpoint).run(); }catch(e){}
      // the host alone (no token) identifies WHICH push service answered
      let host = "?"; try{ host = new URL(s.endpoint).host; }catch(e){}
      sent.push({ status: st, host });
    }
    return json({ ok: sent.some(x => x.status >= 200 && x.status < 300), vapid: v, subs: subs.length, sent }, 200, cors);
  }

  if(action === "push-unsub"){
    // delete by endpoint alone: presenting the (unguessable) endpoint proves you
    // hold the device. Matching user_id too would strand rows after an account
    // switch on the same browser (device now maps to a different user).
    const endpoint = String(b.endpoint || "");
    if(endpoint) try{ await env.DB.prepare("DELETE FROM push_subs WHERE endpoint=?1").bind(endpoint).run(); }catch(e){}
    return json({ ok: true }, 200, cors);
  }

  return json({ error: "bad action" }, 400, cors);
}

async function chalBoardResp(env, setkey, device, cors){
  const rows = (await env.DB.prepare(
    "SELECT nick, score, time_ms, device FROM chals WHERE setkey=?1 ORDER BY score DESC, time_ms ASC, created ASC LIMIT 50"
  ).bind(setkey).all()).results || [];
  return json({ set: setkey, total: rows.length,
    results: rows.map(r => ({ nick: r.nick, score: r.score, timeMs: r.time_ms, you: !!device && r.device === device })) }, 200, cors);
}

export default {
  async fetch(req, env, ctx){
    const url = new URL(req.url);
    const cors = corsHeaders(req.headers.get("Origin"));
    if(req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const ip = req.headers.get("CF-Connecting-IP") || "?";
    // song lookups are cheap, cached, and come in bursts of ten at game start —
    // they get their own budget so they can't starve (or be starved by) the
    // social calls sharing an office/household IP
    const isLookup = url.pathname === "/lookup";
    if(isLookup ? limited(ip, 300, lookupHits) : limited(ip))
      return json({ error: "slow down" }, 429, cors);

    if(isLookup && (req.method === "GET" || req.method === "POST")){
      let term = "", limit = 8, b = null;
      if(req.method === "GET"){ term = url.searchParams.get("term") || ""; limit = url.searchParams.get("limit"); }
      else { try{ b = await req.json(); }catch(e){ b = {}; } term = String(b.term || ""); limit = b.limit; }
      term = term.replace(/\s+/g, " ").trim().slice(0, 120);
      if(!term) return json({ results: [], pick: null, ok: true }, 200, cors);
      // title/artist/year let the SERVER choose the version. A client that
      // sends none (an older cached build) still gets the raw list it expects.
      const song = (b && b.title) ? { title: String(b.title).slice(0,120),
        artist: String(b.artist || "").slice(0,120), year: parseInt(b.year, 10) || null } : null;
      return json(await lookupSong(env, term, song, limit), 200, cors);
    }

    if(url.pathname === "/health") return json({ ok: true, day: dayNow(), vapid: await vapidStatus(env) }, 200, cors);

    if(url.pathname === "/daily" && req.method === "GET"){
      const day = Math.min(Math.max(parseInt(url.searchParams.get("day") || dayNow(), 10) || dayNow(), 1), dayNow() + 1);
      const device = (url.searchParams.get("device") || "").slice(0, 64);
      return board(env, day, /^[a-f0-9]{16,64}$/i.test(device) ? device : null, cors);
    }

    if(url.pathname === "/daily" && req.method === "POST"){
      let b; try{ b = await req.json(); }catch(e){ return json({ error: "bad json" }, 400, cors); }
      // read-only twin of GET: the device token is a bearer credential and must
      // not end up in URL/proxy logs, so board fetches POST {read:1} instead
      if(b.read){
        const rd = Math.min(Math.max(parseInt(b.day, 10) || dayNow(), 1), dayNow() + 1);
        const rdev = String(b.device || "");
        return board(env, rd, /^[a-f0-9]{16,64}$/i.test(rdev) ? rdev : null, cors);
      }
      const day = parseInt(b.day, 10);
      const score = parseInt(b.score, 10);
      const timeMs = parseInt(b.timeMs, 10);
      const device = String(b.device || "");
      if(!Number.isFinite(day) || Math.abs(day - dayNow()) > 1) return json({ error: "bad day" }, 400, cors);
      if(!/^[a-f0-9]{16,64}$/i.test(device)) return json({ error: "bad device" }, 400, cors);
      if(!Number.isFinite(score) || score < 0 || score > RUN_LEN) return json({ error: "bad score" }, 400, cors);
      if(!Number.isFinite(timeMs) || timeMs < 500 || timeMs > RUN_LEN * 70000) return json({ error: "bad time" }, 400, cors);
      const nick = cleanNick(b.nick);
      // first run stands; a resubmit may only refresh the nickname
      await env.DB.prepare(
        "INSERT INTO scores (day, device, nick, score, time_ms, created) VALUES (?1,?2,?3,?4,?5,?6) " +
        "ON CONFLICT(day, device) DO UPDATE SET nick=excluded.nick"
      ).bind(day, device, nick, score, timeMs, Date.now()).run();
      return board(env, day, device, cors);
    }

    // survival world board. GET for convenience; the POST twin exists so the
    // device token (a bearer credential) stays out of URLs and proxy logs.
    if(url.pathname === "/sboard" && (req.method === "GET" || req.method === "POST")){
      let win = 1, dev = "";
      if(req.method === "GET"){
        win = parseInt(url.searchParams.get("win"), 10) === 7 ? 7 : 1;
        dev = (url.searchParams.get("device") || "").slice(0, 64);
      } else {
        let b; try{ b = await req.json(); }catch(e){ b = {}; }
        win = parseInt(b.win, 10) === 7 ? 7 : 1;
        dev = String(b.device || "");
      }
      return sboard(env, win, /^[a-f0-9]{16,64}$/i.test(dev) ? dev : null, cors);
    }

    if(url.pathname === "/chal" && req.method === "GET"){
      const set = url.searchParams.get("set") || "";
      if(!SET_RE.test(set)) return json({ error: "bad set" }, 400, cors);
      const device = (url.searchParams.get("device") || "").slice(0, 64);
      return chalBoardResp(env, set, /^[a-f0-9]{16,64}$/i.test(device) ? device : null, cors);
    }

    if(url.pathname === "/chal" && req.method === "POST"){
      let b; try{ b = await req.json(); }catch(e){ return json({ error: "bad json" }, 400, cors); }
      const set = String(b.set || "");
      if(b.read){   // read-only twin of GET — keeps the device token out of URLs
        if(!SET_RE.test(set)) return json({ error: "bad set" }, 400, cors);
        const rdev = String(b.device || "");
        return chalBoardResp(env, set, /^[a-f0-9]{16,64}$/i.test(rdev) ? rdev : null, cors);
      }
      const score = parseInt(b.score, 10);
      const timeMs = parseInt(b.timeMs, 10);
      const device = String(b.device || "");
      if(!SET_RE.test(set)) return json({ error: "bad set" }, 400, cors);
      if(!/^[a-f0-9]{16,64}$/i.test(device)) return json({ error: "bad device" }, 400, cors);
      if(!Number.isFinite(score) || score < 0 || score > RUN_LEN) return json({ error: "bad score" }, 400, cors);
      if(!Number.isFinite(timeMs) || timeMs < 500 || timeMs > RUN_LEN * 70000) return json({ error: "bad time" }, 400, cors);
      const nick = cleanNick(b.nick);
      // one shot per set per device — first result stands, resubmits refresh the nick
      const existed = await env.DB.prepare("SELECT 1 AS x FROM chals WHERE setkey=?1 AND device=?2").bind(set, device).first();
      await env.DB.prepare(
        "INSERT INTO chals (setkey, device, nick, score, time_ms, created) VALUES (?1,?2,?3,?4,?5,?6) " +
        "ON CONFLICT(setkey, device) DO UPDATE SET nick=excluded.nick"
      ).bind(set, device, nick, score, timeMs, Date.now()).run();
      // notify the set's creator when someone new plays it. The first submitter of
      // a set is treated as its owner (the creator plays their own run first).
      // NOT for the daily (b.daily): the whole world shares that set, so its first
      // finisher would get a push per player. Belt-and-braces: never push once a
      // set has grown beyond friends-scale (a lied-about daily flag stays harmless).
      if(!existed && !b.daily){ try{
        const submitter = await userByDevice(env, device);
        if(submitter) await env.DB.prepare("INSERT OR IGNORE INTO chal_owner (setkey, user_id, created) VALUES (?1,?2,?3)").bind(set, submitter.id, Date.now()).run();
        const owner = await env.DB.prepare("SELECT user_id FROM chal_owner WHERE setkey=?1").bind(set).first();
        if(owner && owner.user_id && (!submitter || submitter.id !== owner.user_id)){
          const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM chals WHERE setkey=?1").bind(set).first();
          if(cnt && cnt.n <= 20){
            const p = pushToUser(env, owner.user_id, { title: nick + " played your challenge 🎯", body: "They scored " + score + "/" + RUN_LEN + " on your set", tab: "play" });
            if(ctx && ctx.waitUntil) ctx.waitUntil(p);
          }
        }
      }catch(e){} }
      return chalBoardResp(env, set, device, cors);
    }

    if(url.pathname === "/push-rotate" && req.method === "POST"){
      // the push service rotated a subscription (sw.js pushsubscriptionchange).
      // Auth = knowledge of the OLD unguessable endpoint URL; we just re-point
      // that row at the new endpoint/keys. No user data returned.
      let b; try{ b = await req.json(); }catch(e){ return json({ error: "bad json" }, 400, cors); }
      const oldEp = String(b.old || "");
      const s = b.sub || {};
      const endpoint = String(s.endpoint || "");
      const p256dh = String((s.keys && s.keys.p256dh) || "");
      const auth = String((s.keys && s.keys.auth) || "");
      if(!/^https:\/\//.test(oldEp) || !/^https:\/\//.test(endpoint) || endpoint.length > 800 || !p256dh || !auth)
        return json({ error: "bad rotate" }, 400, cors);
      try{ await env.DB.prepare("UPDATE push_subs SET endpoint=?1, p256dh=?2, auth=?3 WHERE endpoint=?4")
        .bind(endpoint, p256dh, auth, oldEp).run(); }catch(e){}
      return json({ ok: true }, 200, cors);
    }

    if(url.pathname === "/social" && req.method === "GET"){
      const device = (url.searchParams.get("device") || "").slice(0, 64);
      if(!DEVICE_RE.test(device)) return json({ error: "bad device" }, 400, cors);
      const me = await userByDevice(env, device);
      if(!me) return json({ me: null }, 200, cors);
      return socialState(env, me, cors);
    }

    if(url.pathname === "/social" && req.method === "POST"){
      let b; try{ b = await req.json(); }catch(e){ return json({ error: "bad json" }, 400, cors); }
      return handleSocialPost(env, b, cors, ctx);
    }

    if(url.pathname === "/auth" && req.method === "POST"){
      let b; try{ b = await req.json(); }catch(e){ return json({ error: "bad json" }, 400, cors); }
      const device = String(b.device || "");
      if(!DEVICE_RE.test(device)) return json({ error: "bad device" }, 400, cors);
      if(!env.GOOGLE_CLIENT_ID) return json({ error: "login not configured" }, 503, cors);
      const tok = await verifyGoogleToken(b.credential, env.GOOGLE_CLIENT_ID);
      if(!tok || !tok.sub) return json({ error: "invalid token" }, 401, cors);
      const sub = String(tok.sub);
      const existing = await env.DB.prepare("SELECT user_id FROM logins WHERE provider='google' AND subject=?1").bind(sub).first();
      let me = await userByDevice(env, device);
      if(existing){
        // returning player (possibly on a new phone): this device becomes theirs
        const u = await env.DB.prepare("SELECT id, handle, code FROM users WHERE id=?1").bind(existing.user_id).first();
        if(!u) return json({ error: "account missing" }, 500, cors);
        await env.DB.prepare("INSERT INTO devices (device, user_id, created) VALUES (?1,?2,?3) ON CONFLICT(device) DO UPDATE SET user_id=excluded.user_id")
          .bind(device, u.id, Date.now()).run();
        me = u;
      } else if(me){
        // first sign-in: attach Google to the profile this device already has
        await env.DB.prepare("INSERT INTO logins (provider, subject, user_id, email, created) VALUES ('google',?1,?2,?3,?4)")
          .bind(sub, me.id, tok.email || null, Date.now()).run();
      } else {
        // brand-new player signing in before claiming: make them an account
        const handle = await freeHandle(env, tok.given_name || tok.name);
        const id = randId(), code = friendCode();
        await env.DB.prepare("INSERT INTO users (id, handle, handle_lc, code, created) VALUES (?1,?2,?3,?4,?5)")
          .bind(id, handle, handle.toLowerCase(), code, Date.now()).run();
        await env.DB.prepare("INSERT INTO devices (device, user_id, created) VALUES (?1,?2,?3) ON CONFLICT(device) DO UPDATE SET user_id=excluded.user_id")
          .bind(device, id, Date.now()).run();
        await env.DB.prepare("INSERT INTO logins (provider, subject, user_id, email, created) VALUES ('google',?1,?2,?3,?4)")
          .bind(sub, id, tok.email || null, Date.now()).run();
        me = { id, handle, code };
      }
      return socialState(env, me, cors);
    }

    return json({ error: "not found" }, 404, cors);
  },

  // hourly cron (wrangler.toml [triggers]): the streak-saver nudge. Around 19:00
  // LOCAL time (tz stored per subscription), users who played yesterday (streak
  // ≥ 1) but not today get one push: "your streak is on the line".
  async scheduled(event, env, ctx){
    // lazy self-migration — harmless duplicate-column errors after the first run
    try{ await env.DB.prepare("CREATE TABLE IF NOT EXISTS previews (term TEXT PRIMARY KEY, json TEXT NOT NULL, at INTEGER NOT NULL)").run(); }catch(e){}
    try{ await env.DB.prepare("CREATE TABLE IF NOT EXISTS pins (term TEXT PRIMARY KEY, track_id INTEGER NOT NULL, at INTEGER NOT NULL)").run(); }catch(e){}
    try{ await env.DB.prepare("CREATE TABLE IF NOT EXISTS dead_ids (track_id INTEGER PRIMARY KEY, at INTEGER NOT NULL)").run(); }catch(e){}
    try{ await env.DB.prepare("DELETE FROM previews WHERE at < ?1").bind(Date.now() - PV_TTL_MS).run(); }catch(e){}
    try{ await env.DB.prepare("ALTER TABLE push_subs ADD COLUMN tz INTEGER").run(); }catch(e){}
    try{ await env.DB.prepare("ALTER TABLE push_subs ADD COLUMN nudged INTEGER").run(); }catch(e){}
    try{ await env.DB.prepare("ALTER TABLE users ADD COLUMN sbest INTEGER").run(); }catch(e){}
    try{ await env.DB.prepare("ALTER TABLE users ADD COLUMN tbest INTEGER").run(); }catch(e){}
    // per-day survival scores → daily & rolling-7-day friend boards
    try{ await env.DB.prepare("CREATE TABLE IF NOT EXISTS sscores (day INTEGER, user_id TEXT, score INTEGER, created INTEGER)").run(); }catch(e){}
    try{ await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_sscores ON sscores (user_id, day)").run(); }catch(e){}
    // prune sscores older than ~40 days so the table can't grow forever
    try{ await env.DB.prepare("DELETE FROM sscores WHERE day < ?1").bind(dayNow() - 40).run(); }catch(e){}
    if(!env.VAPID_PRIVATE || !env.VAPID_PUBLIC) return;
    const today = dayNow();
    const utcHour = new Date().getUTCHours();
    const subs = (await env.DB.prepare("SELECT endpoint, user_id, p256dh, auth, tz, nudged FROM push_subs LIMIT 500").all()).results || [];
    const perUser = new Map();   // user_id -> { played, streak }
    for(const s of subs){
      if(!Number.isFinite(s.tz)) continue;                     // tz unknown — never guess
      const localHour = ((utcHour + Math.round(s.tz / 60)) % 24 + 24) % 24;
      if(localHour !== 19) continue;                           // nudge in the local evening
      if(s.nudged === today) continue;                         // once per day per device
      let info = perUser.get(s.user_id);
      if(!info){
        const devs = ((await env.DB.prepare("SELECT device FROM devices WHERE user_id=?1 LIMIT 10").bind(s.user_id).all()).results || []).map(d => d.device);
        let played = false, streak = 0;
        if(devs.length){
          const q = "SELECT DISTINCT day FROM scores WHERE device IN (" + devs.map((_, i) => "?" + (i + 1)).join(",") + ") ORDER BY day DESC LIMIT 60";
          const days = new Set((((await env.DB.prepare(q).bind(...devs).all()).results) || []).map(r => r.day));
          played = days.has(today);
          for(let d = today - 1; days.has(d); d--) streak++;
        }
        info = { played, streak };
        perUser.set(s.user_id, info);
      }
      if(info.played || info.streak < 1) continue;             // nothing at stake (or already safe)
      await env.DB.prepare("UPDATE push_subs SET nudged=?1 WHERE endpoint=?2").bind(today, s.endpoint).run();
      ctx.waitUntil((async () => { try{
        const payload = JSON.stringify({ title: "🔥 Your " + info.streak + "-day streak is on the line",
          body: "Today's daily is still open — keep it alive!", tab: "play" });
        if(pushDead(await sendWebPush(env, s, payload)))
          await env.DB.prepare("DELETE FROM push_subs WHERE endpoint=?1").bind(s.endpoint).run();
      }catch(e){} })());
    }
  }
};
