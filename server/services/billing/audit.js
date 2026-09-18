export const AUDIT_ACTIONS = [
  "create",
  "update",
  "delete",
  "deactivate",
  "activate",
  "cancel",
  "approve",
  "reject",
  "import",
];

export const REDACTED = "[redacted]";

const SENSITIVE_KEYS = new Set([
  "scheme_ref",
  "card_no",
  "card_number",
  "pin",
  "password",
  "token",
  "access_token",
  "refresh_token",
]);

const isSensitive = (key) => {
  const name = String(key).toLowerCase();
  return SENSITIVE_KEYS.has(name) || name.startsWith("aadhaar");
};

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      isSensitive(key) && inner !== null && inner !== undefined ? REDACTED : redact(inner),
    ]),
  );
}

const requiredText = (name, value) => {
  const text = value === null || value === undefined ? "" : String(value).trim();
  if (!text) throw new Error(`writeAudit: ${name} is required`);
  return text;
};

const snapshot = (value) =>
  value === undefined || value === null ? null : JSON.stringify(redact(value));

export function auditContext(req) {
  return {
    actorId: req?.doctor?.doctor_id ?? null,
    ip: req?.ip ?? null,
  };
}

export async function writeAudit(client, { entity, entityId, action, before, after, actorId, ip }) {
  if (!client || typeof client.release !== "function") {
    throw new Error("writeAudit needs the transaction's client, not the pool");
  }
  const verb = requiredText("action", action);
  if (!AUDIT_ACTIONS.includes(verb)) {
    throw new Error(`writeAudit: unknown action "${verb}" (allowed: ${AUDIT_ACTIONS.join(", ")})`);
  }
  const values = [
    requiredText("entity", entity),
    requiredText("entityId", entityId),
    verb,
    snapshot(before),
    snapshot(after),
    actorId ?? null,
    ip ?? null,
  ];
  try {
    await client.query("SAVEPOINT billing_audit_write");
  } catch (error) {
    if (error.code === "25P01") {
      throw new Error("writeAudit must run inside the caller's open transaction (BEGIN first)");
    }
    throw error;
  }
  const { rows } = await client.query(
    `INSERT INTO billing_audit (entity, entity_id, action, before, after, actor_id, ip)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
     RETURNING id`,
    values,
  );
  await client.query("RELEASE SAVEPOINT billing_audit_write");
  return rows[0].id;
}
