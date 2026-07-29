# Yearworm — project notes & handoff

A music timeline guessing game (Hitster-style): hear a 30-second clip, place it
on your timeline by release year. Built to be **publishable** by using **iTunes
preview clips** instead of Spotify.

- **LIVE:** https://playyearworm.com 🎉 (custom apex domain on GitHub Pages,
  registered at TransIP; HTTPS cert auto-provisioned by GitHub).
- **Working branch:** `previews-rewrite`; `main` kept in sync by fast-forward
  (both currently equal). `CNAME` = playyearworm.com is committed.
- **Deploy:** push to the branch → live after a short CDN/cache lag (~1–2 min).
  Hard-refresh (Cmd/Ctrl+Shift+R) or incognito to see changes immediately. The
  service worker also gates updates — on EVERY shipped change bump both
  `const BUILD` in index.html and `CACHE_NAME` in `sw.js` (they must match;
  BUILD shows in the footer). Versioning is semver as of 2.0.0 (the iTunes
  rewrite is generation 2; v9–v41 predate the scheme): bugfix → patch
  (2.0.1), feature → minor (2.1.0).

## What it is
- Single-file web app: `index.html` (HTML + inline CSS + inline JS).
- PWA: `manifest.json` + `sw.js` (service worker, network-first). Icons:
  `icon-512/192/180.png`.
- Music: **iTunes Search API via JSONP** (`&callback=`) to dodge CORS; plays the
  30s `previewUrl` through an HTML5 `<audio loop>`.
- Modes: **Pass & Play** (classic; game length = race to N cards OR **⚡ Turbo**
  — everyone places RUN_LEN=5 songs on ONE SHARED timeline (all players'
  `p.timeline` reference the same array; cards carry `owner` = player index,
  colored via `PLAYER_COLORS`/`ownerColor()`, anchor owner=-1 muted), every
  card locks at its TRUE year, highest score wins; works solo too, `S.turbo`
  flag),
  **Survival** (solo, 3 lives, endless), **Daily Challenge** (solo seeded turbo
  run — same 5 songs worldwide, date = PRNG seed over `stablePool()`, deck NOT
  shuffled, sequential draw; streak + emoji share in `tl_daily`), and
  **Challenge links** (`#c=<poolIdx.poolIdx...>&s=<score>&t=<seconds>` (t feeds the tie-break) carries the exact
  run: indices into the stable-sorted pool; recipient plays the SAME songs and
  gets a beat/tied/lost verdict; `S.runCards` records indices during solo
  runs; created from any solo run's results screen).
- **Google sign-in** (LIVE since 3.0.0):
  client `GAUTH.clientId` (index.html) + `GOOGLE_CLIENT_ID` var (wrangler.toml)
  must BOTH be set to the owner's OAuth Web client id (public value; owner
  creates it in Google Cloud console with origin https://playyearworm.com).
  Client loads GIS (accounts.google.com/gsi/client) lazily, renders the button
  on the friends card (claim-card variant: "Played before on another phone?";
  profile variant: link prompt / "✓ Google-linked" badge). Since 3.0.2 the
  VISIBLE button is our own themed pill (`.gbtn`, official G svg + English
  text); Google's real rendered button is stretched invisibly over it
  (`.greal`, opacity .001) and receives the actual click — flow/security
  unchanged, but the look matches the dark UI and doesn't follow browser
  locale. Trade-off: technically bends Google's button-branding rules;
  worst case is a polite request to restore their button, not a security
  issue. POST /auth verifies
  the ID token in-Worker (JWKS from googleapis, RS256 via WebCrypto, iss/aud/
  exp checks) and: known sub → relink device to that account; unknown sub +
  existing profile → attach login; unknown sub + no profile → create account
  with a deduped handle from the Google given name. logins table (provider,
  subject)→user_id, optional email. On activation ALSO: update privacy.html
  (email storage!) + Play data-safety. Tests: worker.mjs auth block (forged
  RS256 JWTs, stubbed JWKS), social.js §6 (fake GIS).
- **Survival friends board** (4.21.0 — LIVE, advice round: NO world all-time
  board — unlimited attempts + custom decks + client-submitted scores = grind/
  cheat rot; friends-level only, weekly world top is the someday-upgrade):
  `tl_bsync` {s,t} records survival/turbo bests from STANDARD-deck runs only
  (`standardDecksOnly()` checks S.selectedIds against DECKS — custom-deck runs
  keep the local tl_best but never sync). Bests ride along every socialPost AND
  socialGet like the avatar does; worker MAXes server-side (stale device can't
  downgrade) with caps 999/RUN_LEN and try/catch for pre-migration servers.
  users.sbest/tbest via scheduled() lazy ALTER + schema.sql fresh shape;
  socialState returns them per friend (separate batched query). UI: Ranks tab
  gets a third card "🎯 survival · friends best" (ranked rows, me highlighted,
  zero-best friends hidden), friendDetail shows "survival best N · turbo best
  n/5". Tests: worker-push-test bests section (sync/MAX/caps/junk; NOTE: test
  harness rate-limiter is per-IP 30/min — new sections need their own
  CF-Connecting-IP), uichrome §5b (record on standard, custom-deck immune, POST
  carries sbest, ranked render, detail line). Future hook: push when a friend
  beats your best.
- **World survival boards + find players by name** (4.32.0 — LIVE, Sam: "met
  weinig spelers is het beter om de survival leaderboards voor iedereen te doen").
  He's right, and it reverses the 4.21.0 call — but only partly, and the original
  objection still holds where it applied. 4.21.0 refused a world **all-time**
  board: unlimited attempts + client-submitted scores = whoever grinds longest
  wins forever. A **windowed** board has no such problem — today and the rolling
  7 days both reset, so a grind buys you one day. New `/sboard?win=1|7` (GET +
  POST twin, readable without a device so a brand-new player sees it before
  playing), `sboard()` groups sscores by user, MAX score, ties broken by who got
  there first. Ranks tab is now: world daily → world survival week → world
  survival today → friends survival (only when a friend has actually run one) →
  friends standings. `standardDecksOnly` still gates srun, so a custom deck
  cannot buy a rank. Careful bit: the world boards come from /sboard, NOT from
  social state — the late `socialGet` refresh must not repaint them, and the
  friends card lives in an always-present `#ranksSurvFrWrap` so a cold load can
  fill it in (rendering it conditionally would have made it vanish until you
  revisited the tab).
- **Retention endpoint** (`GET /stats?key=…`, owner-only). The data to answer
  "does anyone come back" has been sitting in `scores(day, device)` since launch
  and had never been queried. Reports, per mode: players ever, % who played a
  SECOND day at all, day-1 and day-7 cohort return rates, and per-day players
  split into returning vs first-timers. Plus how many accounts still carry a
  generated name (a blunt proxy for "did they care enough to stay").
  Design notes: cohorts EXCLUDE players too new to have had the chance (day-1
  counts only first-plays before today, day-7 only 7+ days back) — including
  them makes every rate silently drift toward zero as newcomers arrive, which is
  the classic way retention dashboards lie. Aggregate counts only; no device
  tokens, handles or scores leave the endpoint (asserted in the test). Gated on a
  `STATS_KEY` secret and returns 404 when unset, so it can't be open by accident.
  HTML by default (readable on a phone), `&json=1` for the raw numbers.
  `server/stats-test.js` builds a history whose answers are known by
  construction — 7 devices, hand-placed across days — and checks every figure,
  because a silently wrong retention number would drive the whole roadmap.
- **KNOWN GAP: 93 songs Apple answers but pickBest rejects** (parked by Sam,
  "laat maar even zo"). A third harvest run resolved 0 of them — so it is NOT
  rate limiting: Apple returns results and our own matcher throws them away.
  Cause: `pickBest` requires BOTH title and artist to match, and these songs are
  credited differently in Apple's catalogue than in our decks. Demonstrated
  against the real matcher:
  `Hall & Oates` vs `Daryl Hall & John Oates` → reject (normalises to
  `hall oates`, which isn't a contiguous substring of `daryl hall john oates`);
  `Wham!` vs `George Michael` (Careless Whisper) → reject; `Martha and the
  Vandellas` vs `Martha Reeves & The Vandellas` → reject; `Ke$ha` vs `Kesha` →
  reject (`$`→space); `The Marcelles` → our own typo for `The Marcels`.
  (`*NSYNC`→`NSYNC` and `JAY-Z`→`JAY Z` DO match — normalisation handles those.)
  ⚠️ These were already being skipped during play long before the harvest; the
  spares covered it, so nobody noticed. The harvest only made it visible.
  If picked up later, the two options are: fix the artist names in the decks
  (safe, but 93 hand-checks and no Apple access from the dev box), or loosen
  artist matching to token overlap — which is exactly the knob that let the
  Silver Springs live cut and the Tamperer 12" through. Suggested middle path:
  allow token-overlap on the ARTIST only when the TITLE matches exactly, and
  review the resulting 93 picks before they get pinned.
- **previews.json is LIVE: 2113 songs** (4.39.1). Verified against the real file
  with Apple's Search API *and* the Worker cut off: catalogue coverage
  **2112/2206 (96%)**, today's daily **10/10**, daily starts, **0** Apple search
  calls, audio fetched from the CDN. 456 KB, now also precached by the service
  worker (separately + tolerantly: inside `addAll` one missing file aborts the
  whole install, and this file comes from a scheduled job).
  Two runs were needed, and both failures were mine:
  1. Run 1 resolved 725 songs and **threw them away** — the commit step tested
     `git diff` on a file that wasn't tracked yet. Git ignores untracked files
     there, so it said "no change". Stage first, then `git diff --cached`.
  2. The script treated **403 as a hard error** and backed off only on 429.
     Apple switches to 403 once it shuts you out, so after 725 songs it
     sprinted through the remaining 1458 at 1.2s each achieving nothing. Both
     statuses back off now, 20 consecutive failures stop the run (keeping what
     it has, resuming next time), and pacing went 1.2s → 3.5s: run 1 averaged
     ~29 lookups/min, which is what triggered the block — Apple tolerates ~20.
  ⚠️ Shipping previews.json changed the TESTS: every suite serves ROOT, so songs
  suddenly resolved from the static file and pointed at a CDN those suites don't
  stub — silently passing (or hanging) for the wrong reason. 15 suites now
  `route(/previews\.json/ → 404)` to keep exercising the lookup path on purpose.
  Real catalogue is **2206 distinct songs**, not 3716 (that counted duplicates
  across decks).
- **Previews are HARVESTED, not looked up at play time** (4.39.0 — the actual
  fix for the iPhone, after two releases that missed). The `?debug=1` endpoint
  finally answered the question I'd been guessing at:
  `429 "Rate limit has been exceeded for: itunes-apple-com|general|2a06:98c0:3600::103"`
  — a **Cloudflare** egress address. So routing lookups through the Worker made
  the per-IP limit WORSE, not better: Worker egress IPs are shared by every
  Cloudflare customer, i.e. the most-hammered IPs on the internet for this API.
  There is no runtime path left, so we stop looking songs up while playing:
  - `tools/harvest.js` resolves the whole catalogue from a machine Apple will
    answer. Reuses the app's OWN picking rules (lifted from index.html, same
    trick as pickparity) and the app's OWN song list (via Playwright →
    `allDecks()`), so it can't drift from what the game plays. Resumable —
    existing entries are skipped — with long backoff on 429 and an early bail
    if nothing is getting through.
  - `.github/workflows/harvest.yml` runs it weekly (also refreshing preview
    URLs, which rot) and commits `previews.json` to main.
  - Client: `loadStaticPreviews()` once per session in `resolveInitial` (every
    mode passes through there), `staticHit()` checked BEFORE the device cache
    and before any network. Missing songs fall through to the normal paths, so
    a partial or absent file degrades instead of breaking.
  - Why the audio still works for blocked players: previews stream from Apple's
    **CDN**, a different host that isn't rate-limited this way. Only the Search
    API refuses them — which is why playback always worked while lookups didn't.
  - Storage: URLs are stored with their long shared prefixes stripped (~40%
    smaller) and rebuilt client-side.
  Tests: ratelimit.js §7 — Apple AND the proxy blocked, daily still starts with
  ZERO lookups of either kind; plus an unharvested song still resolving.
  Two test-isolation bugs surfaced doing this and are worth remembering:
  §4 measured a global call counter while section 3's background loader was
  still fetching (now tears the game down and measures each resolve separately),
  and my §7 fixture gave every song the same trackId — the deck dedupes on
  trackId, so ten songs collapsed into one card and the daily could never start.
- **Two dead call sites after the rename** (4.38.1): renaming `itunesSearch` in
  4.38.0 left `runSearch()` (deck builder) and `startVerify()` (catalogue
  checker) calling a function that no longer existed — both would throw on the
  first search. Neither is on the daily path, so it didn't explain the iPhone
  report, but both were broken. They need Apple's RAW candidate list (you pick
  from the builder's menu yourself; the verifier runs its own pickBest), which
  is exactly what the server returns when the request carries no title — so the
  "older client" branch turned out to have a second, permanent purpose. New
  `searchRaw()` wraps it with the direct fallback.
  How it slipped through: after the rename I grepped for callers that don't
  `await` — not for callers that still reference the OLD NAME. Grep for the
  removed identifier itself. The deck builder had **zero** test coverage, which
  is why nothing caught it; `test/builder.js` now covers search → raw list →
  unplayable filtered → proxy-down fallback → add to deck.
- **The SERVER picks the version, and pins it** (4.38.0 — Sam: "moet het niet
  gewoon in de decks vastliggen wat de beste versie is?"). It didn't: of 3716
  songs only **3** had a hand-tuned `q`, so the heuristic re-decided for the
  other 3713 on every cache miss. That's how the Silver Springs live cut and the
  Tamperer extended mix shipped — one at a time, each needing a manual fix.
  Instead of curating 3716 track ids by hand, the list **builds itself from real
  play**: the first time a term is resolved anywhere in the world, the Worker
  picks and writes `pins(term → track_id)`. Every player after that gets the
  identical recording, and the choice can't drift when Apple reshuffles results.
  - **Why the server picks, not the client:** anything a phone posts can be
    forged, and a wrong pin would then apply to everyone; and five app versions
    in the wild would each pick differently. So `pickBest` + the four filter
    regexes were ported into worker.js. The client keeps its copy for the
    fallback path ONLY (Worker unreachable → straight to Apple).
  - **The loop Sam asked about is real and guarded.** A dead pin re-searches;
    without care the search picks the same dead track and re-pins it — not a
    spin on one device, but a fresh failure for every player forever. So the id
    goes into `dead_ids` **before** the re-search, and dead ids are filtered out
    of candidates. Tested both halves.
  - **Pinning also fixes rotting clips:** a pinned term refreshes via
    `lookup?id=` (ONE record, fresh previewUrl) instead of re-searching, so
    `previews` TTL dropped 14d → 7d without costing more.
  - Response is `{ok, pick, results}`. A client that sends no title (an older
    cached build) still gets the raw list — verified, since the service worker
    can leave a stale index.html around for a while.
  - ⚠️ TWO COPIES OF THE PICKER NOW EXIST. `test/pickparity.js` extracts both
    from the real sources, asserts the four regexes are character-identical, and
    runs both over 12 fixtures (each a bug this project actually shipped),
    checking they agree AND that the answer is right. Verified it BITES: editing
    LONGVER in worker.js alone fails the test. **Change one, change the other.**
- **Equal board row heights** (4.37.1 — Sam: "niet alle rows zijn even hoog").
  `.btn.sm` carries `min-height:40px` (a thumb-sized tap target everywhere else
  in the app), so a row ending in a real button stood ~10px taller than one
  ending in a ✓/⏳ span or the share svg — the list visibly stepped. Inside
  `.bactn` the button is now sized by the cell (28px, no min-height, padding 0)
  and its tap target is restored by an invisible `::after {inset:-10px -8px}`,
  which costs no layout: measured 46×48. uichrome now asserts max−min row height
  ≤ 1px (the 1px IS the first row's missing border-top) AND that the overlay
  keeps the hit box ≥44px, so shrinking the button can never quietly shrink the
  target.
- **Lookups go through the Worker, with a shared cache** (4.37.0 — the REAL fix
  for the iPhone daily failures; 4.30.0's client-side mitigations weren't
  enough). Screenshot evidence: "Finding previews · 9/10" then the error — the
  daily resolves 10 songs in batches of 3 and stops early at `S.deck.length>=2`,
  so reaching 9/10 and still failing means **essentially every lookup failed**,
  not one or two. Apple's limit is per CLIENT IP and iCloud Private Relay /
  carrier CGNAT share one across thousands of phones, so this player was blocked
  before their first lookup and no amount of client retrying could help.
  New `POST|GET /lookup` on the Worker: checks the `previews` table (term →
  trimmed results JSON, 14-day TTL), else fetches Apple server-side and stores
  it. Apple now sees ONE IP, and answers are reused by everyone — the daily is
  the same five songs worldwide, so it costs five lookups per TTL globally
  instead of five per player. Client `itunesSearch()` tries the proxy and falls
  back to the original JSONP (renamed `jsonpSearch`), so this can only ADD a
  route to success.
  Design points worth keeping: (a) `ok:false` when the Worker itself couldn't
  reach Apple, so the client retries direct instead of trusting an empty; a
  failed fetch is never cached, and a genuine empty gets only a 10-minute TTL so
  a throttle can't be baked in as "this song doesn't exist". (b) The client only
  trusts `ok:true` **with an array** — a malformed reply falls through to direct
  (caught by the themedweek stub, which answered ok:true with no results and
  silently killed every song). (c) `/lookup` has its OWN per-IP budget (300/min,
  `lookupHits`) so a ten-song game start can't be starved by social calls on a
  shared IP. (d) Only the fields `pickBest` uses are stored.
  ⚠️ UNVERIFIED FROM HERE: this environment's proxy blocks both Apple and
  Cloudflare, so the Worker's outbound fetch to iTunes could not be exercised
  against the real API — only against a stubbed `globalThis.fetch`. If Apple
  ever blocks Cloudflare egress, `ok:false` makes clients fall back to direct.
  Tests: worker-push-test lookup block (proxy, trim, cache-across-callers,
  403/unreachable → ok:false + not cached, 120-call burst); ratelimit.js §6
  (direct JSONP fully blocked + working proxy → daily starts with ZERO direct
  Apple calls; ok:false → falls back to direct). Full 18-suite sweep green.
- **Share the daily from the leaderboard** (4.36.0 — Sam: "consistenter"). The
  survival board's own row was tappable → `shareSurvival()`, the daily board's
  wasn't. Now both work the same: your row on the daily board (and the >10
  `meLine`) taps through to `shareDaily()` and shows the share icon in `.bactn`.
  Guarded on `dailyPlayedToday()` — `shareDaily()` reads the LOCAL daily record,
  which is stale on a device that hasn't played today, so the control only
  appears once there's something real to share.
  Found while here: the survival row had **two `style=` attributes** on one
  element (the base one plus `style="cursor:pointer"` in the mine-branch). The
  parser keeps the first and drops the second, so the tappable row never looked
  tappable. Folded into the first attribute on both boards.
  uichrome §5b-1c asserts the control is absent before playing, present after,
  and that tapping it emits the real daily text (squares + "Yearworm Daily").
- **Leaderboard columns fixed** (4.35.1 — Sam: "het is bij mij een beetje gek
  uitgelijnd"). The trailing control is a ✓, +, ⏳, ?, share icon or nothing —
  all different widths, and it sat directly after a `flex:0 0 auto` score, so
  every row pushed its score to a different x. Two reserved columns now:
  `.bscore` (min-width 34, right-aligned) and `.bactn` (fixed 30px, keeps its
  width when EMPTY — that's the part that matters). The share icon on your own
  survival row moved out of the score span into `.bactn` for the same reason.
  uichrome §5b-1b measures `getBoundingClientRect().right` for every cell and
  fails unless each column has exactly one distinct edge, and checks the five
  states render one mark each.
- **Renaming with NO account now claims one** (4.35.0 — the actual Carmen case,
  spotted from Sam's screenshot: her daily row had neither "+" nor "✓", i.e.
  `boardAddBtn` got a null id). A daily score carries its own `nick`, entirely
  independent of any profile — so a player who never claimed a name still shows
  up on the world board under whatever they typed in Profile. She looked like a
  player; she had no `users` row at all. Hence: unsearchable, unaddable, no "+".
  4.34.0 didn't help her either — `saveNick` only synced `if(loadProfile())`.
  Now: profile exists → rename; no profile → **claimHandle()**, because typing
  your own name in Profile IS the claim. Nobody hunts for the Friends tab's
  "Claim" button; they fix their name where they see it.
  Second half: a board row with no account rendered a BLANK cell — the same trap
  as the friends-tick (blank reads as "button broken"). It's now a dimmed "?"
  that toasts "X hasn't claimed a name yet — once they do, you can add them."
  Tests: findplayers.js §9 (fresh device submits a daily, renames in Profile,
  gets an account and is searchable; a genuinely account-less row shows "?" and
  explains itself on tap).
- **Renaming yourself never reached the server** (4.34.0 — THE root cause of the
  whole "I can't find Carmen Sophie" saga, and the last of five rounds on it).
  `saveNick()` wrote `tl_nick` to localStorage and re-submitted daily/challenge
  scores with the new nick — it never called `action:"claim"`. So `users.handle`
  kept the generated name forever. Consequences: search reads `users.handle`, so
  a renamed player was findable ONLY under "Groovy Flamingo"; friends' rosters
  showed the old name too. Since every player starts on a generated name
  (`NICK_ADJ` × `NICK_ANIMAL`), renaming is the ONE step that makes a person
  findable — and it was silently a no-op. Now `saveNick` → `renameOnServer()`
  (same claim action). Second bug found while testing the first: the local store
  was written BEFORE the server answered, so a rejected rename (409 handle
  taken) left the device showing — and submitting to the boards — a name the
  server never accepted. `renameOnServer(handle, prev)` now restores `prev` on
  any non-ok reply and repaints the profile.
  Also: `boardAddBtn` rendered NOTHING for people already on your roster, so
  with a handful of players every row was blank and the feature read as
  unshipped — friends now get a muted ✓.
  Tests: findplayers.js §7 (rename → searchable under the new name, old name
  gone, rejected rename keeps the original) and §8 (daily board shows + for a
  stranger, ✓ for a friend, nothing for yourself; tapping + sends the request).
- **Add friend from the leaderboard** (4.33.0 — Sam, after search STILL couldn't
  find his friend). **The real finding, from his screenshot:** his whole friends
  list reads "Vinyl Flamingo / Turbo Penguin / Retro Llama / Shady Penguin" —
  those are our OWN auto-generated names (`NICK_ADJ` × `NICK_ANIMAL` in
  `lbNick()`). Almost nobody renames themselves, so **searching a real name can
  never work for most players**; his friend is on there under a random animal.
  Search by name is worth keeping, but it is not the primary way people will
  find each other at this size — the board is. So: `board()` and `sboard()` now
  return `uid` per row (null for unclaimed devices) and every board row carries
  a `+` that fires `action:"request"` (still PENDING — a board sighting is not
  consent either). `socialState` gained **`outgoingIds`** so the row can show ⏳
  after a reload, not just in-session. Careful bit: boards arrive BEFORE social
  state, so the payloads are cached in `_boards` and `paintRanks()` re-renders
  once friends are known — otherwise an existing friend briefly shows a `+`.
  Tests: findplayers.js §7 (request is pending, own row exempt, row flips to ⏳,
  accepted friend offers no button).
- **Search fix 3: a FAILED search is not "she doesn't exist"** (4.32.3 — Sam:
  "staat nog steeds dat ze niet bestaat"). The real defect, and it outranks both
  earlier fixes: `findPlayers` rendered the not-found message whenever the POST
  didn't return results — including on **429 and network failure**. So a
  rate-limited search stated, confidently, that the person has no account.
  Root cause of the 429s: `limited(ip)` was **30/min per IP across every social
  endpoint**, set when a screen made one call. The Ranks tab now fires four
  (social state + daily + both survival windows), typing a name adds more, and a
  household/office shares one IP — so ordinary use throttled itself. Raised to
  **90/min** (cheap reads; still bounds scraping) AND the client now separates
  failure from empty, with a "↻ Try again". findplayers.js §6 forces a 429 and
  an aborted request and asserts the copy never claims the player is missing.
  NOTE: I could not query production from this environment (proxy blocks
  workers.dev) — this was found by reproducing locally against the real worker.
- **Search fix 2: per-WORD matching** (4.32.2 — Sam: "ik zoek Carmen Sophie maar
  vind haar niet"). 4.32.1 matched the whole query as one substring, so typing
  someone's full name found nothing when their handle is only part of it
  (`%Carmen Sophie%` never matches the handle `Carmen`). Now the query is split
  on spaces, each word ≥2 chars is matched as its own substring, results are
  OR'd, and ranked by **how many words matched** (then prefix, then alphabetical).
  Max 3 words; 1-letter words dropped (they'd match half the table). Also: the
  not-found copy now says people only appear once they've **claimed a name** —
  the most common reason someone is genuinely missing, and unguessable before.
  ⚠️ Test-writing trap hit here: the empty state ECHOES the query, so
  `/Carmen/.test(text)` passed on the "no Carmen Sophie" message — a false
  green. findplayers.js now asserts on the result rows (`#findOut b`), not on
  page text containing the name.
- **Search fix: match anywhere in the name** (4.32.1 — Sam: "search player by
  name does not seem to work"). It worked mechanically; the RULES were wrong.
  Reproduced with a new full-stack suite `test/findplayers.js` (real index.html
  ↔ real worker.js over a better-sqlite3 D1 — no network stubs, because the
  stubbed uichrome test passed happily while the feature was unusable). Two
  ways it read as broken: (a) `pinguin` found nothing for `TurboPinguin` —
  prefix-only was also near-useless as anti-scraping (676 two-letter prefixes
  enumerate the table as well as substrings do; the real limits are the per-IP
  rate limiter and the cap of 8, and handles are public on the world board
  anyway) → now `%q%` with prefix matches still ranked first; (b) searching your
  OWN name returns nothing because you're excluded by design → the empty state
  now says "That's your own name" instead of a blank not-found. Lesson repeat:
  a stubbed test proves the wiring, not the feature.
- **Find friends by name** (4.32.0): `action:"find"`, originally prefix-only,
  capped at 8, self-excluded, LIKE wildcards escaped. Handles are already public
  (they carry the world daily board) so this leaks nothing new — but substring
  search over a growing table is a directory scraper, hence prefix-only. Results
  carry `rel` (none/sent/incoming/friend) so the UI shows "+ Add" / "⏳ asked" /
  "✓ friends" instead of letting you re-request. Adding from a search uses the
  new `action:"request"` → **pending**, never instant: sharing your CODE is
  consent, someone typing your name is not. (If they already asked you, your
  request resolves to an accept.) Search box is debounced 300ms and
  sequence-guarded so a slow early reply can't overwrite a newer one.
- **Push on iPhone: diagnosable + rotation-proof** (4.31.0 — LIVE, Sam: works on
  the iPad, not the iPhone). An iPhone has no devtools, so "it doesn't work" was
  unfalsifiable. Three separate causes, all now handled:
  1. **A VAPID rotation kills every existing subscription.** A subscription is
     permanently bound to the applicationServerKey it was created with, so after
     the key swap the push service answers our correctly-signed requests with
     **403** — silently, while the toggle still reads "On". `enablePush` reused
     `getSubscription()` unconditionally, so turning it off and on didn't even
     fix it. Now: `tl_pushkey` records the key we subscribed with (`sub.options`
     is the direct check but Safari doesn't expose it), `subMatchesKey()` detects
     the drift, and `healPushKey()` runs 3s after boot to unsub + re-subscribe
     without the player touching anything. Server side, **403 now counts as dead**
     (`pushDead()`) so stale rows get pruned instead of retried forever.
  2. **iOS only exposes push to Home-Screen web apps.** In a Safari tab
     `window.Notification` is simply absent → `pushSupported()` false → we
     *hid the whole Notifications card*, which reads as "the feature vanished".
     The card now always renders and explains what to do: Add to Home Screen, or
     (in a WhatsApp/Instagram webview, which can't install at all) open it in
     Safari first. `isIOS()/isInstalled()/isInApp()` + `pushBlockReason()`.
  3. **No way to test.** New `action:"push-test"` pushes to your own devices and
     returns `{ok, vapid:{configured,match}, subs, sent:[{status,host}]}`; the
     profile card has a **Send test** button that turns the raw status into an
     instruction (403 → off/on, 410 → off/on, no match → server secret is wrong).
     Only the endpoint HOST is returned — the endpoint itself is a bearer secret.
  Tests: push.js §4–6 (403 explained, boot heal re-subscribes, iOS tab keeps the
  card), worker-push-test push-test block (delivery, 403 prune, unconfigured).
- **Rate-limit resilience** (4.30.0 — LIVE, Sam's iPhone tester): an iPhone
  opening the site from WhatsApp's in-app browser got "Couldn't load today's
  songs" on EVERY daily tap. Root cause: Apple's Search API limit is per
  EGRESS IP (~20/min), and iCloud Private Relay / carrier CGNAT put thousands
  of devices behind one — so a user who has made zero lookups can still be
  blocked. Four fixes:
  1. **Preview cache** `tl_pv` in localStorage (12-day TTL, 900-entry cap,
     key = `q|title|artist`): `pvGet` short-circuits the lookup entirely, so a
     returning device barely touches Apple. `onAudioFail` calls `pvDrop(url)`
     so a rotated/dead clip can't be served forever from cache.
  2. **3 attempts per song** in `resolveBatch` with jittered backoff
     (700/1400ms + up to 300ms) — a per-minute window often reopens in-run.
  3. **JSONP fast-fail**: a rate-limited response is a 403 whose body never
     calls our callback, so the script LOADS but nothing resolves and we used
     to sit out the full 9s timeout. `s.onload` → resolve empty after 60ms
     (a JSONP callback runs during script evaluation, i.e. before onload, so
     if onload fires with nothing resolved there is no answer coming). One
     song's 3 attempts: 30090ms → 2722ms.
  4. **`showError(msg, retryFn)`** renders a "↻ Try again" button; wired into
     startDaily / startChallenge / startTutorial / onStart. Copy is honest now
     ("Apple limits how many lookups one network can make") instead of a dead
     end. NOTE for future timing-sensitive tests: the backoff made two fixed
     sleeps too short (connection.js §C, oneshot.js §3) — both now wait for
     the element. New suite `test/ratelimit.js` (5 sections).
- **Top 10 Hits is the DEFAULT deck** (4.29.0 — LIVE, Sam): DECKS order now
  top10 → everything → classics → thehits → now → party, because boot does
  `S.selectedIds = [DECKS[0].id]`. Default pool 2170 → 656 recognizable
  per-year hits (better first impression; Every Era one tap away). SAFE because
  daily/challenge/tut seed from `stablePool()` which finds "everything" BY ID —
  verified: stablePool still 2170, dailySongs() unchanged. top10 stays a
  built-in ⇒ standardDecksOnly ⇒ survival scores still count (they'll skew
  higher on an easier deck — accepted). Deck selection is NOT persisted, so
  every session starts on top10. Full suite green (8 suites).
- **Survival year-report** (4.28.2 — LIVE, Sam): survival's reveal built `extra`
  as hearts ONLY, so it was the one mode without the 🚩 wrong-year block (turbo/
  daily/challenge/classic all had it) — and it's the most-replayed mode, i.e.
  where bad years surface first. Now hearts + flagBlock. report.js gained a
  survival section (asserts BOTH hearts and .report-yr) so no mode can silently
  lose the control again.
- **Top 10 Hits deck** (4.28.0 → GROWN in 4.28.1 to ~10/JAAR: 656 songs, 1957–
  2024, 67 years; pool 2029→2170): new `TOP10_SONGS` (curated, year-accurate, 1965–2024) — international
  toppers + NL staples (Golden Earring, Shocking Blue, Focus, George Baker, 2
  Unlimited, Vengaboys, Alice Deejay, Anouk). Added to the pool (add-loop) AND as
  a 6th PICKABLE deck `{id:"top10", name:"Top 10 Hits", 🏆}`; DECKS.splice(5)→(6).
  Pool 2029→2044 (15 net new), 0 near-dupes. It's a built-in ⇒ standardDecksOnly
  true ⇒ counts toward survival boards (note: it's easier than Every Era, so
  scores skew higher — accept for now). Feel It carries the radio-edit q. Years
  are hand-picked but UNVERIFIED against a chart DB — Sam/report-tool can correct;
  q-override handy for bad clips. runmode/leaderboard/survival green.
  4.28.1 QUALITY GATES (scratchpad/top10_build.py + top10chk.js + align.js):
  (a) 0 internal dupes (core title|primary-artist key); (b) 53 songs had a
  DIFFERENT year in another curated deck (release-vs-chart-peak) — all aligned
  to the EXISTING curated year so one song = one answer app-wide (never let the
  same track carry two years; challenge links + dailies index the pool);
  (c) revival traps deliberately dated to ORIGINAL release: Kate Bush "Running
  Up That Hill" 1985 (not the 2022 Stranger Things peak), Taylor Swift "Cruel
  Summer" 2019 (not 2023). Years remain hand-curated, not chart-DB verified.
- **Better clip selection** (4.27.1 — LIVE, Sam: Tamperer "Feel It" played the
  wrong version, radio edit is a better clip): pickBest gains (1) LONGVER
  penalty (extended/club mix/12"/dub/megamix — their 30s preview is usually an
  instrumental build-up) and (2) a track-length preference via trackTimeMillis
  (+1 for ~2:20–5:30 radio-single length, −1 for >6:30 album/12" cuts), both
  "unless the curated title wants it". NEW per-song `sg.q` search override
  (resolveBatch uses it instead of artist+title) to steer Apple toward a
  specific cut — set `q:"The Tamperer Feel It radio edit"` on both Tamperer
  entries. CAVEAT: can't verify the actual Apple clip from the sandbox (proxy
  blocks iTunes) — logic is sounder, Sam verifies on device. uichrome §5e
  extended (ext-vs-radio, long-alone last resort, length pref).
- **Survival leaderboards + Play-page reorder** (4.27.0 — LIVE, Sam: survival
  deserves 2nd place + windowed boards + share-your-run): (1) Play page order
  now Daily, SURVIVAL, Challenges, Pass&Play, Turbo. (2) NEW server `sscores`
  table (day,user_id,score) via lazy CREATE in scheduled() (+40-day prune) &
  schema.sql; `action:"srun"` inserts today's score (cap 999) + MAXes
  users.sbest; socialState adds per-friend AND me `sday` (today MAX) + `s7`
  (rolling 7-day MAX) via grouped queries over friend-ids+me.id. Client: survival
  game-over posts srun (standard decks only, score>0). (3) Ranks reordered:
  daily world board → survival·this week (s7) → survival·today (sday) → friends
  duel standings. `ranksSurvivalRows(key,emptyMsg)` parametrized; zero-scores
  hidden; me row highlighted. (4) Tapping YOUR OWN survival row → `shareSurvival()`
  WhatsApp taunt ("I survived N songs… beat N?") — score dare, no seeded link
  (survival isn't seeded). Tests: uichrome §5b rewritten (srun sync, 7d/today
  windows, taunt), worker-push-test survival section (srun→sscores, windows,
  all-time bump; needs its own CF-IP for rate limit). all-time sbest kept for
  friendDetail/profile/achievements.
- **Play-again repeats — THE actual repeat bug** (4.26.1 — LIVE, Sam flagged
  repeats 3×; first two "fixes" (4.25.0 memory, 4.25.1 dedupe) were real but
  MISSED this): `playAgain()` reset S.used but REUSED S.deck — a short survival
  run resolves only ~12 cards (demand-paced cushion), so "Play again" redealt
  those same ~12; freshFirst/notePlayed were bypassed entirely (they only run in
  onStart). REPRODUCED: 4-6/8 repeats between consecutive Play-again games (an
  onStart-per-game test showed 0, which is why it hid so long — measure the REAL
  path). Fix: playAgain now calls onStart() for pooled modes (fresh shuffle +
  anti-repeat + fresh resolve; seeded modes keep the old reuse but never reach
  it). Belt-and-braces: drawCard/primeNext gained freshPref() — prefer cards not
  in loadPlayed(), fall back to all so small decks don't starve. New permanent
  test/repeats.js (drives the Play-again button, asserts ≤2/8 overlap). Lesson
  (again): reproduce via the REAL user action, not a convenient proxy.
- **React everywhere** (4.26.0 — LIVE, Sam: "je kan alleen bij de acceptatie
  reageren"): the emotion loop now closes on all three sides. (1) result rows
  AND react rows in the friends card get a 💬 react-back button →
  openReactSheet (ping-pong intended, WhatsApp-style). (2) share links carry
  the sender: `senderTag()` appends &f=<me.id> to chal/result-back/daily links
  (socialState.me now includes id — server change), parseChallengeHash reads
  fromUser. (3) results sheet reaction row targets `reactTarget()` = S.reactTo
  (inbox) OR the link's fromUser IF they're a friend AND S.mode==="challenge"
  (mode guard: a pending link parked on home must not leak a react row under a
  daily's results). React stays friends-only server-side — unknown senders get
  no row. Tests: social.js §5b2/5b3; worker test green with me.id.
- **Version filter** (4.25.4 — LIVE, Sam heard an INSTRUMENTAL in a run —
  coreNorm strips "(Instrumental)" so it scored as an exact title match):
  pickBest gains two tiers. NOVOCAL (instrumental/sped up/slowed(+reverb)/8d/
  nightcore) = HARD reject — defeats the game itself; OFFVER (live/acoustic/
  unplugged/demo/remix/cover/re-recorded/orchestral/reprise/version) = −2
  score penalty — any clean take wins, but last-resort allowed (live cut of
  the right song beats no song). Both guarded with "unless the curated title
  wants it" ("Live Is Life" safe). uichrome §5e unit-tests the matrix.
- **Pool near-twin dedupe** (4.25.1 — LIVE, Sam: "next run i had 2 the same
  songs" — the REAL repeat bug at last): the buildBigDecks dedupe keyed on
  EXACT title|artist, so "Umbrella" + "Umbrella (feat. Jay-Z)" and "Mark
  Ronson" + "Mark Ronson & Bruno Mars" both entered the pool — 137 redundant
  entries; one run could deal the same audible song twice, and freshFirst
  couldn't see the twins either (some even had different YEARS: Old Town Road
  2018+2019, Levitating 2020+2021). Fix: build key = core title (parens/
  feat-tails stripped) + PRIMARY artist (split on &/,/feat/with/vs; fallback
  to full artist if the first segment is <2 chars — "X Ambassadors" guard),
  each side cleaned separately (a stray edge space before the "|" split keys —
  caught by unit-testing the key on the Umbrella pair). Pool: 2166 → 2029
  distinct, 0 near-twin groups (verified in-page via scratchpad/deckcount.js).
  Curated decks add first, so their hand-checked title/year wins each merge.
  Ripple: stablePool indices shifted → today's daily reshuffles mid-day and
  pre-existing chal links resolve differently (accepted: ~zero players).
- **Anti-repeat memory** (4.25.0 — LIVE, Sam: "we seem to get some songs more
  than others"): diagnosis CORRECTED after Sam pushed back — the runtime DECKS
  are everything/Every Era (2166 songs, THE DEFAULT), classics/thehits/now/
  party (600 each); a first regex-count against raw source blocks ("decades
  71") was WRONG, and the pool has ZERO duplicate title|artist entries
  (measured in-page). Shuffle = fair Fisher-Yates. Conclusion: the perceived
  repeats were birthday-paradox clumping (~100 songs heard from 2166 → ~2-3
  expected repeats) — real randomness clumps. The 4.25.0 fix REMAINS right
  anyway: `tl_played` LRU (cap 250) + `freshFirst()` stable partition in
  onStart deals unheard songs first, eliminating even chance repeats; seeded
  runs untouched. uichrome §5d. Lesson: count game data IN the page
  (deckcount.js in scratchpad), not with regex over source blocks.
- **Duck vs visualizer** (4.24.6 — LIVE, Sam: "looks like the equalizer
  broke"): sfx ducking lowered the media ELEMENT's volume, which sits before
  the viz graph (element→analyser→destination) — every cue collapsed the live
  bars for ~half a second. Fix: `duckGain` node inserted AFTER the analyser
  (element→analyser→duckGain→destination); duck() targets duckGain when the
  viz graph is live, element volume otherwise (CSS-bar fallback path
  unaffected, uichrome ducking test still exercises the volume path since viz
  is off there). playClip resets both.
- **Share card v4 — design pass** (4.24.4 — LIVE, Sam on v3: "large and small
  fonts all over, doesn't breathe"; done by a dedicated design agent over 3
  render-review cycles WITH real webfonts injected in the sandbox): type scale
  cut 6→4 sizes (27px small-caps tier = eyebrow/subtag/footnote at the app's
  11px ×2.45; 36px body tier = streak + button label, weight-differentiated;
  72px wordmark; 224px Anton score = the single hero at ~3.1× wordmark).
  Header shrunk to ~×1.8 (vinyl 110px) and rebuilt as a measured lockup with
  the subtag centered below (was hanging off-left touching the ring). Eyebrow
  muted→GOLD (matches the app's daily-card eyebrow). Spacing: 72px card
  margins, 76/70 card padding, consistent 35-48px row gaps, tiles on the
  8-grid. Fallback-font layout verified (sans score wider but clears). Harness
  for real-font renders: scratchpad/shareimg-shot-fonts.js + fonts/.
- **Share card v3 — app-native** (4.24.3 — superseded, Sam on v2: "doesn't match the
  game"): the poster look (frame/glows/divider) is GONE; the card is now
  composed from the app's own components at ~2.45× the 440px layout — lobby
  header row (ringed mini vinyl + wordmark + subtag), a .card surface (#121A2E,
  44px radius, faint border), the exact .eyebrow type ("DAILY CHALLENGE #21 ·
  📼 90S WEEK"), Anton score, result tiles, results-sheet copy ("🔥 streak · 12
  days · ⏱"), and the cyan action button drawn verbatim (bg #5EE0D6, text
  #00303F, #3FA8C6 pressed edge) reading "Beat me on the same songs"; mono
  footnote "playyearworm.com · free · no app needed". Rule learned: share
  assets should look like PIECES OF THE GAME, not separate marketing design.
- **(v2 notes, superseded)** (4.24.2): the daily
  share PNG rebuilt on the new brand language — gold-ringed record w/ drop
  shadow, warm/cool corner glows, a gold ticket FRAME (roundRect 36px inset),
  gradient divider between brand and result blocks, DAILY #n · <theme> line in
  GOLD, Anton score, beveled result tiles (top-highlight bar), meta + domain
  footer inside the frame. shareimg.js text assert updated (themes-from-week-0
  made daily #21 a "📼 90s Week" — had been failing quietly since 4.23.1).
- **Brand ring + survival polish** (4.24.1 — LIVE): Sam kept the GOLD RING —
  restored on the header vinyl (box-shadow 2px dark gap + 4px gold) and added
  to the regenerated icons (disc shrunk to .365S so ring outer edge ≈.393S
  stays inside the .4S maskable safe zone). Survival config lost the pointless
  name input (identity lives on Profile; onStart falls back to "You"), and the
  survival RUN OVER sheet gained a third option: Play again / Change setup /
  NEW "Quit to menu" via `backToMenu()` (_playScreen=null + backToSetup → Play
  tab instead of the config screen).
- **One record, one brand** (4.24.0 — LIVE): Sam picked the in-game gvinyl as
  THE record — header `.vinyl` restyled to a 54px mini-gvinyl (same grooves/
  glint/gold→cyan label/spindle; dropped the old gold outer ring), app icons
  icon-512/192/180 REGENERATED from the same design (scratchpad/icon-gen.js —
  canvas draw, disc at 78% for the maskable safe zone, warm+cool corner glows
  on #03050D; replaced the old equalizer-bars icon), and the share-card canvas
  label went gold→cyan to match. Header centered since 4.23.2 (looks right-
  hugging because the subtag is wide — it's mathematically centered).
  og-image.png REGENERATED app-native in 4.25.3 (scratchpad/og-gen.js:
  lockup + subtag + result tiles + tagline, real fonts injected); og:image
  meta versioned ?v=2 to bust WhatsApp/Telegram preview caches.
- **Themed weeks** (4.23.0 — LIVE, marketing cadence): every 7 dailies the
  DAILY takes a theme — `WEEK_THEMES` (APPEND-ONLY: weekNum%len; reorder =
  reshuffled future) rotation: Wildcard(all)/80s/90s/00s/Golden Oldies(≤1979)/
  Modern(2010+). `THEMES_FROM_WEEK=0` since 4.23.1 (Sam: ~zero players, no
  live day worth protecting) — today (#22, week 3) IS 00s Week; raising the
  constant again would UN-theme past weeks, never do that. `seededIdx`
  gained a filter param — eligible slice by era, indices stay FULL-POOL (chal
  links unchanged), <n*6 eligible → full-pool fallback; filter=null keeps the
  exact old rnd sequence (pre-theme dailies identical). Surfaces: mode card
  (emoji+name+tag), in-game eyebrow, results sheet (theme line + "next week:"
  tease), share TEXT and share IMAGE ("DAILY #n · 80S WEEK"). Weeks roll every
  Wednesday (epoch Jul 1 = Wed). Test: themedweek.js (rotation/determinism/
  era-bounded picks/pre-theme clean; pins the clock via `dailyNumber = () =>
  30` rebind). Marketing: each theme = a push/post/share hook.
- **Sound pass 2 + achievement popups** (4.22.0 — LIVE): (1) the miss cue was
  pitched 110-220Hz — BELOW what phone speakers reproduce, hence "I hear
  nothing when wrong"; now a mid-range sawtooth buzz (420→250, 315→185).
  good slightly louder (.62/.52). NEW kinds: "win" = fanfare + two bandpassed
  white-noise swells (reads as a crowd cheer; `noise()` helper in sfx),
  "lose" = descending wah-wah-waah (330/294/262→220 triangle), "ach" = bright
  sparkle (1175/1568). Cue wiring in overlayRunOver: `cue` var — duels sound
  their verdict (win/lose/tie→end via the rr outcome), solo ≥4/5 win else end;
  survival death = lose (new best still = win). (2) Achievement popups:
  `achievementsList()` split out of achievementsHTML; `checkAchievements()`
  diffs done-names vs `tl_achseen` (first check BASELINES SILENTLY — existing
  players get no blast), pops ≤3 staggered (.7s + 3.1s apart) via `achPop`
  (fixed top banner .achpop, gold border, pointer-events:none, sfx ach + buzz);
  timers tracked in `_achT` so tests can flush in-flight pops (afterLobby also
  checks — a pop can be pending across sections). Hooks: all 4 game-over
  overlays + tut finish + claimHandle + afterLobby socialGet. uichrome §5c +
  sfx list extended; run suites green.
- **Loader pacing** (4.21.3 — LIVE): Sam saw "connection problems" mid-survival
  on a fine connection — SELF-INFLICTED: loadRest streamed ~80 spares at up to
  ~110 iTunes calls/min while Apple's search endpoint tolerates ~20/min → rate
  limiting → lookup timeouts → watchdog flagged netTrouble. Fix: loadRest is now
  DEMAND-PACED (CUSHION=10 unused cards ahead, otherwise idle-poll 1.2s; games
  consume ~2-3 cards/min so the request rate stays far under the limit) with
  exponential backoff on failures (1.5s→20s, capped at 5s while the player is
  actually starved <3 unused). The waiting message now blames the connection
  ONLY when navigator.onLine is false — online rate-limit stalls read "Loading
  more songs…". Also fixed stale spares.js (still clicked the pre-4.14.0
  "Challenge a friend on these songs" button; pass-on sheet now). Possible
  future: localStorage preview-URL cache (title|artist → previewUrl, ~7d TTL)
  would nearly eliminate lookups on repeat plays; needs an audio-error
  re-lookup fallback for stale URLs.
- **SFX audible + ducking** (4.20.1 — LIVE): Sam heard nothing — the cues fired
  but were MASKED by the full-volume music preview (gains ≤.16 sine under a
  phone speaker). Fix: `duck(ms)` dips `aud().volume` to .25 during a cue and
  steps back .6→1 (timers cleared + volume reset in playClip so a duck never
  outlives its cue into the next clip; iOS ignores media volume — cues just ride
  on top there), and the tones got louder/richer (triangle+sine layers, gains
  .22–.34). uichrome §6 plays a silent data-URI wav and asserts dip .25 →
  recover 1. EMAIL: DONE (4.21.2). DNS moved to
  Cloudflare (NS maxine/newt.ns.cloudflare.com at TransIP registrar; 9 records
  mirrored, ALL grey/DNS-only — site still direct to GitHub Pages, proxy
  deliberately OFF). Email Routing active: MX route1/2/3.mx.cloudflare.net +
  SPF live (verified via authoritative DNS), rule contact@playyearworm.com →
  samkarsten@gmail.com (catch-all=Drop). First forwards land in Gmail spam —
  Sam marked Not-spam + filter "to:contact@ → never spam". Public address
  swapped everywhere: index.html footer ×2, privacy.html ×2, wrangler
  VAPID_SUBJECT, worker fallback (was hello@ — inconsistency fixed). Optional
  later: DMARC p=none TXT (Cloudflare recommendation banner).
- **Chrome sweep** (4.20.0 — LIVE): the icon rule applied everywhere — `ico(name,
  inline)` renders text-size (`.ico.ii`, 15px, 13px in eyebrows) inside buttons/
  headers. Swept: 🔗→link (share-a-link buttons), 📤→share (code pills, invite,
  pass-on, send-result, report-fix), ⚔️→swords (ALL challenge/rematch buttons +
  pass-on row markers), 👥→users (friends eyebrows), 📡→pulse, 🕹→pad, 🔔→bell,
  🔊→vol, 🎲→dice, tut CTA 📅→cal. Kept as content: narrative rows ("X challenged
  you ⚔️" sentences), winner-emoji sheet heroes, achievements, reactions,
  verdicts, 🔥 streaks, 🟩🟥 squares, deck emojis, 🔐/🌍 copy. Tests updated
  (report/runmode click by text, social ovrow check) + uichrome §5. Play/TWA
  note: `.well-known/assetlinks.json` (com.playyearworm.twa) has been hosted
  since before — Play Console just needs Sam's 12-tester/14-day closed test.
- **Icon chrome + SFX** (4.19.0 — LIVE, "professional feel" picks #3/#5): (1) a
  consistent inline SVG line-icon set (`ICO` map + `ico(name)`, 24px grid, 2px
  round stroke, currentColor — lucide-style) replaces emoji for STRUCTURE: tab
  bar (note/users/trophy/user) and the 5 mode cards (cal/swords/users/bolt/
  target, stroke in each mode's accent color via the chip's style attr —
  modeCardHTML's chipColor param now carries "background:…; color:…"). Emoji
  remain for CONTENT (reactions, verdicts, badges, feed) — that's the rule.
  (2) synthesized WebAudio SFX, no assets: `sfx(kind)` with good (placement
  ding), bad (soft thunk), win (arpeggio), end (neutral close); hooks in
  chooseSlot (good/bad next to buzz), overlayRunOver (win if ≥4/5 else end,
  win for multiplayer turbo), overlayGameOver (survival: win on new best else
  end; classic winner: win), overlayTutOver (win). `tl_sfx` default ON ("0"
  disables), 🔊 toggle card on Profile under Notifications (turning ON plays a
  preview ding). Gains ≤.16 so cues sit under the music preview. Test:
  uichrome.js (4 sections). Next unbuilt from the professional-feel list: Play
  Store TWA (needs Sam's Play Console), content cadence (themed weeks).
- **Daily share image** (4.18.0 — LIVE, "professional feel" pick #2): sharing the
  daily now attaches a branded 1080×1080 PNG (Wordle's lesson: the artifact IS
  the ad). `dailyShareCanvas(d)` draws vinyl + wordmark (gold→cyan gradient,
  Rubik; Anton for the big score) + DAILY #n + score squares + ⏱/🔥 meta +
  playyearworm.com; `dailyShareFile(d)` gates on canShare/File/roundRect and
  returns null in any degraded env. `shareDaily()` shares {files,text} (the
  challenge link stays in the text caption); AbortError (user closed the sheet)
  does NOT re-prompt, any other share failure retries as plain text, and
  no-file-support targets get the old text share. Canvas letterSpacing used for
  the subtag (try/catch — not everywhere supported). Test: shareimg.js (4
  sections: png+link, no-file fallback, cancel = no double prompt, hard failure
  → text retry); leaderboard/runmode re-run green. Challenge/result shares stay
  text-only on purpose: there the link preview is the payload.
- **Guided first round** (4.17.0 — LIVE, the "professional feel" round pick #1):
  onboarding as a real 3-song run. Brand-new players (no tl_tut flag, 0 lifetime
  games, no saved game, no incoming challenge link) get a gold hero card on Play
  ("First time here? ▶ Play your first round") that replaces the intro paragraph.
  `S.mode="tut"` rides the existing run machinery: `TUT_LEN=3`, `tutSongs()`
  picks anchor+3+2 spares from stablePool near targets [1988,1964,2016,1975,
  1996,2005] with ≥6y separation (wide gaps = near-guaranteed early success; the
  lesson is the loop, not difficulty), deck order preserved (tut added to the
  no-shuffle/avail[0] paths). Coaching: stage hint "older or newer than <anchor
  year>?", `.tutpulse` slot glow until the first tap (reduced-motion safe),
  coached reveal copy (no flag block), HUD counts /3. `overlayTutOver()` finish
  sheet ("THAT'S YEARWORM!") funnels into startDaily() or backToSetup().
  Integrity: recordRunProgress is a no-op for tut (nothing burned), saveGame
  skips it, overlayRunOver reroutes to the tut sheet on a dry deck, backToSetup
  won't clearGame. tl_tut set at START (no re-nag after a quit); hero also hides
  once lifetime games>0. Test: tutorial.js (7 sections); runmode/leaderboard/
  oneshot/social re-run green.
- **Remove friend** (4.16.0 — LIVE): the server's `action:remove` (existed since
  the friends system) finally has UI — friend detail sheet → "Remove friend…"
  (muted, two-tap confirm: first tap arms it red "Sure? Tap again"). Deletes the
  pair row so the friendship disappears for BOTH sides, silently (no inbox row/
  push to the removed person). Duel history lives in `duels` and resurfaces if
  they re-add each other. social.js §5i covers armed-confirm + POST + roster
  refresh. Decision (advice round): NO email/password accounts — device token +
  Google link is the durability story; if a second recovery path is ever needed,
  prefer a passwordless email magic-link over storing passwords.
- **World-board avatars** (4.15.0 — LIVE): the daily Ranks board used to show
  initials for everyone but you, because `scores` rows are anonymous
  (nick + device token, no account link) while friends-standings come from
  socialState (synced avatars) — hence "Turbo Penguin has a face in Friends but
  a T on the world board". `board()` in worker.js now LEFT JOINs
  scores.device → devices → users to include `u.avatar` per top row (try/catch
  falls back to the old avatar-less query on ancient schemas; response maps
  `avatar: r.avatar || null`), and `ranksBoardHTML` renders non-mine rows with
  `avatarFor(t.avatar, t.nick)` (claimed profiles show their musician/emoji;
  unclaimed players keep the initial fallback). Covered by the worker
  integration test ("world board avatars" section — placed AFTER the streak-cron
  section, which needs Alice unplayed-today) + leaderboard.js regression.
- **Results-sheet declutter** (4.14.0 — LIVE, per the advice session): duel sheets
  drop the duplicate big n/5 (the you-vs-them scoreline IS the score) and squares+
  time merged to one line; the friend-chip "send straight to a friend" row is GONE
  from all results — replaced by ONE `openPassOnSheet()` (friends + share-link in a
  sheet; excludes chalTarget/reactTo; the old "🔗 Challenge a friend/someone else
  on these songs" buttons folded into it as "⚔️ Challenge friends"). Inbox duels
  get a [⚔️ Rematch (→challengeFriend)] [📤 Pass on] action row; link duels keep
  "Send your result back" + Pass on. Reaction row shows 6 + a "…" expander
  (#reactMore). The set board (#chalBoard) moved inside the songs toggle for chal
  runs. Daily sheet lost the redundant "playing as" nickname input (identity lives
  on Profile; profile rename still resubmits). Done sits in a sticky `.sheetfoot`
  (gradient, always visible — no more scrolling to exit). `S.passSet` carries
  {idx,score,timeMs} for the pass-on sheet. Tests updated across social/
  leaderboard/runmode (pass-on flow, expander, sticky foot, set-board in toggle).
- **Social round-out** (4.13.0 — LIVE, from the product-advice session):
  (1) *outstanding challenges*: `socialState` returns `sent` (my unseen challenge
  rows, handle-resolved) → ⏳ on the friend row + "· ⏳" on chal-out feed rows.
  (2) *reaction bundling*: `action:react` now MERGES the emoji into my unseen
  `result` row in their inbox (one message: "X played your challenge — 4/5 🔥");
  falls back to a standalone react row when no unseen result exists. Result rows
  + feed entries render `payload.emoji`. (3) *reaction set* grew to 12 incl.
  quick-phrases (🤯💀🐐 + "Rematch?"/"So close!"/"Lucky 🍀") — still a fixed
  server-validated list, no free text. (4) *react from the feed*: result rows are
  tappable → `openReactSheet` (react after the fact). (5) *declutter*: per-song
  recap sits behind a collapsed "Show the songs" `<details>` (lastLine restored),
  achievement tiles only show a count once progress > 0. Worker test covers
  sent-list + merge-vs-standalone react; social.js covers ⏳ row/feed markers.
  DECIDED against (see chat): avatar uploads (moderation/privacy/infra) and free-
  text chat (structured reactions stay a hard principle).
- **Profile alignment + 30 achievements** (4.12.0 — LIVE): stats are a real 3×2
  grid (`.statgrid`, no more ragged flex-wrap); the name field lost its full-width
  dashed underline (solid gold on focus only; the ✎ button stays the affordance).
  Achievements went 9 → **30** as a compact 3-up tile grid (`.achgrid`/`.ach`,
  tap → toast desc, done = gold tint): daily tiers (Regular/Devotee/Addict/
  Perfect Day/On Fire/Unstoppable/Champion/World Beater), duels & friends (First
  Blood/Duelist/Warlord/Gauntlet Thrower/Better Together/Squad/Entourage), skill
  (Speed Demon/Flawless/Perfectionist), survival (Survivor/Crate Digger/Hot
  Streak), volume (Getting Started/Century/Marathon/Bullseye/Collector/Librarian),
  meta (Deck Builder/Signed Up/Plugged In). New counters: `life.dailies`,
  `life.perfect`, `life.sent`, and `tl_daily.maxStreak` (best streak ever).
  leaderboard.js asserts 30 tiles + 2/30 after the stubbed daily.
- **Streak-saver push** (4.11.0 — LIVE): hourly Worker cron (`[triggers]` in
  wrangler.toml + `scheduled()` handler) nudges "🔥 Your N-day streak is on the
  line" at ~19:00 LOCAL time when the daily is unplayed and a streak ≥ 1 is at
  stake. Played/streak are computed server-side from the `scores` table (via the
  user's devices) — no new client reporting. `push_subs` gained `tz` (sent by the
  client in push-sub, minutes east of UTC) + `nudged` (last day nudged, once/day)
  via LAZY ALTERs in scheduled() (schema.sql only shapes fresh installs — plain
  ALTERs there would fail the CI's re-apply). Dead endpoints pruned on send.
  privacy.html mentions the stored tz offset. Worker test runs the real
  scheduled(): nudge fires once at crafted local-19:00, exact streak count,
  silent after playing; push.js asserts tz rides along.
- **Prototype challenge flow** (4.10.0 — LIVE): (1) the Challenges mode card opens
  a **friend picker** first (`openChallengePicker` — avatar rows → `challengeFriend`
  auto-send flow; "🔗 Anyone — share a link" → `startFreshChallenge`; no friends/
  offline skips straight to the link flow, so the 3 mode-card E2Es keep passing).
  (2) a **"Challenge sent to X!"** hero block on the results sheet (cyan card)
  replaces the one-line sent note. (3) duel verdicts render as the prototype's
  **big scoreline** — you-vs-them avatars around an Anton "4 – 3" colored by
  outcome, verdict text beneath (keeps the exact phrases runmode.js greps for).
  social.js: picker test (friends listed + link fallback + cancel) + updated sent-
  hero assertion.
- **Per-song run recap** (4.9.0 — LIVE): solo run results (daily/challenge/turbo)
  list every song in play order — 🟩/🟥 + year + title — from the new `S.runLog`
  (pushed per placement in chooseSlot, reset in startGame). The separate "last
  song" line is suppressed when the recap shows (it's the last row). The 🚩
  wrong-year report block stays. leaderboard.js asserts 5 recap rows.
- **Lifetime stats + 9 achievements** (4.8.0 — LIVE): new `tl_life` counters
  (`loadLife`/`bumpLife`) — `cards` bumps on every placement (chooseSlot), `games`
  on every finished run (overlayRunOver) or classic/survival end (overlayGameOver).
  Profile stats grid grew to 6 (Games, Cards placed + the existing 4, flex-wrap).
  Achievements 6→9 (matching the prototype's count): 🎯 Bullseye (250 cards
  lifetime), 🏅 Century (100 games), 👑 Champion (top-10 on a daily —
  `tl_daily.bestRank`, recorded from the lbSubmitDaily response). leaderboard.js
  asserts counters, Profile stats, bestRank recording, and the Champion unlock.
- **Recent games on Profile** (4.7.0 — LIVE): the second deferred prototype
  feature, filtered from the same `tl_feed` log (`recentGamesHTML` — kinds
  daily/duel/run/survival, max 8, between stats and achievements). New log points:
  solo turbo runs and fresh-challenge runs (`k:"run"`, kind turbo|challenge) in
  overlayRunOver, survival runs (`k:"survival"`, cards + new-best flag) in
  overlayGameOver. feedRowHTML gained the run/survival row types. leaderboard.js
  asserts the finished daily appears under "recent games".
- **Activity feed** (4.6.0 — LIVE, the deferred prototype feature): the Friends tab
  gained a "📡 recent activity" card built from a LOCAL event log (`tl_feed`, capped
  30, no server persistence). `logFeed`/`loadFeed`/`feedFromInbox` +
  `feedCardHTML`/`feedRowHTML`/`fmtAgo`. Logged events: finished dailies (score +
  streak), duel verdicts (win/loss/tie with score line), incoming challenges,
  challenges you send (`sendChal`), results on your challenges (they beat/tied/you
  held), reactions, new friends. Inbox-derived entries dedupe on message id (they
  vanish from state once seen — logged at receipt in socialGet/socialPost).
  Rendered in `friendsTabHTML` (#feedCard) and refreshed when fresh social state
  lands. social.js asserts in/out/duel rows render + no dupes on re-poll. This log
  also unblocks the Profile "recent games" list later.
- **Audit batch 5 — UI fixes** (4.5.2 — LIVE): Ranks friends-standings refresh in
  place when the social fetch lands (`ranksFriendsRows` + #ranksFriends, wired into
  afterLobby's socialGet callback — a cold `#tab=ranks` load no longer shows a stale
  empty state); Friends tab shows "Loading…" instead of flashing the "No friends
  yet" empty state on first visit; `role="button"` divs (challenge cards, ranks
  rows) respond to Enter/Space; Esc dismisses lobby sheets (never in-game overlays);
  a finished Daily card's tap now shares the result (`shareDaily`) instead of a dead
  toast; perfect 5/5 daily gets confetti; world board shows "top N%"; inactive tab
  labels bumped `--faint`→`--muted` (≥4.5:1); removed dead pre-4.0 CSS/JS
  (nickbar/nickchip + helpers, .daynum, .card.hero glow, .modecard.on, .diffs.duo,
  duplicate .modelist rule).
- **Audit batch 4 — push robustness + token hygiene** (4.5.1 — LIVE): (1) sw.js
  gained `pushsubscriptionchange` — re-subscribes with the old options and POSTs
  old+new endpoint to the new authless `/push-rotate` (auth = knowledge of the
  unguessable old endpoint URL), so browser-rotated subscriptions no longer die
  silently while the toggle says "On". (2) Google sign-in re-registers the current
  push subscription (`push-sub`) so notifications follow the account that just
  signed in, and adopts the returning account's avatar. (3) board fetches
  (`lbFetchDaily`/`lbFetchChal`) switched to read-only POST twins (`{read:1}`) —
  the device token is a bearer credential and no longer appears in URLs (GET stays
  for backward compat); leaderboard.js asserts no `device=` in any URL. (4)
  survival "Play again" restarts the background deck loader (startGame killed it
  via bgRun++), so a quick death + replay no longer hard-stops at ~15 songs with
  a false "deck ran dry".
- **Audit batch 3 — one-shot integrity** (4.5.0 — LIVE): (1) *quit-to-replay
  cheat closed*: daily/incoming-challenge progress is now persisted after EVERY
  placement (`recordRunProgress`, partial records carry `p:1`, finalized at run
  over) — abandoning a run mid-way burns the attempt with the score so far, so
  you can't peek at reveals and replay the same seeded set clean. test/oneshot.js
  covers quit→lock→reload for both modes. (2) *UTC-midnight rollover*: the puzzle
  number is stamped at run START (`S.dailyNum`) and used for the record, title and
  leaderboard submit (`lbSubmitDaily` day param) — finishing after midnight no
  longer books the score on the next day's board or locks you out of the real
  next daily. (3) *challenge-link resilience*: link-derived sets (no spares)
  resolve ALL songs before starting and abort cleanly (no lock) if any fail —
  no more burned one-shots on partial runs. (4) daily chal-records carry `d:1`
  and chalNews skips them (own-link card keeps working; strangers who play the
  world's daily no longer appear as "new results on your challenges").
- **Audit batch 2 — client state fixes** (4.4.4 — LIVE): (1) *avatar multi-device*:
  the avatar now syncs only when explicitly chosen (`tl_avatar` set); other devices
  ADOPT the server's stored avatar (`adoptAvatar` on every social response) instead
  of overwriting it with their device-seeded default, and `claimHandle` locks in one
  stable face at account creation. (2) `resumeSaved` clears `S.nextPick` (a card
  primed by another run could be dealt into the resumed game) and resets
  `S.turnStart` (another game's clock billed up to 60s of phantom time). (3) solo
  modes stash the Pass&Play roster (`stashRoster`/`S.prevRoster`, restored in
  `backToSetup`) so a quick daily no longer wipes 4 typed-in player names. (4)
  `onAudioFail` ignores media errors while an overlay is up — the looping clip
  erroring mid-reveal used to `skipTrack()` an already-placed card, corrupting
  `S.runCards` and double-advancing. (5) a notification tapped mid-game parks its
  target tab (`window._pendingTab`, honored on the next lobby render) instead of
  repainting the lobby over a live, unsaveable run.
- **Audit batch 1 — server fixes** (4.4.3 — LIVE, from a 3-agent codebase audit):
  (1) *Daily push-spam*: every run posted to /chal, so the world's FIRST daily
  finisher became `chal_owner` of the shared daily set and got a push per player.
  Client now sends `daily:true` (lbSubmitChal 4th arg) and the worker skips owner
  tracking for it, plus a belt-and-braces cap (no owner push once a set has >20
  players). The daily also no longer records as `m:1`, so chalNews stops listing
  strangers who played the daily. (2) *schema.sql fresh-install*: idx_logins_user
  was declared before the logins table → moved below it (a clean `--file=schema.sql`
  now works; verified against better-sqlite3). (3) *push-unsub* deletes by endpoint
  alone (row was stranded after a Google account switch). (4) *AVATAR_RE* emoji
  branch now requires non-ASCII only — no HTML-relevant chars storable.
- **No sending a challenge back to its sender** (4.4.2 — LIVE): the results
  screen's "send this set straight to a friend" list excluded only `S.chalTarget`
  (someone you'd just challenged), so after playing a friend's inbox challenge the
  original challenger still showed up — you could fire their own set back at them.
  Now the filter also drops `S.reactTo.user` (the challenger). A rematch is the
  "⚔️ Rematch — new songs" button (fresh set), not their set bounced back. social.js
  §5 now sends to another friend (Zoe) and asserts the challenger (Jesse) is absent.
- **Friend-challenge reply clarity** (4.4.1 — LIVE): playing a friend's *direct*
  (inbox) challenge already reports the duel result through the server, but the
  results screen + setup card also offered a "📤 Send your result back" link-share
  — which opens the share sheet and reads like creating a *new* challenge (the
  reported confusion). Now `playInboxChal` stamps `S.challenge.msgId`+`fromHandle`;
  when that's present the UI shows "✓ Result sent back to X" instead of the
  link-share. Anonymous `#c=` link challenges (no msgId) keep the link reply — it's
  their only way back. social.js §5 asserts the confirmation + absence of the link.
- **Push notifications** (4.4.0 — client LIVE; ⚠ needs a Worker deploy + VAPID
  secret + 2 D1 migrations to actually send): real Web Push (RFC 8291 aes128gcm +
  RFC 8292 VAPID) for four events — you're challenged, a new friend adds you, your
  shared challenge set is played, and duel results/reactions. **Client:** a 🔔
  Notifications toggle on Profile (`enablePush`/`disablePush`/`togglePush`) asks
  permission, subscribes via `pushManager` with `VAPID_PUBLIC`, and POSTs the sub
  (`action:'push-sub'`/`'push-unsub'`). `sw.js` gained `push` (showNotification) +
  `notificationclick` (focus/open at `./#tab=<t>` and postMessage the tab); the app
  routes that message and the `#tab=` deep link via `goTab`. **Worker:** pure-
  WebCrypto `pushEncrypt`+`vapidAuthHeader`+`sendWebPush`+`pushToUser`; a `push()`
  helper fires (via `ctx.waitUntil`) at each inbox insert (friend/challenge/react/
  result) and on `/chal` submits by a non-owner (owner = first submitter, tracked in
  `chal_owner`). Dead endpoints (404/410) are pruned. All push DB/crypto is wrapped
  so a Worker without VAPID/tables is a silent no-op. **Crypto was validated
  out-of-band** (scratchpad): my encrypt/derive matches the `web-push` library
  (decrypt round-trip), VAPID signature verifies, and a better-sqlite3-backed run of
  the real worker.js confirms all 4 events emit decryptable pushes. Tests: test/
  push.js (client enable + deep link, Playwright) + test/swpush.js (SW handlers,
  node). **Owner setup (server/):** `wrangler secret put VAPID_PRIVATE` (paste the
  PKCS8 base64), the two CREATE TABLE migrations in schema.sql (push_subs,
  chal_owner), then `wrangler deploy`. VAPID_PUBLIC/SUBJECT are already in
  wrangler.toml + index.html. iOS needs the app added to the home screen.
- **Friend profile pictures** (4.3.0 — client LIVE; ⚠ needs a Worker deploy +
  D1 migration to fully light up): avatars now sync through the social backend so
  you see each friend's chosen picture, not just an initial. Client sends its
  avatar token (`currentAvatarKey()` — explicit `m:NN`, legacy emoji, or a musician
  seeded from the device id) in every `/social` POST; `avatarFor()`/`friendAvatar()`
  render a friend/user object's `avatar` (SVG for `m:NN`, emoji, else initial) in the
  friends card, ranks standings, standings sheet, and challenge inbox rows. Worker:
  `users` gains an `avatar` column; `handleSocialPost` persists `b.avatar` (wrapped
  in try/catch), `socialState` batches avatars into friends/requests/inbox/me. All
  avatar DB ops are wrapped so a server running *before* the migration can't 500 —
  it just returns no avatars (client falls back to initials). **Owner deploy step:**
  `wrangler d1 execute yearworm --remote --command "ALTER TABLE users ADD COLUMN avatar TEXT"`
  then `wrangler deploy` (in server/). social.js asserts a synced friend avatar
  renders + own-avatar is sent.
- **Invite-link claim popup** (4.2.2 — LIVE): opening a friend invite link
  (`#add=CODE`) without a profile now pops up a claim-a-name sheet
  (`overlayInviteClaim`/`claimFromInvite`, once per session via `_invitePrompted`)
  instead of a passive toast; on claim the friend is auto-added and you land on the
  Friends tab. If you already have a name, the link auto-adds and jumps to Friends
  too. `tryPendingAdd` drives both branches; `claimHandle` now returns success.
  social.js §7 updated to the popup flow.
- **Avatar hair fix** (4.2.1 — LIVE): reworked the musician hair so it sits right —
  every style now starts from a skull-hugging "cap" (follows the head curve, clean
  hairline) with style-specific volume layered on top, instead of loose shapes with
  hard/floating edges. Stopgap while we plan a proper illustrated image-set swap
  later (the easy avatar APIs are proxy-blocked; can't draw raster art; artist
  photos are off-limits — so a curated open-source image set, sourced by us or
  provided by Sam, is the eventual path).
- **Generated musician avatars** (4.2.0 — LIVE): replaced the 60 emoji with 60
  procedurally-drawn "music legend" cartoon avatars — pure SVG, composed from
  simple shapes (hair/facial-hair/glasses/hats/headphones/earrings/outfit/skin/
  bg) into recognizable archetypes (Elvis pompadour+sideburns, 80s beehive pop
  queen, punk mohawk, disco afro, rapper cap, DJ headphones, cowboy country,
  reggae dreads, long-haired rocker, crowned pop royalty, round-glasses
  songwriter, grey legends…). All in one `MUSO` IIFE (`MUSO.avatar(cfg)`,
  `MUSO.list` of 60, `MUSO.hash`). Fully offline, no assets/network. `myAvatar()`
  returns the chosen `m:NN` (or a legacy emoji, or a musician seeded from the
  device id as the default — so everyone starts with a face, not an initial).
  Picker is a 6×10 SVG grid + a 🎲 Surprise-me shuffle. Avatar containers gained
  `overflow:hidden` so the square SVG clips to the circle. leaderboard.js checks
  60 SVG options + pick/persist.
- **Avatars in the lists** (4.1.1 — LIVE): your chosen avatar now shows beyond
  the Profile — a "you" identity row atop the Friends list (avatar + name + edit),
  and on the world daily board your row carries `myAvatar()` (others get their
  initial via `avat(nick)`). Fixed a pre-existing bug where `.ovrow span` forced
  every span (incl. `.avatar`) to 76px, stretching the friends-standings avatars
  into ovals — now scoped to `span:not(.avatar)`; added `.avatar.sm` (27px) for
  board rows.
- **Profile polish + emoji avatars** (4.1.0 — LIVE): identity card re-laid-out
  (avatar + name + subline aligned; name now reads as an editable field — dashed
  underline + a ✎ button that focuses it). New **profile-picture picker**: tap the
  avatar → sheet with a 6×10 grid of 60 curated emoji (`AVATARS`, `openAvatarPicker`/
  `pickAvatar`); choice saved to `tl_avatar` and shown in the gold ring (`myAvatar()`
  = chosen emoji else name initial). Kept as emoji so the app stays single-file /
  offline — no image assets, no network. leaderboard.js gained a pick+persist check.
- **Tabbed lobby restructure** (4.0.0 — LIVE): the setup screen is now a 4-tab app (Play/Friends/Ranks/
  Profile) built to the user's own Claude-designed artifact
  (design/concept-D-reference.html). `renderSetup()` became a router on module
  state `_tab` + `_playScreen`; the Play home is a 5-card **mode list**
  (`.modecard`), each mode opening a config screen (`configScreenHTML`, holds
  players/decks/length + the unchanged Start buttons — Turbo is its own mode
  now). New identity: **Rubik + DM Mono** fonts, warm **amber #F6B93B / mint
  #5EE0D6** palette, gradient wordmark + spinning vinyl. All game logic /
  sheets / social backend UNCHANGED; 15 test suites migrated to the new nav
  (test/NAV-4.0.md) and green. MILESTONE 2 done: the game screen
  gained the artifact's signature spinning-vinyl mystery record (`.gvinyl` — grooves
  + a rotating light glint + gold→cyan label with a spindle hole, no glyph; the glint
  and label carry the spin since concentric grooves alone read as static) and the
  reveal/sheets read cleanly. MILESTONE 3 done:
  Ranks tab shows the REAL /daily world board (`ranksBoardHTML`, top-10 + your
  row) + friends standings; Profile has a computed achievements grid
  (`achievementsHTML`, 6 badges from real local + social data). Shipped to main
  (playyearworm.com); server/worker.js untouched so it was a Pages redeploy only.
  See design/PROMPT.md §10.
- **Game-hub skin** (3.6.0 — Concept C, chess.com × SongPop, chosen from
  three researched design concepts; delta log in design/PROMPT.md §9):
  tactile bevel buttons (darker bottom edge, compress on press) on
  .btn/.diff/.dchip; .pink is now the filled-CYAN social CTA (play-back/
  challenge); deck chips = playlist-cover tiles with nth-child duotone
  washes; initial-circle avatars (avat()) on friend + inbox rows; daily
  hero gained a gold "#N DAILY" daynum block (eyebrow no longer carries
  the number); fixed bottom tabbar on setup only (Home/Friends with
  unseen-badge/Standings→friendsOverview/You→#youSect anchor), startbar
  docks above it via #app:has(.tabbar); friend code in Anton. All 15
  suites pass unmodified.
- **Coherent-UI pass** (3.5.0 — research-driven redesign; brief in
  design/PROMPT.md, evidence in design/RESEARCH.md): token-first reskin,
  DOM/selectors untouched (all 15 suites pass unmodified). Surface ladder
  --bg/--s1/--s2/--s3 (+~6% luminance steps) replaces border-everywhere —
  cards/chips/inputs/sheets are flat surfaces with transparent borders
  (inline border-color accents still work). Accent roles (60-30-10): gold
  ONLY on the ONE filled primary per view (sticky Start bar / a sheet's
  primary) + daily hero + active selections; cyan = online/social/live;
  violet RETIRED via token alias to muted. Eyebrows/sect quiet by default
  (11px/.14em muted) — color earned: daily gold (.card.hero glow =
  signature), 🌍 online + challenge cards cyan. .btn hierarchy: primary
  filled gold (#231500 ink text), secondary s2 no-stroke, .pink → gold-text
  on s2, ghost muted; 48px min heights; focus-visible cyan outline.
  Contrast audited: text ≥12:1, muted ≥5.7:1, CTA 11.6:1 (AA everywhere).
  Radius tokens r-ctl 10 / r-card 14 / r-hero 18 / r-sheet 22.
- **Challenge bundling** (3.4.2): inbox challenges group per sender into
  ONE row — "X sent 5 challenges — next: beat 4/5"; ▶ Play starts the
  OLDEST first (fair queue, count shrinks as you play), and bundles (n>1)
  get a ✕ `dismissChals(from)` that marks the sender's whole pile seen.
  Single challenges render exactly as before. Tests: social.js §4a.
- **Invite-first empty state** (3.4.1): a just-claimed profile with zero
  friends leads with a big pink "📤 Invite a friend" button (same shareCode
  share sheet as the code chip) + explainer; the add-by-code input gained a
  "Got a friend's code?" label. Tests: social.js §1b.
- **Standings sheet** (3.4.0): the "👥 friends ▸" header (`.eyebtn`, profile
  variant only) opens `friendsOverview()` — every friend in one table:
  name | all-time (👑, ties as "+N") | last-7-days, same duel-count sort as
  the card; each `.ovrow` drills into `friendDetail`. Friend names restyled
  from dotted-underline text to pill buttons (`.frname`). Tests: social.js
  §5h.
- **Friend detail sheet** (3.3.0): tapping a friend's NAME (`.frname`,
  now a pill button) opens `friendDetail(id)` — all-time record,
  a ROLLING last-7-days line (👑 you lead / they lead / dead even), the
  most recent duels ("yesterday · you 5/5 vs 4/5 🏆") and a ⚔️ Challenge
  button. Server: socialState's duel aggregation now also returns per-friend
  w7/l7/t7 + `recent` (≤6 rows {r,mine,theirs,at}, newest first — the duels
  SELECT gained score_a/score_b/created ORDER BY created DESC). Old clients
  ignore the extra fields. Tests: worker.mjs (7-day window + recent shape),
  social.js §5g.
- **Audit hardening** (3.2.3 — four-agent codebase review): (1) a pending
  challenge LINK no longer hijacks a later daily/turbo run's recording
  (overlayRunOver only uses S.challenge when mode==='challenge'); (2) inbox
  challenges are consumed (seen) at the RESULTS screen, not on ▶ Play — an
  aborted start keeps them, and an already-played set auto-reports the
  recorded score as the duel result; (3) playAgain resets S.loadingMore
  (was: eternal "Loading more songs…" after replay); (4) nextTurn's
  starvation wait is bgRun-guarded (quit no longer resurrects the game) and
  escapes after ~60s when netTrouble-but-online; (5) daily one-shot also
  checks the puzzle NUMBER (west-of-UTC replay hole); (6) skipTrack removes
  dead songs from S.runCards (links carried never-played tracks);
  (7) resume: restarts the background loader (sel saved, deckSeen rebuilt),
  restores per-player timeMs, forces S.turbo=false; (8) finishing a run no
  longer clearGame()s an unrelated saved classic; (9) replay anchors clear
  stale wrong flags. Server: POST /social action 'state' (socialGet now
  POSTs — token out of URL logs), timeMs clamped on challenge/result, JWKS
  fetch failure no longer cached 1h, friends(b)/logins(user_id) indexes.
  UI/PWA: sw.js index.html fallback navigations-only + no-cache install;
  .sheet scrolls (max-height 88dvh); dialog semantics + focus via
  showSheet(); toast aria-live + pointer-events:none; errbar keyboard;
  esc() escapes '; nested card buttons aria-hidden; #friendsCard + .card
  margin; privacy.html rewritten (accounts/Google/Cloudflare disclosed).
  NEW tests: resume.js (save→reload→resume integrity + loader restart),
  survival.js (lives, RUN OVER, best), runmode daily-lock-reload, worker
  state action. Known/accepted: in-memory rate limiting, no friendCode
  collision retry, client-trusted scores, GIS-overlay branding bend.
- **Next-clip preloading** (3.2.2): the next turn's card is pre-picked
  (`S.nextPick`, chosen by `primeNext()` right after the live clip starts)
  and its preview warms in a hidden `<audio id="pre" muted>` element — turn
  handoffs (worst in pass & play) no longer start a cold download. drawCard
  consumes nextPick first if still playable; seeded modes pre-pick avail[0]
  so daily/challenge order is IDENTICAL (determinism guarded by runmode
  tests). If the deck was too thin to pre-pick, loadRest retries after each
  batch. startGame clears nextPick. #pre never plays (no iOS-unlock risk).
  Tests: passflow.js (primed + primed-card-is-next asserts).
- **Challenge from the friends card** (3.2.0): every friend row has a ⚔️
  button → `challengeFriend(id)` sets `S.chalTarget` (AFTER
  startFreshChallenge; startGame clears it, same pattern as S.reactTo) and
  on the results screen the gauntlet AUTO-SENDS (`sendChal`) with a
  "⚔️ Sent to X — you set N/5 to beat" line; the target is filtered out of
  the manual direct-send row. Friend rows replaced the separate "⚔️ duels"
  section: one row per friend = name + duel record (👑/red, sorted by duel
  count) + ⚔️. Tests: social.js §5e/§5f.
- **Instant add-by-code** (3.1.1): adding by code creates an ACCEPTED
  friendship immediately — sharing your code IS the consent, so the code
  owner no longer gets an accept chore for someone they invited themselves.
  Instead they get an inbox kind 'friend' note ("X used your code — you're
  friends now!", dismissible). The accept/decline path + requests UI stay
  for legacy pending rows (pre-3.1.1) only; remove still un-friends.
  Codes are unguessable (6 chars, no-lookalike alphabet); leaking one is
  self-inflicted and recoverable via remove. Tests: worker.mjs social block
  (instant + legacy-pending accept), social.js §3/§5e.
- **Friend invite links** (3.1.0): the code button on the friends card now
  SHARES (navigator.share via shareText, clipboard fallback) an invite:
  code + `https://playyearworm.com/#add=YW-XXXXXX`. boot() arms the code in
  `tl_pendingAdd` (hash stripped via replaceState, GoatCounter event
  open-invite-link); `tryPendingAdd` runs after socialGet on setup and after
  a successful claim — with a profile it fires addFriendCode automatically
  (one tap: open link → claim name → instant friendship since 3.1.1), without one it toasts
  "claim a name to add them". Own-code links are ignored. Tests: social.js
  §1b (share text) + §7 (arm → claim → auto-add).
- **Reply-flavored result share** (3.0.0): answering a
  challenge LINK used to share the same "beat me on the SAME songs" text —
  read like a fresh challenge instead of a result. Now `shareResultBack`
  (used when S.challenge.beat != null, and by the result card's Send result
  when the run wasn't mine) sends "I played your Yearworm challenge — 2/5,
  your 4/5 holds 👑 · Open for the verdict (or pass it on)". Same URL — still
  playable/forwardable by third parties; the original challenger opening it
  still lands on the verdict card. Run-over button relabels to "📤 Send your
  result back". Tests: runmode.js reply-share asserts.
- **Friends leaderboard + duels + confetti** (LIVE since 3.0.0): finishing an inbox challenge auto-posts `/social` action `result`
  (msg id + score + timeMs). Server resolves the duel against the challenge
  payload (score first, then fastest time, else tie), records it in the
  `duels` table (msg_id UNIQUE — the FIRST report stands, duplicates are
  no-ops) and drops an inbox kind 'result' message on the challenger
  ("X played your challenge — 5/5 · they beat you / you held it 🛡 / dead
  even"). socialState aggregates per-friend tallies (w/l/t from my
  perspective) onto each friends[] entry; SUPERSEDED by 3.2.0: the separate
  "⚔️ duels" section became per-friend rows (record + ⚔️ button) — see the
  3.2.0 entry above.
  Confetti: `confettiBurst()` (CSS-only fall animation, z-index 55 above the
  overlay, auto-removes, honors prefers-reduced-motion) fires on a WON solo
  challenge (link or inbox — score beat, or tie broken by faster time) and on
  the local-multiplayer WINS screen. Tests: worker.mjs duels block,
  social.js §5c/§5d/§5e.
- **Reactions** (LIVE since 3.0.0): preset-only reactions
  on finished inbox challenges — NO free text ever (moderation/CSAM liability
  decision; chat was explicitly rejected). Whitelist `REACT_EMOJI`
  ["🔥","😱","😂","👏","🎯","GG"], enforced server-side too (`/social` POST
  action `react`: 400 off-whitelist, 403 unless accepted friends; delivers
  inbox kind 'react' payload {emoji,score}). Client: `S.reactTo` set by
  `playInboxChal` AFTER `await startChallenge()` (startGame clears it), solo
  run-over sheet shows a `#reactRow` (buttons lock after one send, gold border
  on chosen); incoming reacts render in friendsCardHTML ("X reacted 😂 to your
  challenge") with a ✓ Dismiss button → `dismissMsg` posts seen. Tests:
  worker.mjs reactions block, social.js §5a/§5b.
- **Social layer** (LIVE since 3.0.0): profile = claimed
  unique handle + friend code (YW-XXXXXX), keyed by the existing anonymous
  device token — no email yet; real login (email/OAuth) attaches to `users`
  later without migration. Server: `/social` GET (state: me/friends/requests/
  inbox) + POST actions claim/add/accept/decline/remove/challenge/seen; tables
  users/devices/friends/inbox in schema.sql (additive — safe to deploy next to
  the live client). Client: `friendsCardHTML` in the ONLINE section (claim →
  code + add-by-code + request rows + inbox rows), `playInboxChal` starts the
  exact set with beat score, direct-send buttons on run results (`sendChal`).
  Claim adopts the handle as tl_nick. Tests: worker.mjs social block +
  test/social.js.
- **Connection resilience** (2.9.1–2.10.0): `resolveBatch` retries once on an
  empty lookup (flaky net recovers, free when the first call works); pre-start
  buffer grows on slow connections (`FIRST = players*3+6`, still starts at the
  small `MIN` when fast). Watchdog: `noteLookup(ok)` + window online/offline →
  `setNetTrouble` shows a `#netbanner` reconnecting pill (3 empties in a row, or
  browser offline; a good lookup clears it). Audio `waiting`/`stalled` → `#bufNote`
  "buffering…", cleared on `playing`. nextTurn's starvation wait is
  connection-aware: "Waiting for connection…" and patient (no hard game-over)
  while offline, ~24s grace when online. Tests: connection.js, badnet.js.
- **Daily leaderboard** (LIVE since 2.3.0): API at
  https://yearworm-api.samkarsten.workers.dev (Cloudflare Worker + D1,
  deployed via .github/workflows/deploy-api.yml on server/** pushes to main;
  needs the CLOUDFLARE_API_TOKEN repo secret — it's an ACCOUNT-owned token,
  hence account_id pinned in wrangler.toml). `server/` holds
  a Cloudflare Worker + D1 (endpoints /health, GET+POST /daily; one-shot
  upsert — first score stands, resubmits only refresh the nickname; rank =
  score desc, time asc, created asc; CORS locked to playyearworm.com +
  localhost). Client side: `LB.url` const (empty = all leaderboard UI hidden),
  `deviceId()` random token in tl_device, nick in tl_nick, submit on daily
  run-over, rank+top-3 on results, mini-rank on the setup card. Owner setup
  steps in server/README.md; on go-live also update privacy.html (nickname +
  score leave the device). Tests: test/worker.mjs (run with
  `node test/worker.mjs`... it's an ESM file with top-level await) and
  test/leaderboard.js.
- **Challenge-set boards** (2.4.0): every finished run on a shared set POSTs
  to /chal (setkey = pool indices joined) — one-shot per device server-side.
  Results sheet + all setup challenge cards show the set's board
  (`chalOthersHTML`, div#chalSetBoard/#chalBoard); `chalNews()` checks up to
  3 recent OWN sets (tl_chals entries with m=1, `at` ts, seen-count `n`) and
  shows a "new results on your challenges" card once per new player.
- **Challenge result cards** (2.1.0): the send-back link IS the notification
  channel (no backend). Opening a scored link (`&s=`) for a set you've played
  shows a verdict card (their score/time vs yours, tie → time) with Rematch
  (new fresh challenge) + Send result. Your own link echoing your own
  score/time falls through to the "your challenge" card (ownEcho check).
- **Seeded sets are era-clustered** (v36): `seededIdx()` picks every song
  (anchor included) inside a ±`RUN_YEAR_SPAN` (8y) window around a seeded
  center year, widening only in sparse eras — tight gaps are the difficulty.
  Used by the daily AND fresh challenges; incoming challenge links carry
  explicit indices so old links still work. Tune with `RUN_YEAR_SPAN`.
- **Turn clock (tie-breaker)**: `S.turnStart` set in `nextTurn`, accumulated
  into `p.timeMs` in `chooseSlot` via `turnElapsed()` — capped at
  `TURN_CLOCK_CAP` (60s) per turn, and time while the page is hidden (locked
  phone / app switch) is parked out via the `visibilitychange` handler.
- **Year-correction reports**: LIVE (v33). Reveal's 🚩 block shows a "report"
  button; `reportYear()` POSTs title/artist/old/new year/build no-cors to the
  owner's Google Form (`REPORT` const holds the formResponse url + entry ids;
  responses land in a linked Sheet). Owner-reviewed, never auto-applied.
  Privacy page already discloses it. Field-order assumption: entry ids were
  taken from a pre-filled link in form question order (Title, Artist, Old
  year, New year, Build) — if Sheet columns ever look swapped, re-map there.

## Architecture notes (where things live in index.html)
- `const DECKS = [...]` — 12 themed deck literals (still present, but hidden).
- `const EXTRA_SONGS = [...]` — large flat song pool (~1961 entries).
- `const PARTY_SONGS = [...]` — curated party-anthem list (793 unique) used to
  build the Party deck by key-matching against the pool.
- `(function buildBigDecks(){...})()` — builds a **deduped shared pool** from all
  themed decks + EXTRA_SONGS + PARTY_SONGS, then unshifts the 5 launch decks and
  `DECKS.splice(5)` to hide the themed ones. Song object shape:
  `{year:N, artist:"...", title:"..."}`.
- Deck picker: `deckChipHTML()` / `deckCarouselHTML()` (side-scroll, pages of 6),
  `toggleDeck()`, `tallyHTML()`/`updateTally()`.
- Playback: `unlockAudio()` (silent-WAV unlock), `playClip()`, `wireAudio()`,
  `onAudioFail()` (auto-skip dead previews), `pickBest()` (requires BOTH a
  title and artist match — artist-only used to allow wrong-song swaps; filters karaoke/tribute
  via `BADVER` regex, requires a real `previewUrl`).
- Loading is throttled/progressive: `resolveInitial`, `loadRest`, `resolveBatch`,
  `bgRun` cancel token — first few songs load, rest stream in the background.
- Visualizer: Web Audio `AnalyserNode` gated behind a CORS probe
  (`fetch(url,{mode:'cors'})`), falls back to CSS bars if cross-origin audio
  can't be routed (routing it without CORS would mute playback).
- localStorage: `tl_game` (resume), `tl_decks` (custom), `tl_years` (year
  overrides), `tl_best` (survival/turbo bests), `tl_daily` (daily streak/lock),
  `tl_chals` (played challenge-set ledger), `tl_user` (social profile),
  `tl_nick` (board nickname), `tl_device` (anonymous API token),
  `tl_pendingAdd` (armed invite code).

## Current deck lineup (all capped at 600)
| Deck          | Size | Range / theme            |
|---------------|------|--------------------------|
| Every Era     | 2187 | whole pool, any year (superset, hardest) |
| The Classics  | 600  | 1950s–1989               |
| The Hits      | 600  | 1990–2009                |
| Now           | 600  | 2010–now                 |
| Party Anthems | 600  | every era · dance floor  |

Chips show "600 songs · <range>". Every Era is intentionally the superset (holds
songs the 600-capped era decks drop) — not obsolete.

## Look & feel
- Palette: **teal + amber/gold** on a dark synthwave base. CSS tokens:
  `--gold:#FFC24B`, `--cyan:#8CEBFF`, base `#03050D`. (Deliberately moved off the
  hot-pink `#FF2F9E` to avoid looking like Hitster.)
- Icon: equalizer bars, amber→cyan gradient. (Was generated from an SVG via
  headless Chromium in a since-discarded session scratchpad — regenerate by
  redrawing the equalizer-bars SVG if ever needed.)
- Alt palette directions considered but not applied: electric lime + indigo;
  coral + teal. Easy one-pass swap if we want to compare.

## Testing / dev workflow
- Syntax check: extract the big inline `<script>` and `node --check` it.
- **Regression suites (in repo): `test/*.js` — 15 headless-Chromium suites**,
  one per feature area (passflow, runmode, social, leaderboard, worker.mjs unit,
  connection, badnet, clock, yearfix, report, cluster, spares, fairround,
  resume, survival). Common recipe: stub the iTunes JSONP with a Playwright
  route (echo the search term so `pickBest` matches), serve a local WAV as the
  preview, run with `serviceWorkers:'block'` (SW-mediated fetches bypass route
  interception and starve the deck). Needs `playwright-core` + Chromium at
  `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`. Run any suite with
  `node test/<name>.js`; each prints `… PASS ✓` on success.
- Content generation: parallel `general-purpose` agents write song JSON files,
  then a node integrate script cleans (`&amp;`→`&`), dedups by
  `norm(title|artist)`, and splices into `index.html`.

## Done recently
- Grew The Classics 517 → 600 (added 135 worldwide-famous pre-1990 songs).
- Added Party Anthems deck (600, all-era).
- Deck chips lead with song count + year range.
- Reskinned to teal + amber/gold; regenerated icon.
- Bumped SW cache to `yearworm-v2`.
- Promoted the iTunes rewrite to `main` (fast-forward); saved the old Spotify
  version as branch `old`. (`previews-rewrite` still leads with newest work.)
- **Android PWA hardening** (SW `yearworm-v3`): manifest `id`/`scope`/
  `orientation:portrait`/`categories` + `any`/`maskable` icons + 2 install
  screenshots; `viewport-fit=cover` + safe-area insets; apple/mobile PWA metas.
  Verified installable in headless Chromium. It's now installable on Android
  Chrome ("Add to Home screen").
- **Year-conflict pass**: found 78 songs stored with two different years across
  decks; resolved each to one canonical original-release year (WebSearch-verified
  via 4 agents), unified 103 literals. Re-scan confirms 0 remaining conflicts.
  Rule: earliest commercial release; for remix-hits use the famous version's year
  (Cheerleader→2014, Another Night→1994, 3 A.M. Eternal→1991).
- **Full year-accuracy sweep**: 12 agents audited all 2187 songs (WebSearch-
  verified), flagged consistently-wrong years. Applied 75 corrections (113
  literals) — mostly viral-old songs stored at their viral year (Another
  Love 2022→2012, Take Me to Church 2014→2013, Macarena 1987→1996, TSwift
  Cruel Summer 2023→2019, Beggin'/Måneskin 2021→2017). Rejected 2 rule-
  violating flags (Cherish, All Summer Long — stored album-year was already
  correct). Re-scan: 0 conflicts. App boots clean.

## TODO / open items
- [x] ~~**Real-device test**~~ — **done** (phone test passed: install + previews
      play). iOS/Safari still untested but no longer launch-blocking.
- [x] ~~**Year-accuracy pass**~~ — **done**: 78 conflicts resolved + full 2187-song
      sweep (75 corrections). Follow-up done too: normalized 28 artist-spelling
      variants (62 literals), which collapsed 18 hidden duplicate songs
      (pool 2187→2169) and surfaced+fixed one more conflict (Night Fever→1977).
      Residual: `Marshmello — "Wow."` is probably Post Malone's song mislabeled;
      owner said leave it.
- [x] ~~**Yearworm domain + trademark check**~~ — **researched, looks clear**:
      no product/app/game named "Yearworm" exists anywhere findable; the
      "Earworm" board game (VStheUNIVERSE, Kickstarter/BGG) is a hum-the-song
      party game — different name, different mechanic, and "earworm" is a
      generic English word (weak mark). No active site at yearworm.com/.app;
      registry lookup blocked from sandbox, so **final 30-second availability
      check at a registrar is on the owner** before buying. Real comparable
      remains Hitster (mechanic can't be trademarked; name/trade-dress already
      avoided via rename + palette shift).
- [ ] **Legal/launch posture:** iTunes previews are tolerated promotional use,
      not a license. Plan: launch free, add a takedown contact, do the accuracy
      + device test before ship. Worst case = takedown email / API cutoff
      (recoverable).
- [x] ~~Decide whether to merge `previews-rewrite` → `main`~~ — **done**: `main`
      now holds the iTunes build (kept in sync by fast-forward); `old` holds the
      Spotify version. Housekeeping: stray branch
      `claude/yearworm-music-game-qe009n` should be deleted via the GitHub UI
      (sandbox permission blocked remote deletion).
- [ ] **Play Store (Android TWA)** — see `TWA.md` for the full recipe. Domain
      **REGISTERED: `playyearworm.com`** (`.com`, cheap tier; `.app` was pricey,
      `.com` works identically). `CNAME` committed + all placeholders point to it;
      package id set to `com.playyearworm.twa` (permanent once published).
      **Owner still to do:** (a) set DNS at registrar — apex A-records to GitHub
      Pages IPs 185.199.108–111.153 (+ AAAA 2606:50c0:8000–8003::153), `www`
      CNAME → `netsrakmas.github.io`; (b) Settings → Pages: set custom domain
      `playyearworm.com` + Enforce HTTPS (confirm Pages source branch has the
      CNAME); (c) set email forwarding `contact@playyearworm.com` → personal
      Gmail; (d) Play Console ($25) + build AAB (PWABuilder, no PC needed) + fill
      `.well-known/assetlinks.json` SHA-256.
      **Build-time note:** generate the TWA **with Play Billing capability
      enabled** even though launch is free — see monetization item below.
      **Prepped & ready** (in repo / `TWA.md`): `privacy.html` (Play requires a
      policy URL; app collects nothing → data-safety = "no data collected"),
      full listing copy, content-rating/data-safety answers, assetlinks template.
      **Still owner-only:** build the signed AAB on your machine (Bubblewrap),
      $25 Play Console, signing keystore — can't be done from the sandbox.
      **Asset-links needs a domain root**, so Play verification is gated on
      either buying `playyearworm.com` (recommended) or hosting assetlinks via a
      `netsrakmas.github.io` user-pages repo.
- [ ] **Monetization** — full strategy lives in `private/COMMERCIAL-NOTES.md` +
      `private/COMMERCIAL.md` (gitignored; the public repo stays engineering-only).
- [ ] **v2 idea — multi-device / remote multiplayer (DEFERRED, big feature).**
      Today's Pass & Play already covers *in-person* (one phone passed around);
      the unique value of multi-device is **remote play** (players in different
      locations). It's the biggest item on the roadmap: breaks the serverless-
      static model (needs a realtime backend), plus a lobby/room system, a
      networked source-of-truth state model, a game-loop refactor (`nextTurn`/
      `chooseSlot`/`overlayReveal`/`advance` broadcast+receive instead of mutating
      local `S`), and reconnection handling. Approach if pursued: a **managed
      realtime service** (PartyKit / Cloudflare Durable Objects, or Firebase /
      Supabase Realtime) — NOT hand-rolled WebRTC (signaling/STUN/TURN/NAT pain)
      or a self-run server. Free tiers cover a small launch. Build only if players
      ask for remote play; not needed for the free launch.
- [x] ~~(Optional) lime or coral palette experiment~~ — **compared** (rendered A/B/C
      side-by-side); **keeping gold + cyan** (best hierarchy, no good/bad-color
      collision, no Spotify-green association, branding already built on it).

## TWA build checklist (every AAB rebuild — PWABuilder)
- package id `com.playyearworm.twa` (permanent, must match Play Console)
- **Enable notifications** (= notification delegation → pushes read "Yearworm",
  not "Chrome · playyearworm.com"; without it web push stays browser-branded)
- **Play Billing capability ON** (build-time flag; paid decks later need no rebuild)
- SIGNING: reuse the ORIGINAL key (zip from the first PWABuilder build). A new
  key changes the SHA256 → hosted .well-known/assetlinks.json must be updated
  (else installed apps open with a browser bar). If rebuilt with a new key:
  update assetlinks.json fingerprint in the repo same-day.
- Upload: Play Console → closed track → new release → roll out.

## PLANNED — "Yesterday's recap" card (Sam: good idea, TOO EARLY — build when
~5+ friends play the daily most days, i.e. once the insiders group is alive)
Closes the "daily never settles" loop; opens the app before playing.
- Play-tab card, first open of the day: "Yesterday · Daily #n" → your FINAL
  rank ("#4 of 31"), then ≤3 friend duel lines ("😤 Jesse beat you — 5/5 in
  1:02" / "🛡 you held off Kim — 4/5 vs 3/5", ties 🤝). Dismissible; gone once
  today's daily is played. Didn't play yesterday → FOMO-light ("You sat
  yesterday out — Jesse took the top spot"); NOTHING to say → no card at all.
- Framing guardrails: lead with own result; rivalry lines after.
- Server: /daily already serves arbitrary days; NEEDS a friends-scores-for-day
  lookup (scores JOIN devices JOIN users vs friends list — the device→account
  join exists from the avatar work). Later: 09:00 push "yesterday is settled:
  Jesse edged you out 🥊" (cron exists for streak-saver).

## PLANNED — hosting move to Cloudflare Pages + private repo (Sam approved, "in a few days")
Goal: hide the readable source (repo private) while the site stays up; browser-
served client stays copyable by nature — this hides the recipe, not the cake.
- Phase A (zero-downtime order matters): 1) Sam: CF dash → Pages → Connect Git
  → repo Timeline, project `yearworm`, prod branch `main`, NO build cmd, output
  `/` → verify yearworm.pages.dev (app boots, daily, .well-known/assetlinks.json
  served, worker reachable). 2) Sam: Pages → Custom domains → playyearworm.com
  + www (DNS already on CF, auto-wired; GitHub Pages still live → no downtime).
  3) Sam: GitHub repo → Settings → visibility → PRIVATE (kills GitHub Pages,
  which by then serves nothing). 4) Me: remove CNAME file, update NOTES ship
  procedure (deploys = Pages auto-build on push to main; previews-rewrite gets
  free preview URLs). Worker CI unaffected (Actions works on private repos,
  ~1min/deploy ≪ free quota). GitHub MCP + git push flow unchanged.
- Phase B (a week later, optional): minified deploys — GitHub Action: minify
  index.html (terser/html-minifier on 8k-line inline JS = the risky bit) → run
  FULL E2E suite against the MINIFIED build → only then publish. Deterrence
  only, not security.

## Quick start for a new session
> Continue on the Yearworm music game (`/home/user/Timeline`, branch
> `previews-rewrite`). Read `NOTES.md` first. Single-file iTunes-preview timeline
> game. Next I want to ___.
