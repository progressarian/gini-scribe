import pool from "../../config/db.js";
import { inTransaction } from "./transaction.js";
import { clearReceptionLines, openDraft } from "./bills.js";
import { consultationForDesk, testsForDesk } from "./visitLines.js";
import { healthrayLinesForDesk } from "./healthrayBillLines.js";
import { labCaseTestsForDesk } from "./labCaseLines.js";
import { autofillIsCurrent, rememberAutofill } from "./autofillKey.js";

const DRAFT_VERSION_SQL = `
  SELECT version FROM bills WHERE visit_id = $1 AND status = 'draft' AND bill_type = 'invoice'`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function draftVersion(client, visitId) {
  if (!UUID.test(String(visitId ?? "").trim())) return null;
  const { rows } = await client.query(DRAFT_VERSION_SQL, [visitId]);
  return rows[0]?.version ?? null;
}

export async function openDeskDraft(visitId, ctx, db = pool) {
  const opening = { ...ctx, unsavedDraft: true };
  return inTransaction(async (client) => {
    if (await autofillIsCurrent(client, visitId)) {
      return openDraft(visitId, { ...opening, skipPriceCatchUp: true }, client);
    }
    const versionBefore = await draftVersion(client, visitId);
    await consultationForDesk(visitId, opening, client);
    await healthrayLinesForDesk(visitId, opening, client);
    await testsForDesk(visitId, opening, client);
    await labCaseTestsForDesk(visitId, opening, client);
    await clearReceptionLines(visitId, opening, client);
    const versionAfter = await draftVersion(client, visitId);
    const repricedNow = versionAfter !== null && versionAfter > (versionBefore ?? 0);
    const opened = await openDraft(visitId, { ...opening, skipPriceCatchUp: repricedNow }, client);
    await rememberAutofill(client, opened.id, visitId, opening);
    return opened;
  }, db);
}
