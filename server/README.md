# Yearworm API (daily leaderboard)

Cloudflare Worker + D1. No accounts, no personal data — a random device
token, a nickname, a score. One submission per device per daily (the first
stands; resubmits may only refresh the nickname).

## Endpoints
- `GET /health` → `{ ok, day }`
- `GET /daily?day=N&device=<token>` → `{ day, total, top[25], me:{rank,score,timeMs}|null }`
- `POST /daily` `{day, device, nick, score, timeMs}` → same shape as GET (incl. your rank)

Validation: day within ±1 of the server's daily number (UTC epoch 2026-07-01,
mirrors index.html), score 0..5, timeMs 500..350000, device `[a-f0-9]{16,64}`,
nick sanitized to 16 chars. Burst limit ~30 req/min/IP (best effort).

## Owner setup (one-time, ~5 min)
1. Free account on https://dash.cloudflare.com (no domain needed).
2. `npm i -g wrangler && wrangler login` (or set `CLOUDFLARE_API_TOKEN` with
   Workers + D1 edit permissions for headless use).
3. In this directory:
   - `wrangler d1 create yearworm` → paste the printed `database_id` into `wrangler.toml`
   - `wrangler d1 execute yearworm --remote --file=schema.sql`
   - `wrangler deploy` → prints `https://yearworm-api.<account>.workers.dev`
4. Put that URL in `LB.url` in index.html (top of the script, next to REPORT)
   and bump the build — the leaderboard UI turns on. Also update privacy.html
   (nickname + score leave the device when submitting a daily).

## Costs
Free tier: 100k requests/day, 5M D1 reads/day — orders of magnitude above a
small launch. No credit card required.

## Owner statistics

Open https://yearworm-api.samkarsten.workers.dev/stats and sign in with username
`stats` and the `STATS_KEY` password. Automated reads use `Authorization: Bearer
<STATS_KEY>` with `GET /stats?json=1`. Keys in query strings are rejected: never put
the password in a URL, public source, screenshots or issue comments. Responses
use `Cache-Control: no-store` and `Referrer-Policy: no-referrer` and expose no CORS.
An absent secret disables the route; missing or incorrect authentication returns
401. There is no public link to the dashboard in the game.

Store a cryptographically random key (at least 32 characters) as the repository's
GitHub Actions secret `STATS_KEY`. The API workflow runs tests, applies the existing
additive schema, verifies the remote `funnel` columns and primary key, and uploads
the secret atomically with the Worker code. Existing unrelated Worker secrets are
preserved. It then checks health, authorized/unauthorized access and aggregate
response shape without sending test events or printing statistics or secrets.

### Measurement definitions (4.52.0)

`funnel` contains only `(day, step, n)`, keyed by UTC game-day and event name.
The server allowlists event names and ignores other payload fields. No tokens,
names, addresses, IPs, challenge IDs, URLs or individual timestamps are stored.
The browser omits cookies and referrers on beacon requests. Existing per-IP rate
limits are in memory only; ordinary hosting request logs are separate from D1.

| Event | Counted when |
| --- | --- |
| `land` | App boots, once per page load. |
| `start` | First new round starts after enough songs resolve. |
| `finish` | A round started in this page load reaches its result screen. |
| `second-start` | Second new round starts in the same page load, in any mode. |
| `challenge-shared` | Native share resolves, clipboard copy succeeds, or direct friend send succeeds. Result links count too. |
| `challenge-opened` | A valid incoming link is parsed or an inbox challenge is opened. An already-played challenge can still be opened. |
| `challenge-played` | Recipient completes all five songs of an incoming challenge. Creating a challenge, partial runs and returning a previously saved score do not count. |

All events are capped at once per page load. The first four also send `-new`
when no local lifetime, daily or saved-game history existed at page load; that
classification is frozen before gameplay writes local history. Tutorials count
as rounds. Resuming a saved game never counts as starting a new game.

These are approximate page-level counts, **not unique people or a linked
share-to-recipient conversion rate**. One copied link can reach several people
or never be sent; clearing local data changes first-timer classification.
Analytics blockers, network loss, reloads and crossing UTC midnight affect the
numbers. Second-start and challenge events have no historical backfill. Before
4.52.0, first-time finish counts were understated because classification changed
as soon as a player made a move; historical first-timer rates are not comparable.

Daily retention uses distinct devices with submitted daily scores; survival uses
accounts with submitted standard-deck survival scores. These do not cover all
players or modes. `d7` means returned **at least once within days 1–7**, not exact
day-7 retention. Profile name counts are an existing generated-name heuristic.
The friendship count includes both sides of accepted friendships.

### Tests and rollback

Run `node server/stats-test.js`, `node test/worker.mjs` and `node test/funnel.js`
with Node 22+. Statistics tests use Node's in-memory SQLite and the actual schema.
They test retention math, privacy, authentication, event counts, missing tables,
share cancellation, failed loads, reloads, resumes and tutorial completion.

For a client regression, revert the release and bump both `BUILD` and the service
worker cache version. For an API regression, Cloudflare supports rolling back to
the prior Worker version. If that version predates protected header authentication,
remove `STATS_KEY` first so the old URL-key dashboard remains disabled. Do not drop
the additive `funnel` table or clear existing player records. Re-run `/health`
and the appropriate stats access checks after rollback.
