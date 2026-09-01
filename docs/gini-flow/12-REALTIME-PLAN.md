# Live updates for the board and the stations — full plan

**What this replaces.** Every Gini Flow screen polls: the Flow Manager every 10s, each station
every 15s (`src/queries/hooks/useGiniflow*.js`). A nurse presses **Done** and the coordinator's
board shows it up to ten seconds later; an MO orders tests and reception's desk is up to fifteen
seconds behind. On a floor where the whole point is that everyone is looking at the same visit
record, that lag is the product's weakest claim.

**What this is not.** This does not change what any screen shows. Every queue, every counter and
every card is already computed server-side and already correct — this changes only _when_ the
browser is told to ask again.

---

## 0. What is actually there today — verified, not assumed

| Fact                                                      | Evidence                                                                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Scribe database **is** a Supabase project             | `DATABASE_URL` → `postgres.vuukipgdegewpwucdgxa@aws-1-ap-south-1.pooler.supabase.com:6543`, and `SUPABASE_URL=https://vuukipgdegewpwucdgxa.supabase.co` |
| Realtime is **already enabled** on that project           | publications `supabase_realtime` and `supabase_realtime_messages_publication` exist                                                                     |
| …but no Gini Flow table is published                      | `supabase_realtime` contains exactly `patient_messages`, `conversations`                                                                                |
| `@supabase/supabase-js` is a dependency on **both** sides | client `^2.97.0`, server `^2.101.1`                                                                                                                     |
| A browser Realtime client pattern already exists          | `src/lib/genieSupabase.js` → `RoleInboxPage.jsx`, with a polling fallback when env vars are absent                                                      |
| …and it is currently **inert**                            | no `VITE_*_ANON_KEY` is set in `.env`, so `hasGenieRealtime` is `false` and the inbox polls                                                             |
| The server already talks to this project                  | `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` in `config/storage.js`, used for report storage                                                                 |
| `giniflow_*` tables have **RLS off**                      | `relrowsecurity = false` on `giniflow_visits`, `giniflow_visit_events`, `giniflow_lab_orders` — 17 of 120 public tables are in the same state           |
| `patients` and `appointments` have **RLS on**             | `relrowsecurity = true`                                                                                                                                 |
| The event log is append-only, uuid-keyed, low volume      | `giniflow_visit_events`: 348 rows total, ~245/day, `id uuid`, index `idx_giniflow_events_visit_time`                                                    |
| The connection is a **transaction pooler**                | port 6543 — `LISTEN`/`NOTIFY` and session advisory locks do not survive it                                                                              |
| Our auth already works without headers                    | `middleware/auth.js:18` accepts `?token=` — which is the only way `EventSource` can authenticate                                                        |

Two of these decide the whole design, so they are worth stating plainly:

1. **The pooler kills `LISTEN`/`NOTIFY`.** The obvious Postgres-native answer — the writer
   `NOTIFY`s, a listener pushes — is not available on port 6543, and moving to 5432 was tried and
   reverted for breaking production (it broke the cron advisory locks). Any design that needs the
   API and the worker to talk must use something other than the database's own notify channel.

2. **RLS is off on the Gini Flow tables.** The Supabase anon key is not a read-only convenience —
   it is a PostgREST credential. Handing it to a browser today grants read access to every public
   table that has RLS disabled, `giniflow_visits` among them. **This is the security question the
   rest of this plan is organised around**, and it is why the recommended option never puts a
   patient row on the wire.

---

## 1. Three options, honestly compared

### Option A — Postgres Changes, browser subscribes to the table

The textbook Supabase answer, and what `RoleInboxPage` does for messages: publish
`giniflow_visits` to `supabase_realtime`, and each station subscribes to `INSERT`/`UPDATE` on it.

**Why not.**

- It requires the anon key in the browser bundle, which today opens 17 RLS-off tables to anyone
  who reads the JavaScript. Fixing that is a project-wide RLS audit, not a Gini Flow task.
- Realtime authorises Postgres Changes through RLS, and **our users are not Supabase users** —
  the JWT is ours, signed by our own secret and validated against `auth_sessions`. There is no
  `auth.uid()` for a policy to test. Making one means either issuing Supabase-compatible JWTs or
  running a second identity system.
- The payload is the row. `giniflow_visits` carries `patient_id`, `category`,
  `blocked_reason` — a DPDP-relevant object crossing a socket we do not authorise per-user.
- A row change is not a screen change. The MO queue's shape depends on `giniflow_visits`,
  `appointments`, `giniflow_lab_orders`, `giniflow_vitals`, `giniflow_sd_notes` and `patients`.
  Subscribing to one table means either publishing six, or refetching anyway — in which case the
  row payload was never needed.

**Verdict: rejected.** Right tool, wrong shape of application.

### Option B — Supabase Broadcast, server publishes a signal

The server (holding the service key, never the browser) sends a Broadcast message on a channel
per day. The browser subscribes and, on any message, invalidates the right TanStack Query keys and
refetches **through our own authenticated API**.

The payload is a signal, not data: `{ kind: "visit", visitId, status }`. No name, no category, no
patient id needed — the client learns only _that_ something changed.

**Cost:** still needs the anon key in the bundle to open the socket (Realtime requires an
`apikey`), so the RLS exposure above remains — unless it is fixed first.

### Option C — Server-Sent Events from our own API, fed by an event tailer ✅ **recommended**

The insight that makes this simple: **`giniflow_visit_events` is already the bus.** It is
append-only, every station and the HealthRay sync write to it through `advanceStatus`, and it is
the single record of everything that happens on the floor. Nothing new has to be published
anywhere — something only has to _read_ it.

```
worker / API / any station write
        │
        ▼
giniflow_visit_events  ← append-only, ~245 rows a day
        │
        │  tailer: one cheap indexed query per second, inside the API process
        ▼
SSE hub  ──────────────► GET /api/giniflow/events?token=…   (one open connection per screen)
        │
        ▼
browser: queryClient.invalidateQueries(...)  →  refetch through the normal authenticated API
```

**Why this wins here.**

|                                    | Option B (Broadcast)                      | Option C (SSE)                                         |
| ---------------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| Anon key in the bundle             | required                                  | **not needed**                                         |
| RLS audit needed first             | yes                                       | **no**                                                 |
| Auth                               | Supabase's, which does not know our users | **ours** — `?token=`, already supported                |
| Cross-process (API ↔ worker)       | via Supabase                              | **via the events table itself**                        |
| New external dependency at runtime | Supabase Realtime                         | **none**                                               |
| Works if Supabase Realtime is down | no                                        | **yes**                                                |
| Missed events after a reconnect    | possible                                  | **impossible** — the client resumes from its watermark |

That last row matters more than it looks. A socket that drops during a reconnect silently loses
whatever happened while it was gone, and the screen keeps showing a stale queue with no
indication. A tailer with a watermark cannot: the client sends `Last-Event-ID`, the server replays
from there.

**Verdict:** build C. Keep B documented — if Gini Flow ever runs on a host that cannot hold long
connections, the tailer stays and only its transport changes.

---

## 2. What changes, file by file

### 2.1 The tailer — `server/services/giniflow/eventTailer.js` (new)

One loop, started once per API process.

```js
// Everything on the floor is already written to giniflow_visit_events. Reading
// it once a second is cheaper than six browsers each re-running the queue SQL
// every fifteen, and it cannot miss an event: the table is append-only and the
// watermark is monotonic.
const TICK_MS = 1000;
```

**Ordering needs a monotonic key, and `id` is a uuid.** Two ways:

|                                   | Migration                                                                                                  | Correctness                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **`seq BIGSERIAL`** (recommended) | `ALTER TABLE giniflow_visit_events ADD COLUMN seq BIGSERIAL` — 348 rows, a table rewrite of no consequence | exact; the watermark is an integer, and `Last-Event-ID` is that integer                                |
| `occurred_at` watermark           | none                                                                                                       | needs a lookback window and an in-memory seen-set to survive ties and clock skew; correct but fiddlier |

Take the migration. It also gives `Last-Event-ID` something honest to be.

The same tailer watches `giniflow_lab_order_events` (payment and sample moves, which do not touch
`giniflow_visit_events`) and `giniflow_vitals` (a reading saved without a status change). Three
cheap queries per tick, all on indexed columns.

### 2.2 The hub — `server/services/giniflow/eventHub.js` (new)

A `Set` of open responses. `broadcast(event)` writes one SSE frame to each. Rules:

- **Heartbeat every 25s** (`: ping\n\n`). Proxies and load balancers close idle connections at 30–60s
  and the browser sees a clean disconnect with no error.
- **Cap the connections** (say 100) and refuse politely beyond it, so a runaway tab loop cannot
  exhaust the process.
- **Never let a write to a dead socket throw** into the tailer.

### 2.3 The route — `server/routes/giniflow.js`

```
GET /api/giniflow/events?date=YYYY-MM-DD   capability GINIFLOW_VIEW
```

- `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`
  (nginx buffers SSE without it and nothing arrives until the connection closes).
- Authenticated by the existing middleware. `EventSource` cannot set headers, which is exactly why
  `?token=` exists in `middleware/auth.js:18`.
- `Last-Event-ID` (a header the browser resends automatically on reconnect) replays anything
  missed, so a tunnel drop or a laptop lid closing costs nothing.
- Filter server-side by `date`: a station open on today's floor is not told about a backfill of
  last week.

**Payload — deliberately thin:**

```
id: 4213
event: flow
data: {"kind":"visit","visitId":"…","status":"vitals_done","date":"2026-09-01"}
```

`kind` is one of `visit` | `lab_order` | `vitals`. No name, no category, no file number. The
client refetches through the API it is already authenticated against, so the socket never becomes
a second, less-guarded way to read patient data.

### 2.4 The client hook — `src/queries/hooks/useGiniflowLive.js` (new)

```js
// One connection per screen, not one per query. The server says what kind of
// thing changed; this decides which queries that invalidates.
const INVALIDATES = {
  visit: [
    ["giniflow", "board"],
    ["giniflow", "mo"],
    ["giniflow", "vitals"],
  ],
  lab_order: [
    ["giniflow", "reception"],
    ["giniflow", "lab"],
    ["giniflow", "mo"],
  ],
  vitals: [
    ["giniflow", "vitals"],
    ["giniflow", "mo"],
    ["giniflow", "board"],
  ],
};
```

- **Coalesce.** A patient moving fires several events in a second; invalidating on each would
  produce a burst of identical refetches. Debounce ~250ms per query key.
- **Never invalidate the query behind an open form.** The MO's plan textarea already pins its
  selection while typing (`pinned` in `MoStationPage.jsx`); live updates must respect the same
  flag, or a refetch will swap the patient out mid-sentence. Same for the vitals form.
- **Fall back, do not fail.** If the connection cannot be opened, or drops three times in a
  minute, the hook re-enables the existing `refetchInterval`. The screen degrades to today's
  behaviour rather than freezing — the same contract `genieSupabase.js` already follows.

### 2.5 The hooks that exist — `useGiniflow{Board,Mo,Vitals,Reception,Lab}.js`

`refetchInterval` becomes conditional: fast when live is off, slow (60s) when live is on. **Keep a
slow poll even when live works.** It costs almost nothing and it is the only thing that repairs a
socket that is connected but silently not delivering — a state that does happen behind corporate
proxies.

### 2.6 Where the "live" light goes

The rail already has room. `● Live` in green when connected, `◌ Polling` in grey when it fell
back. A coordinator watching a board that has quietly stopped updating is worse off than one who
knows it is on a fifteen-second delay.

---

## 3. Build order

| Step   | What                                                                      | Independently useful?                   |
| ------ | ------------------------------------------------------------------------- | --------------------------------------- |
| **3a** | Migration: `seq BIGSERIAL` on `giniflow_visit_events`                     | no                                      |
| **3b** | `eventTailer.js` + `eventHub.js`, logging only, no route                  | yes — proves the tailer sees every move |
| **3c** | `GET /api/giniflow/events`, capability + auth, heartbeat, `Last-Event-ID` | yes — testable with `curl -N`           |
| **3d** | `useGiniflowLive.js` + wire the Flow Manager only                         | **yes — the board goes live**           |
| **3e** | Wire the four stations; make `refetchInterval` conditional                | yes                                     |
| **3f** | The live/polling indicator                                                | yes                                     |
| **3g** | `smoke:giniflow-live`                                                     | —                                       |

3a–3d is the whole value: the board is the screen people watch. 3e is mechanical once 3d works.

---

## 4. How it gets tested

There is no test suite in this repo, so this follows the existing bespoke-smoke pattern
(`server/scripts/smoke-giniflow-*.mjs`).

`smoke:giniflow-live` — against the demo day, with the API running:

1. Open `/api/giniflow/events` with `fetch` and a reader.
2. `advanceStatus` a demo visit → assert a `visit` frame arrives within 2s carrying that visit id.
3. `orderTests` → assert a `lab_order` frame.
4. Drop the connection, move a patient, reconnect with `Last-Event-ID` → **assert the missed event
   is replayed.** This is the check that distinguishes this design from a naive socket.
5. Assert the frame contains no name, file number or category — the payload stays a signal.
6. Assert a frame for another day's visit does **not** arrive on a connection scoped to today.
7. Assert `flow_*` is untouched, as every Gini Flow suite does.

Static checks (`npm run check:giniflow`, `smoke-giniflow-render.mjs`) need the new hook to be
inert under SSR — `EventSource` does not exist on the server, so the hook must no-op rather than
throw.

---

## 5. Cost, in numbers

Six tablets open for a ten-hour clinic:

|                      | Today                                                                                    | With this                                                     |
| -------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Queue queries/day    | 6 screens × 4/min × 600 min ≈ **14,400**, each the full queue SQL with its lateral joins | **~245** — one per real event, plus a 60s safety poll         |
| Tailer queries/day   | —                                                                                        | 3 × 86,400 ≈ 260,000 single-index lookups returning zero rows |
| Open connections     | none                                                                                     | 6                                                             |
| Worst-case staleness | 10–15s                                                                                   | **<1s**                                                       |

The tailer's query count looks large and is not: an indexed `WHERE seq > $1 LIMIT 100` on a
348-row table is sub-millisecond, against a queue query that joins six tables and runs three
lateral subqueries per row.

---

## 6. Risks, and what each costs

| Risk                                       | Consequence                                                      | Mitigation                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| A proxy buffers SSE                        | nothing arrives until the connection closes; screen looks frozen | `X-Accel-Buffering: no`, heartbeat every 25s, and the live indicator makes it visible |
| Multiple API instances                     | each tails independently — this is fine, not a bug               | no sticky sessions needed; document it so nobody "fixes" it                           |
| Connection leak                            | file descriptors climb across a long day                         | cap at 100, remove on `close`, log the count                                          |
| A refetch storm on a busy morning          | ten patients move at once → ten invalidations                    | debounce per key; the queue query is the same one polling already runs                |
| An open form is refetched under the user   | the MO loses a half-typed plan                                   | reuse the existing `pinned` guard; **this is the one that will actually bite**        |
| Realtime quota (if Option B is ever taken) | connections capped by plan tier                                  | not applicable to Option C — the connections are ours                                 |

---

## 7. Open questions — answer before 3c

1. ~~**Does the production host allow long-lived HTTP responses?**~~ **Answered — see section 10.**
   Yes. Railway holds a response for up to 15 minutes while data keeps flowing. Option C stands.
2. **Is the API ever more than one process?** Not a blocker either way — the tailer is per-process
   and idempotent — but it changes the numbers in §5.
3. **Should the patient-facing `/visit/:token` tracker go live too?** It polls as well, and it is
   the screen a patient stares at while waiting. It is public and unauthenticated, so it needs its
   own channel scoped to the one visit, and that is a separate decision.
4. **RLS.** Independent of this plan, 17 public tables have RLS disabled, `giniflow_visits` among
   them. Option C means we do not need to fix that to ship live updates — but it stays true, and
   any future browser-side Supabase key makes it live. Worth a separate ticket rather than being
   quietly carried by this one.

---

## 8. What this plan deliberately does not do

- **It does not push data, only signals.** Every byte a station renders keeps coming from the
  authenticated API. That is what keeps the transport out of the DPDP conversation.
- **It does not remove polling.** The slow poll stays as the repair mechanism for a socket that is
  connected but silent.
- **It does not touch the retired `flow_*` module**, per the separation rule in `00-OVERVIEW.md`.
- **It does not change any queue, counter or card.** If a screen shows something different after
  this, that is a bug in this work, not a feature of it.

---

## 9. Built — 2026-09-01

Steps 3a–3g are complete. Option **C** was built as recommended; Option B stays documented, and
the tailer it would use is the same one, so switching transports later is a change to `eventHub`
alone.

| File                                                  | What                                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `server/migrations/2026-09-01_giniflow_event_seq.sql` | `seq BIGSERIAL` + index on the three insert-only event tables                                                  |
| `server/services/giniflow/eventTailer.js`             | one indexed `seq > watermark` query per table per second; primes from `max(seq)` so a restart replays nothing  |
| `server/services/giniflow/eventHub.js`                | open screens, a 500-event ring buffer, 25s heartbeat, 100-connection cap, per-day filtering                    |
| `server/routes/giniflow.js`                           | `GET /api/giniflow/events` (SSE) and `/events/status`, capability `GINIFLOW_VIEW`                              |
| `server/index.js`                                     | starts the tailer with the API                                                                                 |
| `src/queries/hooks/useGiniflowLive.js`                | one `EventSource` per screen; maps `kind` → query keys; 250ms coalesce; falls back to polling after 3 failures |
| `src/queries/hooks/giniflowPolling.js`                | 15s when live is off, 60s when it is on                                                                        |
| `src/components/giniflow/LiveBadge.jsx`               | `● Live` / `◌ Polling · 15s` / `Reconnecting…`                                                                 |
| `server/scripts/smoke-giniflow-live.mjs`              | 11 checks including the replay property                                                                        |

**Deviations from this plan, both small.** The `X-Accel-Buffering` header is paired with
`Cache-Control: no-transform`, because the compression middleware — not only nginx — will buffer a
stream without it. And the live/polling flag is a module-level value in `giniflowPolling.js`
rather than context: every screen has exactly one connection, and threading a prop through five
hooks to say the same thing would have been worse.

### Still to confirm

**§7 question 1 is unanswered:** whether the production host allows a long-lived HTTP response. The
code does not depend on the answer — if the connection cannot be held, `useGiniflowLive` gives up
after three attempts and the screen returns to 15-second polling, with the rail saying so. But
until someone watches a station tablet keep a connection for an hour, "live in production" is
unproven. The failure is visible rather than silent, which is the point of the badge.

---

## 10. Section 7 question 1, answered — 2026-09-01

Investigated against the live deployment, not from documentation alone.

### What is in front of the API

|             | Finding                                                                                                                                                                                                                   | How it was established                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host        | **Railway**                                                                                                                                                                                                               | `server: railway-hikari`, `x-railway-request-id`, `x-railway-edge: sin1` on every response; `README.md` §Deployment, `server/railway.json`, `server/Dockerfile` (`node:20-slim`) |
| DNS         | `scribe.ginihealth.com` → CNAME `2x7udroj.up.railway.app` → `69.46.46.42`                                                                                                                                                 | `getent hosts`, `dig`                                                                                                                                                            |
| Cloudflare  | **DNS only — not proxying.** `ginihealth.com` uses Cloudflare nameservers (`elsa`/`bowen.ns.cloudflare.com`), but no response carries `cf-ray` or `cf-cache-status`, and the address is Railway's, not a Cloudflare range | header inspection                                                                                                                                                                |
| Edge region | Singapore (`sin1`)                                                                                                                                                                                                        | `x-railway-edge`                                                                                                                                                                 |
| Protocol    | **HTTP/2** on `/` and on `/api/*`                                                                                                                                                                                         | `curl -w '%{http_version}'`                                                                                                                                                      |
| Proxy hops  | One: browser → Railway edge → Express                                                                                                                                                                                     | no `via`, no CDN headers                                                                                                                                                         |

### The limits that apply

| Limit                      | Value                                                                                                      | Source                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Max HTTP response duration | **15 minutes**, while data keeps transferring                                                              | Railway _Specs & Limits_                    |
| Idle close                 | **5 minutes** with no data transferred                                                                     | Railway _Specs & Limits_                    |
| Idle HTTP/1.1 connection   | 60s between requests — **does not apply to HTTP/2**, and production is HTTP/2                              | Railway _Specs & Limits_                    |
| Configurable?              | **No.** "The platform maximum HTTP request timeout is 15 minutes" — no plan tier or support path raises it | Railway staff, support thread               |
| SSE supported?             | **Yes**, with a documented guide and one requirement: a heartbeat at least every 5 minutes                 | Railway _Choose Between SSE and WebSockets_ |

There is no 30s, 60s, 100s or 150s cap anywhere on this path.

### The Node-side timeout, measured

`server/index.js:192` calls `app.listen()` with no overrides, so Node's defaults apply:
`requestTimeout: 300000`, `headersTimeout: 60000`, `keepAliveTimeout: 5000`. That 300s is the exact
number Railway support attributes to applications rather than the platform, so it was tested rather
than reasoned about: a bare `http.createServer` with identical defaults and this design's 25s
heartbeat **held a stream past 300s and was still delivering at 400s**, ending only when the test's
own clock stopped it. `requestTimeout` governs receiving a request, not streaming a response.

`compression` was also verified not to buffer the stream: its `shouldTransform` skips any response
whose `Cache-Control` matches `/(?:^|,)\s*?no-transform\s*?(?:,|$)/`, which the route's
`no-cache, no-transform` does.

### Verdict — **A: SSE is viable on this infrastructure. Option C stands.**

The heartbeat is 25s against a 5-minute requirement — two orders of margin. The only real ceiling
is the 15-minute maximum, and section 11 handles it deliberately rather than letting the stream run
into it.

### What is still unverified

**`/api/giniflow/events` has not been exercised end-to-end against production, because the route is
not deployed.** `authMiddleware` runs before routing, so every `/api/*` path returns 401 and the
route's presence cannot even be detected from outside. Everything above establishes that the
infrastructure _supports_ SSE; it does not prove that this endpoint behaves on it.

**Final verification still requires deploying the route and watching a real client through at least
one ~14-minute recycle**, confirming the stream survives, the `bye` handover is silent to the user,
and no event is lost across it. Until that has been done, "live in production" is supported by
infrastructure evidence, not by observation.

---

## 11. Three production fixes — 2026-09-01

Applied after section 10, and only these three. The architecture is unchanged: SSE, the event
tailer, `Last-Event-ID` replay, the thin signal payload and the polling fallback all stand.

### 11.1 No give-up — reconnect with backoff

`GIVE_UP_AFTER = 3` closed the `EventSource` permanently, and nothing reopened it. A Railway
redeploy takes the container down for tens of seconds, EventSource retries every ~3s, three errors
were spent in under ten — and every station tablet then sat on 15s polling for the rest of the day
unless somebody reloaded the page.

The policy now lives in `src/queries/hooks/giniflowLiveConnection.js`, free of React and of any
browser import so the smoke suite can drive it: exponential backoff from 1s to a 30s ceiling with
±25% jitter (so a fleet of tablets does not reconnect in lockstep after a deploy), failures reset on
the next `hello`, and a `visibilitychange` listener reconnects immediately when a tablet wakes
rather than serving out the rest of its backoff.

**One connection, always.** `open()` refuses to build a second, a reconnect is never scheduled while
one is pending, and `onerror` closes the source before scheduling — otherwise the browser's own
retry loop would race ours and open two.

### 11.2 The 15-minute ceiling, handled deliberately

`eventHub.js` recycles each stream at `GINIFLOW_SSE_RECYCLE_MS` (default **14 minutes**), a minute
inside Railway's hard limit, and announces it first:

```
event: bye
data: {"reason":"recycle","reconnect":true}
```

The client treats `bye` as a handover, not an outage: it does not report the screen offline (no
`Live → Polling · 15s` flicker), does not count a failure, keeps the watermark the frame carries,
and reconnects after 250ms. The unexpected-disconnect path is untouched, so a stream that dies
without warning still falls back and retries normally.

### 11.3 Authentication lifetime

The stream authenticated once, at connect, and nothing re-checked it. The 14-minute recycle now
bounds that: no stream carries an authentication checked longer ago than the recycle interval. The
reconnect URL is rebuilt on every attempt from `localStorage`, so it presents the token the app
holds **now**, not the one it held when the screen was opened. The payload is unchanged — still
`{kind, visitId, status, orderId, date}`, no PHI — and every render still refetches through the
authenticated API.
