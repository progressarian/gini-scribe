import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";

const router = Router();

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

const notFound = (res) => res.status(404).json({ error: "not_found" });

router.get("/corporate/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").toLowerCase();
    if (!SLUG_RE.test(slug)) return notFound(res);

    const r = await pool.query(
      `SELECT c.name        AS company_name,
              c.slug        AS company_slug,
              p.id          AS package_id,
              p.name        AS package_name,
              p.description AS package_description,
              t.id          AS test_id,
              t.test_name,
              t.precaution_note
         FROM corporate_companies c
         LEFT JOIN corporate_packages p
               ON p.company_id = c.id AND p.is_active
         LEFT JOIN corporate_package_tests t
               ON t.package_id = p.id
        WHERE c.slug = $1 AND c.is_active
        ORDER BY p.sort_order, p.id, t.sort_order, t.id`,
      [slug],
    );

    if (!r.rows.length) return notFound(res);

    const packages = [];
    const byId = new Map();
    for (const row of r.rows) {
      if (!row.package_id) continue;
      let pkg = byId.get(row.package_id);
      if (!pkg) {
        pkg = {
          id: row.package_id,
          name: row.package_name,
          description: row.package_description,
          tests: [],
        };
        byId.set(row.package_id, pkg);
        packages.push(pkg);
      }
      if (row.test_id) {
        pkg.tests.push({
          id: row.test_id,
          name: row.test_name,
          precaution: row.precaution_note,
        });
      }
    }

    res.json({
      company: { slug: r.rows[0].company_slug, name: r.rows[0].company_name },
      packages,
    });
  } catch (e) {
    handleError(res, e, "Corporate company lookup");
  }
});

export default router;
