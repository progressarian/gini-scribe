import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { CONSULTANTS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  autoConsultation,
  desk,
  extraVisit,
  newTag,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { consultationItem, draftAtCheckIn } =
  await import("../../../server/services/billing/visitLines.js");
const bills = await import("../../../server/services/billing/bills.js");
const { consultantFeeGrid, consultantFeeNotPriced } =
  await import("../../../server/services/billing/consultantFees.js");
const { createItem, searchDeskItems, setItemActive, updateItem } =
  await import("../../../server/services/billing/serviceItems.js");
const { windowDeadline } = await import("../../../shared/followUp.js");

const db = getPool();
const tag = newTag();
const DOCTOR = CONSULTANTS.banshali.id;
let ids;
let autoBefore;
let win3;
let win7;
let closed;
const extra = [];
let addedHoliday = null;

const daysBefore = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

async function holidays() {
  const { rows } = await query(`SELECT holiday_date::text AS day FROM clinic_holidays`);
  return new Set(rows.map((r) => r.day));
}

function expectedFor(gap, windows, plainId) {
  const anchor = daysBefore(ids.day, gap);
  const fits = windows
    .filter((w) => windowDeadline(anchor, w.days, closed) >= ids.day)
    .sort((a, b) => a.days - b.days || (a.own === b.own ? 0 : a.own ? -1 : 1));
  return fits[0]?.id ?? plainId;
}

async function seenBefore(patient, daysAgo, doctorId = DOCTOR) {
  return (
    await one(
      `INSERT INTO appointments (patient_id, patient_name, file_no, appointment_date, visit_type,
                                 doctor_id, status)
       SELECT p.id, p.name, p.file_no, $2::date - $3::int, 'Follow Up', $4, 'completed'
         FROM patients p WHERE p.id = $1
       RETURNING id`,
      [patient, ids.day, daysAgo, doctorId],
    )
  ).id;
}

async function visitOf(made) {
  return one(
    `SELECT v.id, v.patient_id, v.appointment_id, v.assigned_doctor_id,
            v.visit_date::text AS visit_date, a.visit_type, a.doctor_id AS appointment_doctor_id,
            NULL::int AS journey_doctor_id, NULL::text AS journey_visit_type
       FROM giniflow_visits v JOIN appointments a ON a.id = v.appointment_id
      WHERE v.id = $1`,
    [made.visit],
  );
}

const chosen = async (made) => consultationItem(db, await visitOf(made));

async function patientSeen(label, gap, doctorId = DOCTOR) {
  const made = await extraVisit(ids, label, { visitType: "Follow Up", healthray: false });
  await seenBefore(made.patient, gap, doctorId);
  return made;
}

async function firstGapOutside(window) {
  for (let n = window + 1; ; n += 1) {
    if (windowDeadline(daysBefore(ids.day, n), window, closed) < ids.day) return n;
  }
}

const windowItem = async (days, price, doctorId = DOCTOR, label = `W${days}`) => {
  const saved = await createItem(
    {
      code: `P4-${label}-${tag}`,
      name: `Follow-up within ${days} days ${label} ${tag}`,
      subgroup_id: ids.subgroup,
      base_price: price,
      kind: "consultation",
      visit_type: "Follow Up",
      follow_up_within_days: days,
      doctor_id: doctorId,
    },
    desk,
    db,
  );
  extra.push(saved.id);
  return saved.id;
};

test.describe.serial("P4C-59 follow-up windows are set per consultation item", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(true);
    closed = await holidays();
    win3 = await windowItem(3, 0);
    win7 = await windowItem(7, 700);
  });

  test.afterAll(async () => {
    if (addedHoliday) {
      await query(`DELETE FROM clinic_holidays WHERE holiday_date = $1::date`, [addedHoliday]);
    }
    if (autoBefore !== undefined) await autoConsultation(autoBefore);
    await tearDown(ids);
    await query(`DELETE FROM service_items WHERE id = ANY($1)`, [extra]).catch(() => {});
  });

  test("1. windowDeadline moves a closed last day to the next open day", () => {
    expect(windowDeadline("2026-11-05", 3)).toBe("2026-11-09");
    expect(windowDeadline("2026-11-02", 7)).toBe("2026-11-09");
    expect(windowDeadline("2026-11-04", 3)).toBe("2026-11-07");
    expect(windowDeadline("2026-11-07", 7, new Set(["2026-11-14"]))).toBe("2026-11-16");
    expect(windowDeadline("2026-11-04", 3, new Set(["2026-11-07"]))).toBe("2026-11-09");
    expect(windowDeadline("2026-11-02", 90)).toBe("2027-02-01");
    expect(windowDeadline("", 3)).toBe("");
  });

  test("2. the smallest window that fits wins, then the normal Follow Up fee", async () => {
    const windows = [
      { id: win3, days: 3, own: true },
      { id: win7, days: 7, own: true },
    ];
    expect((await chosen(await patientSeen("G2", 2))).id).toBe(win3);
    expect((await chosen(await patientSeen("G7", 7))).id).toBe(win7);
    const outside = await firstGapOutside(7);
    expect((await chosen(await patientSeen("Gout", outside))).id).toBe(ids.consultFu);
    for (const gap of [1, 3, 4, 5, 6, 8]) {
      const made = await patientSeen(`Gap${gap}`, gap);
      expect({ gap, id: (await chosen(made))?.id }).toEqual({
        gap,
        id: expectedFor(gap, windows, ids.consultFu),
      });
    }
  });

  test("3. a never-seen patient gets the booked visit type's fee", async () => {
    const made = await extraVisit(ids, "Never", { visitType: "Follow Up", healthray: false });
    expect((await chosen(made)).id).toBe(ids.consultFu);
  });

  test("4. a shorter hospital-default window beats a longer one of the doctor's own", async () => {
    const default5 = await windowItem(5, 50, null, "D5");
    const gap = [4, 5, 6].find(
      (g) =>
        windowDeadline(daysBefore(ids.day, g), 3, closed) < ids.day &&
        windowDeadline(daysBefore(ids.day, g), 5, closed) >= ids.day,
    );
    if (gap) expect((await chosen(await patientSeen("Def5", gap))).id).toBe(default5);
    await setItemActive(default5, false, desk, db);
  });

  test("5. at an equal window the doctor's own beats the hospital default", async () => {
    const default7 = await windowItem(7, 70, null, "D7");
    expect((await chosen(await patientSeen("Eq7", 7))).id).toBe(win7);
    await setItemActive(default7, false, desk, db);
  });

  test("6. a deactivated window no longer applies", async () => {
    await setItemActive(win3, false, desk, db);
    expect((await chosen(await patientSeen("Off3", 2))).id).toBe(win7);
    await setItemActive(win3, true, desk, db);
  });

  test("7. another consultant's visit does not start a window", async () => {
    expect((await chosen(await patientSeen("Other", 2, CONSULTANTS.rahul.id))).id).toBe(
      ids.consultFu,
    );
  });

  test("8. no chaining: a visit billed at a window fee is not the anchor", async () => {
    const windows = [
      { id: win3, days: 3, own: true },
      { id: win7, days: 7, own: true },
    ];
    const made = await patientSeen("Chain", 10);
    const earlierAppt = await seenBefore(made.patient, 5);
    const earlierVisit = (
      await one(
        `INSERT INTO giniflow_visits (patient_id, visit_date, appointment_id, assigned_doctor_id)
         VALUES ($1, $2::date - 5, $3, $4) RETURNING id`,
        [made.patient, ids.day, earlierAppt, DOCTOR],
      )
    ).id;
    const earlierBill = await bills.openDraft(earlierVisit, desk, db);
    await bills.addLine(earlierBill.id, { item_id: win7, doctor_id: DOCTOR }, desk, db);
    expect((await chosen(made))?.id).toBe(expectedFor(10, windows, ids.consultFu));

    const { lines } = await bills.readBill(earlierBill.id, db);
    const windowLine = lines.find((l) => l.service_item_id === win7 && l.is_live);
    await bills.removeLine(
      earlierBill.id,
      windowLine.id,
      { reason: "P4C-59 chaining check" },
      desk,
      db,
    );
    expect((await chosen(made))?.id).toBe(expectedFor(5, windows, ids.consultFu));
  });

  test("9. a clinic holiday on the last day moves it to the next open day", async () => {
    const gap = 4;
    const lastDay = daysBefore(ids.day, 1);
    if (closed.has(lastDay)) return;
    const inserted = await query(
      `INSERT INTO clinic_holidays (holiday_date, remarks) VALUES ($1::date, $2)
       ON CONFLICT (holiday_date) DO NOTHING RETURNING id`,
      [lastDay, `P4C-59 ${tag}`],
    );
    if (inserted.rows.length) addedHoliday = lastDay;
    await setItemActive(win7, false, desk, db);
    try {
      expect((await chosen(await patientSeen("Hol", gap))).id).toBe(win3);
    } finally {
      await setItemActive(win7, true, desk, db);
      if (addedHoliday) {
        await query(`DELETE FROM clinic_holidays WHERE holiday_date = $1::date`, [addedHoliday]);
        addedHoliday = null;
      }
    }
  });

  test("10. a priced window is put on the bill at check-in without HealthRay", async () => {
    const made = await patientSeen("CheckIn", 7);
    await draftAtCheckIn(made.visit, desk, db);
    const draft = await bills.openDraft(made.visit, desk, db);
    const bill = await bills.readBill(draft.id, db);
    const line = bill.lines.find((l) => l.service_item_id === win7);
    expect(line).toBeTruthy();
    expect(Number(line.patient_payable)).toBe(70000);
  });

  test("11. a window can't be added by hand outside its days", async () => {
    const made = await patientSeen("Hand", await firstGapOutside(7));
    const draft = await bills.openDraft(made.visit, desk, db);
    await expect(
      bills.addLine(draft.id, { item_id: win7, doctor_id: DOCTOR }, desk, db),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("within 7 days") });
  });

  test("12. changing the consultant re-checks the window for the new doctor", async () => {
    const rahulFu = await createItem(
      {
        code: `P4-RFU-${tag}`,
        name: `Rahul Follow Up ${tag}`,
        subgroup_id: ids.subgroup,
        base_price: 900,
        kind: "consultation",
        visit_type: "Follow Up",
        doctor_id: CONSULTANTS.rahul.id,
      },
      desk,
      db,
    );
    extra.push(rahulFu.id);
    const made = await patientSeen("Swap", 2);
    const draft = await bills.openDraft(made.visit, desk, db);
    await bills.setConsultant(draft.id, { consultant_id: CONSULTANTS.rahul.id }, desk, db);
    const bill = await bills.readBill(draft.id, db);
    const ids_ = bill.lines.filter((l) => l.is_live).map((l) => l.service_item_id);
    expect(ids_).toContain(rahulFu.id);
    expect(ids_).not.toContain(win3);
  });

  test("13. validation: one window per length, 1–90 days, Follow Up only", async () => {
    const base = {
      name: `Bad ${tag}`,
      subgroup_id: ids.subgroup,
      base_price: 10,
      kind: "consultation",
      visit_type: "Follow Up",
      doctor_id: DOCTOR,
    };
    await expect(
      createItem({ ...base, code: `P4-DUP7-${tag}`, follow_up_within_days: 7 }, desk, db),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("7-day") });
    for (const days of [0, 91, 2.5]) {
      await expect(
        createItem({ ...base, code: `P4-BAD-${tag}`, follow_up_within_days: days }, desk, db),
      ).rejects.toMatchObject({ status: 400 });
    }
    await expect(
      createItem(
        { ...base, code: `P4-NEWW-${tag}`, visit_type: "New", follow_up_within_days: 5 },
        desk,
        db,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(updateItem(win7, { visit_type: "New" }, desk, db)).rejects.toMatchObject({
      status: 400,
    });
  });

  test("14. the fee grid lists windows by length and never flags them as unpriced", async () => {
    const grid = await consultantFeeGrid({ doctorId: DOCTOR }, db);
    const mine = grid.rows.filter((r) => r.doctor_id === DOCTOR);
    const order = mine.map((r) => r.follow_up_within_days ?? r.visit_type);
    expect(order.indexOf("Follow Up")).toBeLessThan(order.indexOf(3));
    expect(order.indexOf(3)).toBeLessThan(order.indexOf(7));
    const unpriced = await consultantFeeNotPriced({ doctorId: DOCTOR }, db);
    expect(unpriced.rows.every((r) => ["New", "Follow Up"].includes(r.visit_type))).toBe(true);
    expect(unpriced.rows.filter((r) => r.doctor_id === DOCTOR)).toEqual([]);
  });

  test("15. desk search offers a window only when it applies to the visit", async () => {
    const made = await patientSeen("Desk", 2);
    const found = await searchDeskItems({ q: `Follow-up within ${tag}`, visitId: made.visit }, db);
    const shown = found.items.map((i) => i.id);
    expect(shown).toContain(win3);
    expect(shown).not.toContain(win7);
  });

  test("16. a backfilled old 3-day item is used as a 3-day window", async () => {
    const legacy = (
      await one(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, visit_type,
                                    follow_up_within_days, doctor_id)
         VALUES ($1, $2, $3, 0, 'consultation', 'Follow Up (3 days)', 3, $4) RETURNING id`,
        [`P4-LEG-${tag}`, `Legacy 3 days ${tag}`, ids.subgroup, CONSULTANTS.beant.id],
      )
    ).id;
    extra.push(legacy);
    const made = await extraVisit(ids, "Leg2", {
      visitType: "Follow Up",
      doctorId: CONSULTANTS.beant.id,
      healthray: false,
    });
    await seenBefore(made.patient, 1, CONSULTANTS.beant.id);
    expect((await chosen(made))?.id).toBe(legacy);
  });
});
