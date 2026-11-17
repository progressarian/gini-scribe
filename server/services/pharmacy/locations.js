import { checkStockLevels } from "./alerts.js";
import pool from "../../config/db.js";
import { writeAudit } from "../billing/audit.js";
import { httpError, inTransaction } from "../billing/transaction.js";
import { masterRecords } from "./masterRecords.js";
import { MAIN_LOCATION_CODE } from "../../../shared/pharmacyVocab.js";

const locations = masterRecords({
  table: "pharmacy_locations",
  noun: "department",
  fields: ["code", "name", "notes"],
  readOnly: ["kind"],
  duplicates: {
    pharmacy_locations_code_key: "Another department already uses this code",
    pharmacy_locations_name_key: "A department with this name already exists",
  },
  searchColumns: ["code", "name"],
  listColumns: `(SELECT count(*)::int FROM pharmacy_location_levels l
                  WHERE l.location_id = pharmacy_locations.id) AS level_count`,
  orderBy: "(kind = 'main') DESC, is_active DESC, lower(name)",
  guardUpdate: (before, values) => {
    if (before.kind === "main" && values.code !== MAIN_LOCATION_CODE) {
      throw httpError(409, `The main pharmacy's code must stay ${MAIN_LOCATION_CODE}`);
    }
  },
  guardActive: (before) => {
    if (before.kind === "main") throw httpError(409, "The main pharmacy cannot be deactivated");
  },
});

export const listLocations = (params) => locations.list(params);
export const getLocation = (id) => locations.get(id);
export const createLocation = (input, ctx) => locations.create(input, ctx);
export const updateLocation = (id, input, ctx) => locations.update(id, input, ctx);
export const setLocationActive = (id, isActive, ctx) => locations.setActive(id, isActive, ctx);

async function departmentFor(db, id, { lock = false } = {}) {
  const { rows } = await db.query(
    `SELECT id, code, name, kind, is_active FROM pharmacy_locations
      WHERE id = $1 ${lock ? "FOR SHARE" : ""}`,
    [id],
  );
  if (!rows.length) throw httpError(404, "Department not found");
  if (rows[0].kind !== "department") {
    throw httpError(
      409,
      "The main pharmacy uses each medicine's own minimum and maximum. Set them on the medicine",
    );
  }
  return rows[0];
}

const LEVEL_ROW = `l.medicine_id, l.min_units, l.max_units, l.updated_at,
  m.code, m.name, m.unit_label, m.pack_label, m.pack_size, m.is_active AS medicine_active`;

export async function listLevels(locationId, { q, limit = 50, offset = 0 } = {}, db = pool) {
  const location = await departmentFor(db, locationId);
  const params = [locationId];
  let search = "";
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    search = "AND (lower(m.name) LIKE $2 OR lower(m.code) LIKE $2)";
  }
  params.push(limit, offset);
  const { rows } = await db.query(
    `SELECT ${LEVEL_ROW}, count(*) OVER()::int AS total
       FROM pharmacy_location_levels l
       JOIN pharmacy_medicines m ON m.id = l.medicine_id
      WHERE l.location_id = $1 ${search}
      ORDER BY lower(m.name)
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { location, rows: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0 };
}

async function currentLevel(client, locationId, medicineId) {
  const { rows } = await client.query(
    `SELECT ${LEVEL_ROW}
       FROM pharmacy_location_levels l
       JOIN pharmacy_medicines m ON m.id = l.medicine_id
      WHERE l.location_id = $1 AND l.medicine_id = $2`,
    [locationId, medicineId],
  );
  return rows[0] ?? null;
}

const levelId = (locationId, medicineId) => `${locationId}:${medicineId}`;

export async function saveLevel(locationId, medicineId, level, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    const location = await departmentFor(client, locationId, { lock: true });
    if (!location.is_active) {
      throw httpError(
        409,
        `${location.name} is deactivated. Activate it before changing its stock levels`,
      );
    }
    const { rows: medicine } = await client.query(
      `SELECT id, name, is_active FROM pharmacy_medicines WHERE id = $1 FOR SHARE`,
      [medicineId],
    );
    if (!medicine.length) throw httpError(404, "Medicine not found");
    if (!medicine[0].is_active) {
      throw httpError(409, `${medicine[0].name} is deactivated and cannot be stocked`);
    }
    const before = await currentLevel(client, locationId, medicineId);
    await client.query(
      `INSERT INTO pharmacy_location_levels (location_id, medicine_id, min_units, max_units, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (location_id, medicine_id)
       DO UPDATE SET min_units = EXCLUDED.min_units, max_units = EXCLUDED.max_units,
                     updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [locationId, medicineId, level.min_units, level.max_units ?? null, ctx.actorId ?? null],
    );
    const after = await currentLevel(client, locationId, medicineId);
    await writeAudit(client, {
      entity: "pharmacy_location_levels",
      entityId: levelId(locationId, medicineId),
      action: before ? "update" : "create",
      before,
      after,
      actorId: ctx.actorId,
      ip: ctx.ip,
    });
    await checkStockLevels(client, [{ locationId, medicineId }]);
    return after;
  }, db);
}

export async function removeLevel(locationId, medicineId, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    await departmentFor(client, locationId, { lock: true });
    const before = await currentLevel(client, locationId, medicineId);
    if (!before) throw httpError(404, "This medicine has no stock level in this department");
    await client.query(
      `DELETE FROM pharmacy_location_levels WHERE location_id = $1 AND medicine_id = $2`,
      [locationId, medicineId],
    );
    await writeAudit(client, {
      entity: "pharmacy_location_levels",
      entityId: levelId(locationId, medicineId),
      action: "delete",
      before,
      actorId: ctx.actorId,
      ip: ctx.ip,
    });
    return { removed: true };
  }, db);
}
