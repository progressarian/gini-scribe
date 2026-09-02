# Supabase Realtime — replacing the tailer, and making "Notify stations" mean something

**Date:** 2 Sep 2026
**Status:** **Phase 1 built** — RLS policy applied, `realtimeBus.js`, token + notify endpoints, the
browser connection, a station notice banner on six stations, and `smoke:giniflow-realtime`. The server
half is live and publishing; the **browser half stays dormant until `SUPABASE_JWT_SECRET` and
`SUPABASE_ANON_KEY` are set** (§4.1), with SSE carrying every event meanwhile. Supersedes
`00-OVERVIEW.md §2.2` and the delivery half of `12-REALTIME-PLAN.md`
**Turn it on:** add those two secrets from the Supabase dashboard → Project Settings → API. Nothing else.

Live updates already work. This is not a plan to fix something broken; it is a plan to stop
paying for it with a 1-second database poll, and to gain the one thing the current design
cannot do at all: **let the server say something to a station that no table change implies.**

---

## 1. What exists today

```
categorise() / advanceStatus() / uploadReport()
        ↓  INSERT
giniflow_visit_events · giniflow_lab_order_events · giniflow_vitals · giniflow_triage_events
        ↓  SELECT … WHERE seq > watermark      every 1000 ms   (eventTailer.js, API process)
eventHub.publish()
        ↓  text/event-stream
GET /api/giniflow/events                        gated on GINIFLOW_VIEW
        ↓  EventSource
useGiniflowLive → queryClient.invalidateQueries(...)
        ↓
React Query refetches → screen updates
```

Plus a fallback poll — `pollInterval`, 60 s connected / 15 s not — for the case the comment in
`giniflowPolling.js` names: a connection that is open but silently delivering nothing, which
happens behind corporate proxies.

| Piece  | Where                              | Detail                                                            |
| ------ | ---------------------------------- | ----------------------------------------------------------------- |
| Tailer | `services/giniflow/eventTailer.js` | 4 streams, `seq BIGSERIAL` watermarks, `GINIFLOW_TAIL_MS` = 1000  |
| Hub    | `services/giniflow/eventHub.js`    | 500-event replay buffer, 25 s heartbeat, 14-minute stream recycle |
| Route  | `routes/giniflow.js:38`            | SSE, `CAP.GINIFLOW_VIEW`                                          |
| Client | `queries/hooks/useGiniflowLive.js` | `EventSource`, 250 ms coalesce, `INVALIDATES` map per kind        |

**It runs in the API process, not the worker** (`index.js:203-207`) — deliberately, because it feeds
the connections that process is holding, and reading the append-only tables is how it hears about
the worker's HealthRay sync without the two processes talking.

**It works.** End to end a change reaches another screen in about a second.

---

## 2. Why change it, honestly

**Latency is not the reason.** Today ≈ 1 s; Supabase Realtime ≈ 200 ms. Nobody on the floor can
tell those apart, and any plan that leads with this is selling something.

The four real reasons:

|                                           |                                                                                                                                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The poll never stops**                  | 4 queries/second against `giniflow_*_events`, forever — roughly **345,000 queries a day** on a pooled Supabase connection, whether or not anyone has the board open          |
| **The 14-minute recycle**                 | `eventHub` tears down and rebuilds every stream every 14 minutes to stay under Railway's 15-minute cap. It works, and it is a workaround with a replay buffer attached to it |
| **Every new event table costs a stream**  | Referrals shipped without one (`19` §10) partly because adding a fifth poll for a screen nobody watches all day was not worth it                                             |
| **The server cannot originate a message** | The tailer can only echo table inserts. Anything the server wants to _say_ has nowhere to go — which is why one button on the board still does nothing (§3)                  |

The last is the only one that is a capability gap rather than a cost. It is the reason to do this.

### 2.1 What does NOT change

The transaction pooler problem (`00-OVERVIEW.md §2.1`) is untouched and irrelevant here.
Realtime reads the **WAL through logical replication**, not a session on port 6543, so unlike
`LISTEN`/`NOTIFY` it is unaffected by pooling mode. This is the one place Supabase's own
infrastructure sidesteps a constraint this repo has already been burned by.

---

## 3. The button that motivated this

`FlowManagerPage.jsx:1108-1114` — the bottleneck banner's **"Notify stations"**:

```js
onClick={() => showToast("Station screens are not built yet — tell the station directly")}
```

That sentence is **stale**: Reception, Vitals, MO/SD, Doctor, Lab, Pharmacy and Referrals are all
built and reachable. But rewording the toast would be lipstick, because the mechanism behind it
does not exist. "The vitals queue is 40 minutes over budget, look at it now" is not a row in any
table — it is the coordinator speaking, and the tailer has no way to carry a sentence nobody
inserted.

**This is the feature that justifies the migration.** Everything else in §2 is a cost saving.

---

## 4. Design

### 4.1 The three blockers from `00-OVERVIEW.md §2.2`, and what actually clears them

| Blocker (Aug 2026)                                                                                             | Still true?                                                                                                              | How it clears                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No anon key, no `VITE_` vars for Scribe's project                                                              | **Yes** — only `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are set; `VITE_GENIE_SUPABASE_*` point at the **Genie** project | Add `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. Config only                                                     |
| Browser Realtime respects **RLS**, and Scribe's tables have no policies for anon access over live patient data | **Yes, and it stays true**                                                                                               | **Do not use Postgres Changes.** Use **Broadcast**, where authorisation is RLS on `realtime.messages` per _topic_ — a table nobody's patient data is in (§4.2) |
| Scribe's auth is its own JWT (`auth_sessions`, doctor/patient `kind`), not Supabase Auth                       | **Yes**                                                                                                                  | Realtime accepts **any JWT signed with the project's JWT secret**. The server mints a short-lived, Realtime-only token (§4.3). Supabase Auth is never adopted  |

The second row is the whole design. It is worth being explicit about why:

**Postgres Changes would be the wrong choice.** It streams row payloads and filters them with RLS
on `giniflow_visits`, `giniflow_visit_events` and the rest. That means writing and auditing RLS
policies over live patient rows so a browser can read them directly — a DPDP/GDPR change, exactly
what `§2.2` refused, and it would also start shipping patient data to the browser that the current
thin envelope deliberately withholds.

**Broadcast keeps the current shape.** The server authors the message, the payload stays the same
four fields it is today, and the only thing RLS has to protect is "who may listen to topic
`giniflow:day:2026-09-02`".

### 4.2 Topics and payloads

One topic per day, which is what the SSE stream already filters on:

```
giniflow:day:2026-09-02      every screen showing that date
giniflow:station:vitals      station-addressed messages (§3)
```

Payload is **unchanged from today's SSE envelope** — `useGiniflowLive`'s `INVALIDATES` map keys off
`kind` and nothing else, so the client contract does not move:

```json
{ "kind": "visit",  "visitId": "…", "status": "with_vitals", "date": "2026-09-02" }
{ "kind": "triage", "visitId": "…", "status": "categorised",  "date": "2026-09-02" }
{ "kind": "notice", "station": "vitals", "text": "40 min over budget — 12 waiting", "from": "Gurjot" }
```

`notice` is the new kind, and the only one with no table behind it.

**No patient data, deliberately.** `eventHub`'s comment already establishes this and it must
survive the migration: a topic leak then reveals that _something_ changed, not _what_ or _whose_.

### 4.3 Auth without adopting Supabase Auth

The server already signs its own JWTs with `JWT_SECRET`. It gains a second, narrower signer:

```
GET /api/giniflow/realtime-token     gated on CAP.GINIFLOW_VIEW
  → { token, expiresIn: 3600 }
```

- Signed with **`SUPABASE_JWT_SECRET`**, not `JWT_SECRET` — a different key for a different audience
- Claims: `role: "authenticated"`, `sub: <doctor id>`, `exp: now + 1h`, `giniflow_rt: "v1"`, and
  `giniflow_days` — **yesterday, today and tomorrow**, not the single day an earlier draft showed
  (RT-02). A screen may sit either side of midnight and triage opens on either day, so one date
  would break a board nobody had reloaded. Naming three still stops a token being replayed against
  an arbitrary date, which is the property that matters
- **One hour, and no refresh token.** The browser re-asks the API, which re-checks the capability
  against `auth_sessions` — so revoking a doctor's session kills their Realtime access within the
  hour, which a long-lived token would not

RLS on `realtime.messages`, the only policy this plan writes. **Two branches, not one** — an
earlier draft of this section had a single branch and it was wrong (RT-01): for
`giniflow:station:vitals`, `split_part(topic, ':', 3)` is `vitals`, which is never in
`giniflow_days`, so it would have denied every station topic and with it the notice feature this
plan exists to deliver. The shipped policy is
`2026-09-02_giniflow_realtime_rls.sql`:

```sql
CREATE POLICY giniflow_broadcast_read ON realtime.messages
  FOR SELECT TO authenticated
  USING (
    extension = 'broadcast'
    AND (
      -- a day topic: the token must name that day
      (realtime.topic() LIKE 'giniflow:day:%'
       AND COALESCE(auth.jwt() -> 'giniflow_days', '[]'::jsonb)
             ? split_part(realtime.topic(), ':', 3))
      -- a station topic: any token this server minted
      OR (realtime.topic() LIKE 'giniflow:station:%'
          AND COALESCE(auth.jwt() ->> 'giniflow_rt', '') = 'v1')
    )
  );
```

`smoke:giniflow-realtime` evaluates the day predicate against Postgres itself rather than merely
asserting the policy exists — a token naming today may read today, may not read a day three ahead,
and a token naming no days reads nothing.

Write is never granted to the browser. Every message is authored by the server with the service
key, which is what keeps "the server can say something" from becoming "anyone can say anything".

### 4.4 Emitting

Two options were considered. **(a) was the recommendation and (b) was rejected; what shipped is
neither — see §4.4.1 below, which supersedes this section.**

**(a) From Node, after the commit — _superseded, see §4.4.1_.** A `publish(topic, payload)` in a new
`services/giniflow/realtimeBus.js`, called from the same places `advanceStatus` and the triage
writes already sit — after `COMMIT`, fire-and-forget, exactly as
`logTriageEvent` and `savePrescriptionForVisit` already are. Keeps every existing invariant
("nothing slow inside the transaction") and needs no database triggers.

**(b) From Postgres, via `realtime.broadcast_changes()` in a trigger.** Fires even for writes made
outside the app — a manual `UPDATE`, a migration backfill. Tempting, but it puts delivery logic in
triggers where nobody looks for it, and this module's own rule is that status is written in one
place. Note it only for completeness.

---

### 4.4.1 What actually shipped — superseding §4.4(a)

§4.4(a) said publish from the write sites, after each `COMMIT`. **Phase 1 publishes from the tailer
instead**, at the one place that already hands envelopes to `eventHub`. Three reasons, found while
building it:

- **`advanceStatus` takes a transaction client, not a pool.** Publishing inside it would announce a
  status the transaction might still roll back. Doing it correctly at each of ten call sites is ten
  chances to publish uncommitted data.
- **It would miss the worker.** The HealthRay sync writes events from the _other process_.
  Write-site publishing in the API would never see them — and hearing the worker without the two
  processes talking is the stated reason the tailer reads tables at all (`index.js:203-207`).
- **The Phase 2 comparison becomes exact.** Both transports carry byte-identical envelopes from one
  source, so "did every SSE event arrive on Realtime?" is a diff rather than a judgement.

**The cost is honest: Phase 1 does not remove the 1-second poll**, so §2's first bullet is not yet
banked. Phase 3 still needs the write-site work — and now visibly needs it in the worker too, which
§5 did not account for. The capability in §3 is delivered regardless, because a notice never came
from a table in the first place.

## 5. Migration — three phases, always reversible

The rule throughout: **the SSE path stays live until the Realtime path has been proven on the
floor.** Two transports feeding one `INVALIDATES` map is a duplicate refetch at worst; a single
untested transport is a dead board.

| Phase                                   | Does                                                                                                                                                                                                                                                                                                                                                                                         | Reversible by          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **1. Add, do not replace** ✅ **built** | RLS policy, token endpoint, `realtimeBus`, publish from the tailer (§4.4.1), browser connection, notice banner. `useGiniflowLive` subscribes to **both** — and de-duplication turned out to be **free**: `pending` is already a `Set` of query keys, so the same event on two transports adds the same string twice and invalidates once. The 4–6 h estimate in §6.2 was wrong; it took none | Deleting one hook call |
| **2. Prove, then unplug the tailer**    | A week of both. Compare: did every SSE event arrive on Realtime? Then `GINIFLOW_TAIL_MS=0` to stop the poll, keeping the SSE endpoint alive and served by `realtimeBus`                                                                                                                                                                                                                      | One env var            |
| **3. Retire SSE**                       | Delete `eventTailer.js`, the `seq` columns' tailing role (keep the columns — they are a cheap audit ordering), the 14-minute recycle, the replay buffer                                                                                                                                                                                                                                      | A revert               |

**The fallback poll stays at every phase.** It is not scaffolding for the tailer; it is the repair
for a transport that is connected and silent, and Realtime can be connected and silent too.

### 5.1 What "proven" means

Phase 2 does not end on a feeling. A `smoke:giniflow-realtime` that asserts:

- every one of the four kinds arrives on both transports for the same write
- a token expires at an hour and the client re-fetches without dropping a message
- a doctor whose `auth_sessions` row is revoked stops receiving within the hour
- a browser holding a token for 2026-09-02 receives **nothing** on `giniflow:day:2026-09-03`
- the payload contains no patient name, file number, or clinical value

The fourth and fifth are the ones that matter. They are the RLS policy and the privacy rule, and
they are the two things a hand-test will not catch.

---

## 6. Cost and risk

| Risk                                  | Reading                                                                                                                                                                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Realtime connection quota**         | **Pro plan — confirmed 2 Sep 2026.** 63 active staff accounts exist, but the floor runs perhaps 10–20 screens at once; at two tabs each that is ~40 concurrent connections against Pro's several-hundred allowance. Comfortable — §6.1 does the arithmetic |
| **Message quota**                     | Measured rather than estimated — see §6.1. Worst case ~340k/month against a multi-million allowance                                                                                                                                                        |
| **A second live path during phase 1** | Duplicate invalidations, which React Query already coalesces. Harmless and temporary                                                                                                                                                                       |
| **RLS mistake**                       | Confined to `realtime.messages`, and the payload carries no patient data. A policy bug leaks _that something changed_, not what                                                                                                                            |
| **`SUPABASE_JWT_SECRET` in env**      | A new secret with real power — it can mint tokens for the project. Server-side only, never `VITE_`                                                                                                                                                         |
| **Supabase Realtime outage**          | The fallback poll is the answer, which is why §5 keeps it                                                                                                                                                                                                  |

---

### 6.1 The arithmetic, on real numbers

The project is on the **Supabase Pro plan** (confirmed 2 Sep 2026), which closes what was open
question 2. Measured from the four event tables:

|                                    |                                                                  |
| ---------------------------------- | ---------------------------------------------------------------- |
| Events written, busiest day so far | **284**                                                          |
| Events written, daily mean         | **220**                                                          |
| Days of data                       | 3 — the tables are new, so treat these as a floor, not a ceiling |
| Active staff accounts              | 63, mostly consultants who never open a station screen           |
| Realistic concurrent screens       | 10–20, at ~2 tabs each ≈ **40 connections**                      |

Messages, taking the pessimistic reading that the quota counts **per recipient** rather than per
publish:

```
284 events  ×  40 screens  ×  30 days   ≈  341,000 messages / month
```

Against Pro's multi-million monthly allowance that is a **single-digit percentage**, and the
connection count is under a tenth of the ceiling. Neither is close.

Two honesties about those numbers:

- **Three days is not a sample.** These tables were created for this module and the floor is not
  yet fully on it — today's 97-patient day produced 210 events, where 97 patients moving through
  every station would produce two to three times that. Assume a ceiling of ~1,000 events/day and
  the arithmetic still lands near 1.2 M/month, comfortably inside Pro.
- **Verify the per-recipient reading** on the dashboard before Phase 1. If the quota counts
  publishes rather than deliveries, divide everything above by 40 and it becomes rounding error.
  The plan is safe either way, which is why this is a note and not a blocker.

**Quota is not a constraint on this decision** and should not appear in the argument for or
against it. §8 stands unchanged: the case rests on §3.

### 6.2 What it costs to build

**No new dependencies.** `@supabase/supabase-js` and `jsonwebtoken` are already in both
`package.json` files — the client one only ever pointed at the Genie project, and the server one
is used by the storage paths. Nothing new is installed.

| Work                                                                                                                  | Estimate                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Env vars + config                                                                                                     | under an hour                                                                                            |
| `GET /api/giniflow/realtime-token` — mint, gate on `GINIFLOW_VIEW`, 1 h expiry                                        | ~2 h                                                                                                     |
| RLS policy migration on `realtime.messages`                                                                           | ~2 h — small, but it is the security boundary, so it is written slowly                                   |
| `realtimeBus.js` + a publish beside the ~6 existing insert sites                                                      | ~3 h                                                                                                     |
| `useGiniflowLive` subscribes to both transports and de-duplicates                                                     | **4–6 h — the fiddliest part**, because "the same event twice" has to be recognised across two envelopes |
| `smoke:giniflow-realtime`, the five assertions in §5.1                                                                | ~4 h                                                                                                     |
| **Phase 1 total**                                                                                                     | **2–3 focused days**                                                                                     |
| Phase 2 — run both, compare, flip `GINIFLOW_TAIL_MS=0`                                                                | no build work; ~1 week of elapsed observation                                                            |
| Phase 3 — delete the tailer, the recycle, the replay buffer                                                           | half a day                                                                                               |
| **The `notice` feature itself** — publish endpoint, a shared banner component, wiring it into the seven station pages | **1–2 days**, and this is the part that is actually new                                                  |

**~4–6 days of work across ~2 weeks of elapsed time**, most of it in Phase 1 and the notice UI.

### 6.3 What it costs to keep

The line items nobody counts at the start:

- **One more secret to rotate.** `SUPABASE_JWT_SECRET` can mint tokens for the whole project.
- **One more vendor in the live path.** A Supabase Realtime outage becomes a liveness outage,
  where today it would take the API down with it anyway. The fallback poll is the mitigation and
  is the reason §5 refuses to remove it.
- **Token expiry is a new failure mode.** An hour is short on purpose (§4.3), which means the
  client has to re-fetch and resubscribe without dropping a message — a thing that works until
  the day a laptop sleeps through the boundary.
- **Two transports to reason about** for the fortnight Phases 1–2 last.

---

## 7. What this does not solve

Worth stating so the plan is not oversold:

- **It does not make the triage board's report status live.** Reports arrive from the HealthRay
  sync writing `lab_results` and `documents`, neither of which is a Gini Flow event table. Those
  still reach the screen by poll, and will until someone decides they are worth a topic.
- **It does not change what the screens do with an event.** Every kind still ends in
  `invalidateQueries` and a refetch. Pushing the _data_ rather than a nudge is a different plan,
  and a much larger one — it would mean the payload carrying patient data, which §4.2 refuses.
- **It does not remove the fallback poll**, and nothing should.

---

## 8. Recommendation

**Do it, for §3 and not for §2.** The cost savings are real but small; a coordinator being able to
tell the vitals station that it is the bottleneck is a floor capability the system does not have
and cannot get from a table tailer.

If "Notify stations" is not wanted, then the honest recommendation is **do not migrate**. The
current SSE path delivers in about a second, the poll load is affordable, and rewriting a working
transport to save 800 ms nobody perceives is not worth an RLS policy over a production database.

In that case, do one thing instead: **fix the stale toast**, so the button either says what it
really does or goes away.

---

## 9. Open questions

1. ~~**Is "Notify stations" actually wanted?**~~ **Answered by the decision to build it.** It is
   wired: the board's button posts to `/api/giniflow/notify`, and six station screens carry a
   `StationNotice` banner. Whether the floor uses it is now an observation, not a question.
2. ~~**Which Supabase plan is the project on?**~~ **Answered: Pro**, 2 Sep 2026. The arithmetic is
   in §6.1 and quota is not a constraint. The one thing still worth a glance at the dashboard is
   whether the message quota counts publishes or deliveries — it moves the number by 40×, and
   neither answer changes the decision.
3. **Does a notice need to persist?** Shipped as **not persisted**, and `useStationNotice.js` says
   so: a bottleneck is true for the next ten minutes, so a notice that outlived its moment would be
   worse than none. A station opened after one was sent will not see it. Revisit only if the floor
   asks for it.
4. **One topic per day, or per day + station?** Per day is simpler and every screen already filters
   by date. Per station is fewer wasted invalidations on a busy floor. Start with per day.
