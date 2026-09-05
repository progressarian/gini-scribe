import pool from "../../config/db.js";

// The clinic's test list: what the floor can order, what reception prices.
// One table behind three screens — the consultant's picker, the MO's chips and
// this admin view — so a test added on the floor is priced here and nowhere else.

// A test the catalogue does not have yet. The floor orders things nobody
// listed — an outside ultrasound, a one-off panel — and refusing them means the
// order leaves Gini Flow entirely and stops being tracked. It joins the same
// catalogue rather than becoming a free-text line, so reception prices it, the
// lab sees it and the next consultant can pick it from the list.
//
// Price 0 because nobody has set one; `source` says who added it, which is how
// reception's "prices are placeholders" warning already works.
export async function addCatalogTest(name, { gloss = null, addedBy = null } = {}, db = pool) {
  const clean = String(name || "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length < 2) {
    throw Object.assign(new Error("A test needs a name"), { status: 400 });
  }

  const { rows: existing } = await db.query(
    `SELECT test_name, price, gloss, is_active FROM giniflow_test_catalog
      WHERE UPPER(test_name) = UPPER($1)`,
    [clean],
  );
  if (existing.length) {
    if (!existing[0].is_active) {
      await db.query(
        `UPDATE giniflow_test_catalog SET is_active = true, updated_at = NOW()
          WHERE UPPER(test_name) = UPPER($1)`,
        [clean],
      );
    }
    return {
      name: existing[0].test_name,
      price: Number(existing[0].price),
      gloss: existing[0].gloss,
      created: false,
    };
  }

  const { rows } = await db.query(
    `INSERT INTO giniflow_test_catalog (test_name, price, gloss, source)
     VALUES ($1, 0, $2, $3)
     ON CONFLICT (test_name) DO UPDATE SET is_active = true, updated_at = NOW()
     RETURNING test_name, price, gloss`,
    [clean, gloss, addedBy ? `added_by_doctor_${addedBy}` : "added_on_the_floor"],
  );
  return {
    name: rows[0].test_name,
    price: Number(rows[0].price),
    gloss: rows[0].gloss,
    created: true,
  };
}

// Everything, active and retired, with what each test has been used for. The
// admin screen needs the retired ones — retiring is how a typo is undone, and a
// list that hides them cannot show that it worked.
export async function listCatalog(db = pool) {
  const { rows } = await db.query(
    `SELECT c.id, c.test_name, c.price, c.gloss, c.is_active, c.source, c.updated_at,
            COALESCE(u.times_ordered, 0)::int AS times_ordered,
            u.last_ordered::text AS last_ordered
       FROM giniflow_test_catalog c
       LEFT JOIN (
         SELECT t.test_name,
                COUNT(*) AS times_ordered,
                MAX(o.created_at)::date AS last_ordered
           FROM giniflow_lab_order_tests t
           JOIN giniflow_lab_orders o ON o.id = t.lab_order_id
          GROUP BY t.test_name
       ) u ON u.test_name = c.test_name
      ORDER BY c.is_active DESC, c.test_name`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.test_name,
    price: Number(r.price),
    gloss: r.gloss,
    isActive: r.is_active,
    source: r.source,
    updatedAt: r.updated_at,
    timesOrdered: r.times_ordered,
    lastOrdered: r.last_ordered,
  }));
}

// Renaming is deliberately not here. Orders store the test NAME, so a rename
// would orphan every line already placed against the old one; retire it and add
// the correct name instead.
export async function updateCatalogTest(id, { price, gloss, isActive } = {}, db = pool) {
  if (price != null && (!Number.isFinite(Number(price)) || Number(price) < 0)) {
    throw Object.assign(new Error("Price cannot be negative"), { status: 400 });
  }
  const { rows } = await db.query(
    `UPDATE giniflow_test_catalog
        SET price = COALESCE($2, price),
            gloss = COALESCE($3, gloss),
            is_active = COALESCE($4, is_active),
            source = CASE WHEN $2 IS NULL THEN source ELSE 'priced_by_admin' END,
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, test_name, price, gloss, is_active, source`,
    [id, price ?? null, gloss ?? null, isActive ?? null],
  );
  if (!rows.length) throw Object.assign(new Error("Test not found"), { status: 404 });
  const r = rows[0];
  return {
    id: r.id,
    name: r.test_name,
    price: Number(r.price),
    gloss: r.gloss,
    isActive: r.is_active,
    source: r.source,
  };
}
