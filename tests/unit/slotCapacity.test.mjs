import test from "node:test";
import assert from "node:assert/strict";
import { patientTypeOf, isFull } from "../../shared/slotCapacity.js";
import { validateTemplate } from "../../shared/slotTemplates.js";

test("walk-in first; then a patient seen before is a follow-up and anyone else is new", () => {
  assert.equal(patientTypeOf({ is_walkin: true, patient_id: 7, came_before: true }), "walkin");
  assert.equal(patientTypeOf({ patient_id: 7, visit_type: "OPD", came_before: false }), "new");
  assert.equal(
    patientTypeOf({ patient_id: 7, visit_type: "New Patient", came_before: true }),
    "followup",
  );
  assert.equal(patientTypeOf({ patient_id: null, visit_type: "OPD" }), "new");
  assert.equal(patientTypeOf({ patient_id: null, visit_type: "Follow-Up" }), "followup");
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
