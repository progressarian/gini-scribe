import test from "node:test";
import assert from "node:assert/strict";
import { patientTypeOf, isFull } from "../../shared/slotCapacity.js";
import { validateTemplate } from "../../shared/slotTemplates.js";

test("walk-in first, then New by visit type, everyone else is a follow-up", () => {
  assert.equal(patientTypeOf({ is_walkin: true, visit_type: "New Patient" }), "walkin");
  assert.equal(patientTypeOf({ visit_type: "New Patient" }), "new");
  assert.equal(patientTypeOf({ visit_type: null }), "new");
  assert.equal(patientTypeOf({ visit_type: "Follow Up" }), "followup");
  assert.equal(patientTypeOf({ visit_type: "OPD" }), "followup");
});

test("a type is full only when it has a limit and the count has reached it", () => {
  const caps = { new: 3, followup: 0, walkin: null };
  assert.equal(isFull(caps, { new: 2 }, "new"), false);
  assert.equal(isFull(caps, { new: 3 }, "new"), true);
  assert.equal(isFull(caps, { followup: 0 }, "followup"), true);
  assert.equal(isFull(caps, { walkin: 40 }, "walkin"), false);
});

test("limits must be whole numbers from 0 to 99, or blank", () => {
  const hours = (cap) => ({
    hours: [{ weekday: 1, start: "09:00", end: "13:00", slotMinutes: 30, ...cap }],
  });
  assert.deepEqual(validateTemplate(hours({ capNew: 3, capFollowup: 0, capWalkin: null })), []);
  assert.deepEqual(validateTemplate(hours({ capWalkin: 120 })), [
    {
      field: "hours.0.capWalkin",
      message: "Mon: walk-ins per slot must be a whole number from 0 to 99, or blank for no limit.",
    },
  ]);
  assert.equal(validateTemplate(hours({ capNew: 2.5 })).length, 1);
});
