import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");

async function run() {
  const { rows: stats } = await pool.query(
    `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE phone IS NOT NULL AND phone <> '')::int AS with_phone,
        COUNT(*) FILTER (WHERE phone IS NULL OR phone = '')::int AS without_phone
       FROM patients`,
  );
  console.log(
    `\nPatient totals — total: ${stats[0].total}, with phone: ${stats[0].with_phone}, without phone: ${stats[0].without_phone}`,
  );

  const { rows: dupPhones } = await pool.query(
    `SELECT phone, COUNT(*)::int AS cnt
       FROM patients
      WHERE phone IS NOT NULL AND phone <> ''
      GROUP BY phone
     HAVING COUNT(*) > 1
      ORDER BY cnt DESC, phone`,
  );

  console.log(`\nPhone numbers shared by more than one patient: ${dupPhones.length}`);

  if (dupPhones.length === 0) {
    console.log("No duplicate phones found.");
    return;
  }

  const phones = dupPhones.map((r) => r.phone);
  const { rows } = await pool.query(
    `SELECT phone, id, name, file_no, created_at
       FROM patients
      WHERE phone = ANY($1::text[])
      ORDER BY phone, created_at`,
    [phones],
  );

  const grouped = new Map();
  for (const r of rows) {
    if (!grouped.has(r.phone)) grouped.set(r.phone, []);
    grouped.get(r.phone).push(r);
  }

  let totalPatients = 0;
  for (const [phone, list] of grouped) {
    totalPatients += list.length;
    console.log(`\nPhone: ${phone}  (shared by ${list.length} patients)`);
    console.table(
      list.map((p) => ({
        id: p.id,
        file_no: p.file_no || "(none)",
        name: p.name,
        created_at: p.created_at,
      })),
    );
  }

  console.log(`\nTotal patients involved in shared-phone groups: ${totalPatients}`);
  console.log(`Total distinct shared phone numbers: ${dupPhones.length}`);
}

run()
  .catch((e) => {
    console.error("ERROR:", e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
