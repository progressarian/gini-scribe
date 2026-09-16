#!/usr/bin/env node
// The offline visit queue, against a mocked transport.
//
// This is where the airplane-mode behaviour is actually pinned down. The real
// device test (docs/CRM_OFFLINE_TEST.md) confirms the browser behaves as
// assumed; this confirms the queue logic is right, including the cases that are
// tedious to stage on a phone: a send that fails then succeeds, a send that
// succeeds twice, a corrupt queue, a full disk.
//
//   node scripts/smoke-crm-offline-queue.mjs

// Minimal localStorage and browser globals — the queue is plain JS with no
// framework, so it runs under node once these exist.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.navigator = { onLine: true };

const q = await import("../../src/crm/offlineQueue.js");

let pass = 0;
let fail = 0;
const ok = (m) => (pass++, console.log(`  \x1b[32mPASS\x1b[0m  ${m}`));
const bad = (m, got) => (fail++, console.log(`  \x1b[31mFAIL\x1b[0m  ${m}\n        got: ${got}`));
const eq = (a, b, m) => (String(a) === String(b) ? ok(`${m} (= ${b})`) : bad(m, a));

const visit = (id, extra = {}) => ({
  id,
  doctor_id: "aaaaaaaa-0000-0000-0000-000000000001",
  visit_type: "in_person",
  occurred_at: "2026-09-16T10:15:00.000Z",
  client_created_at: "2026-09-16T10:15:00.000Z",
  ...extra,
});

const reset = () => store.clear();

console.log("\nSaving while offline");
reset();
globalThis.navigator.onLine = false;
q.enqueue(visit("v1"));
q.enqueue(visit("v2"));
eq(q.pendingCount(), 2, "two visits queued with no network");
const offlineDrain = await q.drain(
  async () => {
    throw new Error("should not be called offline");
  },
  { online: false },
);
eq(offlineDrain.sent, 0, "draining while offline sends nothing");
eq(q.pendingCount(), 2, "…and keeps both visits");

console.log("\nRegaining signal");
globalThis.navigator.onLine = true;
const seen = [];
const good = async (v) => {
  seen.push(v.id);
  return { id: v.id, duplicate: false };
};
const r1 = await q.drain(good, { online: true });
eq(r1.sent, 2, "both visits send once signal returns");
eq(q.pendingCount(), 0, "…and the queue empties");
eq(seen.join(","), "v1,v2", "…in the order they were logged");

console.log("\nThe replay case — the whole reason ids are client-minted");
reset();
q.enqueue(visit("v3"));
let calls = 0;
const flaky = async (v) => {
  calls++;
  // First attempt: the request reached the server and the row was written, but
  // the response was lost. The queue cannot know, so it retries.
  if (calls === 1) throw new Error("network dropped after write");
  return { id: v.id, duplicate: true };
};
const first = await q.drain(flaky, { online: true });
eq(first.failed, 1, "a lost response counts as a failure");
eq(q.pendingCount(), 1, "…and the visit stays queued");
// Backoff would normally hold it; clear it to test the retry itself.
const held = q.queued();
held[0].next_attempt_at = 0;
localStorage.setItem("crm.visitQueue.v1", JSON.stringify(held));
const second = await q.drain(flaky, { online: true });
eq(second.sent, 1, "the retry succeeds");
eq(q.pendingCount(), 0, "…and the queue empties");
eq(calls, 2, "the server saw the same visit id twice — its ON CONFLICT makes that a no-op");

console.log("\nBackoff");
reset();
q.enqueue(visit("v4"));
const always = async () => {
  throw new Error("still offline");
};
await q.drain(always, { online: true });
const afterOne = q.queued()[0];
eq(afterOne.attempts, 1, "one failed attempt recorded");
ok(`…next attempt deferred by ${Math.round((afterOne.next_attempt_at - Date.now()) / 1000)}s`);
const deferred = await q.drain(always, { online: true });
eq(deferred.skipped, 1, "a second immediate drain respects the backoff");
eq(q.pendingCount(), 1, "…and the visit is still queued, not lost");

console.log("\nEditing before it ever sends");
reset();
q.enqueue(visit("v5", { discussion_notes: "first draft" }));
q.enqueue(visit("v5", { discussion_notes: "corrected" }));
eq(q.pendingCount(), 1, "re-queuing the same id replaces rather than duplicates");
eq(q.queued()[0].visit.discussion_notes, "corrected", "…keeping the correction");

console.log("\nTimestamps survive the round trip");
reset();
q.enqueue(visit("v6"));
let captured = null;
await q.drain(
  async (v) => {
    captured = v;
  },
  { online: true },
);
eq(captured.occurred_at, "2026-09-16T10:15:00.000Z", "occurred_at is the moment of the visit");
eq(
  captured.client_created_at,
  "2026-09-16T10:15:00.000Z",
  "client_created_at travels, so a late sync is visible as a late sync",
);

console.log("\nDegrading safely");
reset();
localStorage.setItem("crm.visitQueue.v1", "{not json");
eq(q.queued().length, 0, "a corrupt queue reads as empty rather than throwing");
q.enqueue(visit("v7"));
eq(q.pendingCount(), 1, "…and the next visit still queues");

reset();
const realSet = localStorage.setItem;
localStorage.setItem = () => {
  throw new Error("QuotaExceededError");
};
const stored = q.enqueue(visit("v8"));
eq(stored, false, "a full disk reports failure rather than pretending to save");
localStorage.setItem = realSet;

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
