# Airplane-mode test — visit logging

Run this on a real Android phone before the growth team uses the app.

The queue logic is already pinned by `server/scripts/smoke-crm-offline-queue.mjs`
(22 assertions, including a send that fails then succeeds and a send the server
accepts twice). What that **cannot** prove is that the browser behaves the way
the code assumes on a real device: that `localStorage` survives the app being
killed, that Chrome fires `online` when signal returns, and that a backgrounded
tab resumes. That is what this script is for.

Expect it to take about ten minutes.

## Before you start

You need a growth login with doctors assigned. If the account is not set up:

```sh
railway run -s gini-scribe -e production -- node server/scripts/crm-onboard-user.mjs \
  --name "Test Rep" --role growth_executive --territory Kharar --pin 1234 --commit
```

Have the verification query ready in a second window — you will run it three
times. Replace `Test Rep` if you used a different name:

```sql
SELECT v.id, d.full_name, v.occurred_at, v.client_created_at, v.synced_at,
       v.visit_type, v.outcome, v.gps_latitude IS NOT NULL AS has_gps
  FROM crm.visits v
  JOIN crm.doctors d ON d.id = v.doctor_id
  JOIN crm.users u ON u.id = v.executive_id
 WHERE u.full_name = 'Test Rep'
 ORDER BY v.synced_at DESC
 LIMIT 10;
```

## The test

**1. Sign in with signal on.** Open the app, log in as the rep. You should land
on `/crm/home` — not the clinical home. Note the doctors listed under **To
visit**. Pick one and remember the name.

**2. Go offline.** Turn on airplane mode. Confirm the phone has no signal and
no Wi-Fi — airplane mode sometimes leaves Wi-Fi on, and the point is to have
neither.

**3. Log a visit.** Tap the doctor → **Log visit**. Choose a visit type, an
outcome, and type a note you will recognise later, for example
`AIRPLANE TEST ONE`. Tap **Save visit**.

- It should return to the home screen **immediately**. If it hangs even briefly,
  stop — the save is waiting on the network and that is a bug.
- The header should show a **"1 to sync"** badge.
- Allow the location prompt when it appears. It should not delay the save.

**4. Log a second visit,** still offline, against a different doctor, noted
`AIRPLANE TEST TWO`. The badge should read **"2 to sync"**.

**5. Check the clock.** Note the wall-clock time now. The visits were logged at
this time, not at the time they eventually sync — that is what step 9 checks.

**6. Kill the app.** Not just background it: swipe it away from the Android task
switcher entirely. If you can, also force-stop Chrome from Settings → Apps.

**7. Reopen, still offline.** Open the app again. The badge must still read
**"2 to sync"**. This is the step that proves the visits were on disk and not
in memory. If the badge is gone, the visits are lost and everything after this
is moot.

**8. Regain signal.** Turn airplane mode off. Leave the app open and in the
foreground.

- Within about a minute the badge should disappear.
- If it does not, background the app and bring it back — that triggers a drain
  too, and the difference tells us which trigger is doing the work.

**9. Verify in the database.** Run the query.

- [ ] **Exactly two rows**, one per visit. Not four, not three.
- [ ] `occurred_at` matches the time you noted in step 5, **not** the time you
      turned signal back on.
- [ ] `client_created_at` matches `occurred_at`.
- [ ] `synced_at` is **later** — that gap is the offline period, and it should
      roughly equal how long you spent in airplane mode.
- [ ] `visit_type` and `outcome` are what you chose.
- [ ] `has_gps` is true if you allowed location.
- [ ] The notes read `AIRPLANE TEST ONE` and `AIRPLANE TEST TWO`.

**10. Force a replay.** This is the case that would produce duplicates if the
client-minted id were not doing its job. With signal on, log a third visit and,
the instant you tap Save, turn airplane mode on for ten seconds, then off.

- [ ] Still **exactly one** new row.
- [ ] The badge clears.

## Cleaning up

Test visits are real rows. Soft-delete them rather than leaving them in
anyone's numbers:

```sql
UPDATE crm.visits SET deleted_at = now()
 WHERE discussion_notes LIKE 'AIRPLANE TEST%';
```

Deactivate the test login:

```sql
UPDATE public.doctors SET is_active = false WHERE name = 'Test Rep';
UPDATE crm.users     SET is_active = false WHERE full_name = 'Test Rep';
```

## If something fails

| What you see | What it means |
|---|---|
| Save hangs before returning | The save path is waiting on the network. It should not. |
| Badge gone after killing the app | The queue is not reaching disk. Check `localStorage` is not blocked — private browsing and some device policies disable it. |
| Badge never clears with signal back | The drain triggers are not firing. Backgrounding and reopening distinguishes `online` from `visibilitychange`. |
| More rows than visits logged | The idempotency is broken. Capture the ids — duplicate rows with *different* ids mean the client minted twice; the same id twice would mean `ON CONFLICT` is not doing its job. |
| `occurred_at` equals `synced_at` | The client timestamp is being ignored and the server is stamping arrival time, so a day's offline work would all appear to have happened at once. |

Report what you saw either way — a pass is worth recording as much as a
failure, because it is the evidence that the field team can trust the thing.
