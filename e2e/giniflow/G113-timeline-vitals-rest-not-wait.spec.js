import { test, expect } from "@playwright/test";

await import("../../server/services/giniflow/board.js");
const { getStationTimes } = await import("../../server/services/giniflow/statusEngine.js");
const { VITALS_REST_MINUTES } = await import("../../shared/giniflowStatus.js");

const now = new Date();
const ago = (mins) => new Date(now.getTime() - mins * 60000);
const fakeDb = (rows) => ({
  query: async () => ({
    rows: rows.map(([status, at]) => ({
      status,
      actor_role: "reception",
      occurred_at: at,
      meta: {},
    })),
  }),
});
const sla = { checkin_to_vitals: 10, vitals: 5 };
const vitalsStep = (steps) => steps.find((s) => s.status === "with_vitals");

test.describe("G113 the vitals rest is not counted as waiting on the timeline", () => {
  test("1. called right after the rest reads no wait", async () => {
    const steps = await getStationTimes(
      fakeDb([
        ["checked_in", ago(14)],
        ["with_vitals", ago(3)],
        ["vitals_done", ago(2)],
      ]),
      "v",
      sla,
      now,
    );
    expect(vitalsStep(steps).waitMinutes).toBe(1);
    expect(vitalsStep(steps).restMinutes).toBe(VITALS_REST_MINUTES);
  });

  test("2. a long wait counts only the time after the rest", async () => {
    const steps = await getStationTimes(
      fakeDb([
        ["checked_in", ago(40)],
        ["with_vitals", ago(12)],
        ["vitals_done", ago(7)],
      ]),
      "v",
      sla,
      now,
    );
    expect(vitalsStep(steps).waitMinutes).toBe(28 - VITALS_REST_MINUTES);
  });

  test("3. a doctor with the rest switched off keeps the full wait", async () => {
    const steps = await getStationTimes(
      fakeDb([
        ["checked_in", ago(14)],
        ["with_vitals", ago(3)],
        ["vitals_done", ago(2)],
      ]),
      "v",
      sla,
      now,
      { restSkipped: true },
    );
    expect(vitalsStep(steps).waitMinutes).toBe(11);
    expect(vitalsStep(steps).restMinutes).toBe(0);
  });

  test("4. a patient still resting reads no wait and carries the rest end", async () => {
    const steps = await getStationTimes(fakeDb([["checked_in", ago(6)]]), "v", sla, now);
    const current = steps.find((s) => s.isCurrent);
    expect(current.waitMinutes).toBe(0);
    expect(new Date(current.restUntil).getTime()).toBe(
      ago(6).getTime() + VITALS_REST_MINUTES * 60000,
    );
  });
});
