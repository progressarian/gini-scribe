# Supabase Realtime (plan 21) — verification

**Date:** 2 Sep 2026
**Verifying:** the `Status: Phase 1 built` claims in `21-SUPABASE-REALTIME-PLAN.md`, clause by clause,
against the code.

**Method:** static verification only. Nothing was executed — the smoke suite needs the database and
the Supabase keys, so the two items marked _unrun_ below are the ones a person still has to confirm.

**Result:** every claim in the status line is true. Three deviations from the plan's own body, two of
which are the code being right and the plan being wrong. One operational observation the plan does
not make.

> **Resolved 2 Sep 2026.** All four findings are closed — see §5. The two _unrun_ items were in fact
> run before this review was written; the migration is applied and `smoke:giniflow-realtime` passes.

---

## 1. Claim-by-claim

| Claim (status line)                        | Verdict      | Evidence                                                                                                                           |
| ------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| RLS policy applied                         | ⚠️ **Unrun** | `server/migrations/2026-09-02_giniflow_realtime_rls.sql` exists and is correct. Whether it is _applied_ needs the smoke run        |
| `realtimeBus.js`                           | ✅           | `server/services/giniflow/realtimeBus.js` — Broadcast, service key, one channel per topic, unconfigured is a no-op                 |
| token endpoint                             | ✅           | `GET /api/giniflow/realtime-token`, `giniflow.js:86`, gated `CAP.GINIFLOW_VIEW`                                                    |
| notify endpoint                            | ✅           | `POST /api/giniflow/notify`, gated `CAP.GINIFLOW_MANAGE_QUEUE`, Zod-validated                                                      |
| the browser connection                     | ✅           | `src/lib/giniflowRealtime.js`, wired in `useGiniflowLive.js:141`                                                                   |
| station notice banner on six stations      | ✅           | Vitals, Reception, Lab, MO/SD, Doctor, Pharmacy — all six pages                                                                    |
| `smoke:giniflow-realtime`                  | ✅           | `server/package.json:39`, 16 checks                                                                                                |
| server half live and publishing            | ✅           | `eventTailer.js:103` calls `publishEvents(envelopes)`; `enabled()` needs only `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`, both set    |
| browser half dormant until the two secrets | ✅           | Neither `SUPABASE_JWT_SECRET` nor `SUPABASE_ANON_KEY` is in `.env`; the endpoint returns `{ enabled: false }` and the client stops |
| SSE carries every event meanwhile          | ✅           | `eventHub.publish(ev)` still runs for every envelope, on the same line, before the Realtime publish                                |
| "Turn it on: add those two secrets"        | ✅           | Accurate — the token endpoint reads exactly those two plus `SUPABASE_URL`, and nothing else gates the client                       |

**Design claims that also hold:**

- **Broadcast, not Postgres Changes** — no RLS was written over any patient table; the only policy is
  on `realtime.messages`.
- **No patient data in the envelope** — the smoke asserts it (`no envelope carries a patient field`),
  and the payload is the same four fields SSE already sends.
- **Write is never granted to the browser** — the policy is `FOR SELECT` only.
- **Supabase Auth is not adopted** — the token is minted by our own API against `SUPABASE_JWT_SECRET`,
  with `role: "authenticated"`, and expires in 3600s with no refresh.
- **Both transports de-duplicate** — both call `queue(INVALIDATES[kind] || ALL)`, which adds a string
  key to a `Set` behind a `COALESCE_MS` debounce, so a doubly-delivered envelope collapses to one
  invalidation.

---

## 2. Deviations

### RT-01 — §4.3's RLS snippet is wrong, and the shipped policy is right

The plan's SQL is one branch:

```sql
USING (realtime.topic() LIKE 'giniflow:%'
       AND (auth.jwt() -> 'giniflow_days') ? split_part(realtime.topic(), ':', 3))
```

For `giniflow:station:vitals`, `split_part(…, ':', 3)` is `vitals` — which is never in
`giniflow_days`. **That policy would have denied every station topic**, i.e. the notice feature the
whole plan exists to deliver (§3).

The shipped migration splits it into a day branch (day named in the token) and a station branch
(`giniflow_rt = 'v1'`, any Gini Flow token), and the smoke tests both paths against the live
predicate rather than just asserting the policy exists.

**Action:** correct §4.3, or a future reader will "restore" the documented version.

### RT-02 — the token names three days, not one

§4.3 shows `giniflow_days: ["2026-09-02"]`. The endpoint issues yesterday, today and tomorrow, with
the reason in the code (a screen may show either side of midnight, and naming the days still stops
replay against an arbitrary date). Sound; §4.3's example should say so.

### RT-03 — §4.4 and §4.4.1 contradict each other, and §4.4.1 comes first

§4.4.1 ("Where the publish actually went — a departure from §4.4(a)") sits at line 169; §4.4
("Two options; **take the first**") sits at line 189. So the document tells you to take option (a)
_after_ explaining that option (a) was not taken and why.

The decision itself is well made and matches the code exactly — publishing from `eventTailer.js`
means only committed rows are announced, one call site instead of ten, and the worker's HealthRay
sync is heard, which write-site publishing in the API would have missed. **Verified:** the tailer
still polls at `TICK_MS = 1000` (`eventTailer.js:21`), so §4.4.1's honest admission that Phase 1 does
not remove the 1-second poll is accurate.

**Action:** renumber so the outcome follows the options, and mark §4.4(a) as superseded rather than
recommended.

---

## 3. Observation the plan does not make

### RT-04 — Phase 1 publishes to an empty room, and pays for it

`realtimeBus.enabled()` is `SUPABASE_URL && SUPABASE_SERVICE_KEY` — both already set. The token
endpoint needs `SUPABASE_JWT_SECRET` and `SUPABASE_ANON_KEY` — neither set. So **today the server
broadcasts every envelope to topics that no browser is authorised to join.**

That is the correct shape for an additive Phase 1 and it is exactly what the status line describes.
Worth stating plainly anyway, because §6.1's cost arithmetic assumes messages have listeners: until
the two secrets are added, every message is billed with a subscriber count of zero, and any Realtime
delivery problem is invisible because nothing is listening to notice it.

Two cheap options, either fine: gate `publishEvents` on the same two secrets so Phase 1 is truly
dormant until it is turned on, or add the secrets now so the comparison the plan wants in Phase 2 can
actually begin.

---

## 4. Still to run

Neither needs code changes — both need the database:

```
cd server
node migrations/_runOne.mjs migrations/2026-09-02_giniflow_realtime_rls.sql   # if not already applied
npm run smoke:giniflow-realtime
```

The suite's first assertion is `realtimeBus is configured`, and three of its checks evaluate the RLS
predicate itself (a token naming today may read today, may not read a day three ahead, and a token
naming no days reads nothing) — so a green run is what actually confirms the "RLS policy applied"
clause in the status line.

---

## 5. Resolution — 2 Sep 2026

| #         | Action taken                                                                                                                                                                                                                                                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RT-01** | §4.3's single-branch SQL replaced with the shipped two-branch policy, and the note that a one-branch version would have denied every station topic kept in place so nobody "restores" it. The smoke already evaluated the day predicate against Postgres; that is now stated in §4.3 too                                                                  |
| **RT-02** | §4.3 corrected: the token names **yesterday, today and tomorrow**, with the reason (a screen either side of midnight, triage opening on either day) rather than the single date the draft showed                                                                                                                                                          |
| **RT-03** | §4.4.1 moved to sit **after** §4.4, retitled "What actually shipped — superseding §4.4(a)", and option (a) marked _superseded_ where it is recommended. The document now reads options → outcome                                                                                                                                                          |
| **RT-04** | **Fixed in code, not documented away.** `realtimeBus` gained `browserEnabled()`, and `publishEvents()` is now dormant while `SUPABASE_JWT_SECRET`/`SUPABASE_ANON_KEY` are unset — so the two halves switch on together and nothing is billed to an empty room. The suggestion to "add the secrets now" was not taken because only a human can supply them |

### RT-04 went further than the finding

The review spotted that publishing to an unjoinable topic wastes messages. Following it through
surfaced a second, worse consequence: **`POST /giniflow/notify` was reporting success it could not
know.** `publishNotice` returned `{ published: true }` whenever the service key was set, so the
board's toast read "✓ Sent to vitals" while no station screen could subscribe.

That is the failure mode the notice feature exists to prevent — a coordinator who believes a desk
has been told **stops walking over to tell them**. `publishNotice` now returns `reachable`, the
endpoint passes it through, and the board says:

> Sent, but no vitals screen can receive it yet — tell them directly

### The two "unrun" items

Both were run on 2 Sep before this review was authored, which the static method could not see:

- `node migrations/_runOne.mjs migrations/2026-09-02_giniflow_realtime_rls.sql` → `OK: applied`,
  and `pg_policy` confirms `giniflow_broadcast_read` on `realtime.messages`
- `npm run smoke:giniflow-realtime` → all checks pass, `SUPABASE_JWT_SECRET` reported as a note
  rather than a failure (an unmet condition only a human can meet is not a broken build)

`realtimeBus.publish()` was also exercised directly against live Supabase and returned
`{"published":true}` on both topic shapes.

---

## 6. RT-05 — publish succeeded and nothing was delivered (found 2 Sep, after the secrets went in)

The moment `SUPABASE_JWT_SECRET` and `SUPABASE_ANON_KEY` were added, an end-to-end test with a real
subscriber showed the transport had never worked:

```
subscribe giniflow:day:2026-09-02   -> SUBSCRIBED
subscribe giniflow:station:vitals   -> SUBSCRIBED
publish                             -> {"published": true}
received                            -> 0
```

**Cause.** `realtimeBus.channelFor()` opened the channel as
`{ config: { broadcast: { self: false } } }` — a **public** channel. The browser joins with
`{ config: { private: true } }`, which is the channel Realtime Authorization guards with the RLS
policy. Same name, different room. Every send returned `{ published: true }` and went nowhere.

**Fix.** `private: true` on the publisher too. Delivery confirmed immediately after.

**Why every earlier check passed.** All of them — the smoke's six publish assertions, the manual
`publish()` run, the notify endpoint's `delivered` count — asked "did the send succeed?". None had a
subscriber. `{ published: true }` was true and meaningless.

**The lesson, now enforced.** `smoke:giniflow-realtime` gained a real subscriber: it mints a token
exactly as the endpoint does, joins the private channel, publishes, and asserts the envelope
**arrives**. It also asserts a token that does not name a day is refused _and_ receives nothing.

One ordering trap found while writing it: a refused private-channel join errors the socket, so
testing the refusal **before** the delivery made a working delivery look broken. The delivery
assertion now runs first, with a comment saying why.

### What this says about RT-04

RT-04's fix — keeping `publishEvents()` dormant until the browser half is configured — turned out to
matter more than the message-quota argument that motivated it. Without a subscriber there was
nothing to notice this bug, and the fan-out would have run for weeks reporting success into an empty
room. "Nobody is listening" and "the transport is broken" are indistinguishable until somebody
listens.
