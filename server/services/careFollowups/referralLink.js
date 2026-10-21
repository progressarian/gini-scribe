import { ACTIVE_STATUSES } from "../../../shared/careFollowups.js";
import {
  DESK_REFERRAL_SELECT,
  deskReferralShape,
  followupsSince,
  insertItems,
  itemRow,
} from "./collect.js";
import { DESK_KEY_PREFIX } from "./deskReferral.js";
import { loadCatalog } from "./match.js";

const MOVES = {
  booked_outside: { from: ["open", "booked"], to: "booked_outside" },
  completed: { from: ACTIVE_STATUSES, to: "done" },
  removed: { from: ACTIVE_STATUSES, to: "closed" },
};

async function itemFor(client, referralId) {
  const { rows } = await client.query(
    `SELECT id, status FROM care_followups WHERE source_key = $1 FOR UPDATE`,
    [`${DESK_KEY_PREFIX}${referralId}`],
  );
  return rows[0] || null;
}

async function upsertFromDesk(client, referralId) {
  const since = await followupsSince(client);
  if (!since) return null;
  const { rows } = await client.query(`${DESK_REFERRAL_SELECT} WHERE r.id = $1::uuid`, [
    referralId,
  ]);
  const referral = rows[0];
  if (!referral) return itemFor(client, referralId);
  const row = itemRow(referral, deskReferralShape(referral, await loadCatalog(client)));
  const existing = await itemFor(client, referralId);
  if (!existing) {
    if (referral.ordered_on < since) return null;
    await insertItems(client, "gf_referral", [row]);
    return itemFor(client, referralId);
  }
  if (existing.status === "open") {
    await client.query(
      `UPDATE care_followups
          SET kind = $2, target = $3, detail = $4, matched_doctor_id = $5, matched_specialty = $6,
              availability = $7, due_on = $8::date, updated_at = NOW()
        WHERE id = $1`,
      [
        existing.id,
        row.kind,
        row.target,
        row.detail,
        row.matched_doctor_id,
        row.matched_specialty,
        row.availability,
        row.due_on,
      ],
    );
  }
  return existing;
}

async function move(client, item, { to, note, actorId }) {
  await client.query(
    `UPDATE care_followups
        SET status = $2, outcome_reason = $3, updated_at = NOW()
      WHERE id = $1`,
    [item.id, to, note],
  );
  await client.query(
    `INSERT INTO care_followup_events (followup_id, kind, from_status, to_status, note, actor_id)
     VALUES ($1, 'desk', $2, $3, $4, $5)`,
    [item.id, item.status, to, note, actorId],
  );
}

async function apply(client, referralId, { event, note, actorId }) {
  const item =
    event === "removed"
      ? await itemFor(client, referralId)
      : await upsertFromDesk(client, referralId);
  const rule = MOVES[event];
  if (!item || !rule) return;
  if (rule.from.includes(item.status)) {
    await move(client, item, { to: rule.to, note, actorId });
  } else if (item.status === rule.to && note) {
    await client.query(
      `INSERT INTO care_followup_events (followup_id, kind, note, actor_id)
       VALUES ($1, 'desk', $2, $3)`,
      [item.id, note, actorId],
    );
  }
}

export async function syncFromDeskReferral(
  client,
  referralId,
  { event = "saved", note = null, actorId = null } = {},
) {
  await client.query("SAVEPOINT desk_followup");
  try {
    await apply(client, referralId, { event, note, actorId });
    await client.query("RELEASE SAVEPOINT desk_followup");
  } catch (e) {
    await client.query("ROLLBACK TO SAVEPOINT desk_followup");
    console.error("Referral desk → care follow-up sync failed:", e.message);
  }
}
