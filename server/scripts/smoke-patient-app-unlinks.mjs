import "../loadEnv.js";
import pool from "../config/db.js";
import { listLinkedPatients } from "../routes/patientAuth.js";
import {
  getFamilyForPatient,
  relinkFamilyMember,
  unlinkFamilyMember,
} from "../services/patientAppUnlinks.js";

const [viewedId, memberId] = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
if (!viewedId || !memberId || !process.argv.includes("--apply")) {
  console.error(
    "usage: node scripts/smoke-patient-app-unlinks.mjs <patientId> <familyMemberPatientId> --apply\n" +
      "Use a TEST phone: the member's app sessions on it are signed out during the run.",
  );
  process.exit(1);
}

const ids = async (phone) => (await listLinkedPatients("hospital", phone)).map((p) => Number(p.id));
let failed = 0;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
};

const family = await getFamilyForPatient(Number(viewedId));
const phone = family.phone;
check(
  "member is on the viewed patient's phone",
  family.members.some((m) => m.id === memberId),
);
check("member starts linked", (await ids(phone)).includes(Number(memberId)));

const { id: unlinkId } = await unlinkFamilyMember(
  {
    patientId: Number(viewedId),
    source: "hospital",
    memberId,
    reason: "smoke test",
    requestedBy: "smoke-patient-app-unlinks",
  },
  null,
);
try {
  check(
    "removed member is gone from the app family list",
    !(await ids(phone)).includes(Number(memberId)),
  );
  const after = await getFamilyForPatient(Number(viewedId));
  check(
    "admin view still lists the member, marked removed",
    after.members.some((m) => m.id === memberId && m.unlinked),
  );
  let refused = false;
  try {
    await unlinkFamilyMember(
      {
        patientId: Number(viewedId),
        source: "hospital",
        memberId,
        reason: "again",
        requestedBy: "smoke",
      },
      null,
    );
  } catch (e) {
    refused = e.status === 409;
  }
  check("removing twice is refused", refused);
} finally {
  await relinkFamilyMember(unlinkId, null);
}
check("restore brings the member back", (await ids(phone)).includes(Number(memberId)));

await pool.end();
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
