import pool from "../../config/db.js";

const plural = (count, one, many) => (count === 1 ? one : many);

export const USAGE_KINDS = {
  group: {
    table: "service_groups",
    key: "id",
    label: "name",
    uses: [
      {
        table: "service_subgroups",
        column: "group_id",
        text: (n, name) => `${n} ${plural(n, "subgroup", "subgroups")} under ${name}`,
      },
    ],
  },
  subgroup: {
    table: "service_subgroups",
    key: "id",
    label: "name",
    uses: [
      {
        table: "service_items",
        column: "subgroup_id",
        text: (n, name) => `${n} ${plural(n, "item", "items")} in ${name}`,
      },
    ],
  },
  item: {
    table: "service_items",
    key: "id",
    label: "name",
    uses: [
      {
        table: "category_item_rates",
        column: "service_item_id",
        text: (n, name) => `${n} ${plural(n, "category rate", "category rates")} for ${name}`,
      },
    ],
  },
  taxCode: {
    table: "tax_codes",
    key: "id",
    label: "code",
    uses: [
      {
        table: "service_items",
        column: "tax_code_id",
        text: (n, name) => `${n} ${plural(n, "item uses", "items use")} tax code ${name}`,
      },
    ],
  },
  category: {
    table: "patient_schemes",
    key: "code",
    label: "label",
    uses: [
      {
        table: "patient_schemes",
        column: "parent_code",
        text: (n, name) => `${n} ${plural(n, "sub-category", "sub-categories")} under ${name}`,
      },
      {
        table: "category_rules",
        column: "scheme_code",
        text: (n, name) => `${n} ${plural(n, "category rule", "category rules")} for ${name}`,
      },
      {
        table: "category_item_rates",
        column: "scheme_code",
        text: (n, name) => `${n} ${plural(n, "category rate", "category rates")} for ${name}`,
      },
      {
        table: "patients",
        column: "scheme_code",
        text: (n, name) => `${n} ${plural(n, "patient is", "patients are")} recorded as ${name}`,
      },
      {
        table: "giniflow_lab_orders",
        column: "scheme_code",
        text: (n, name) =>
          `${n} ${plural(n, "test order is", "test orders are")} priced as ${name}`,
      },
      {
        table: "scheme_cap_overrides",
        column: "scheme_code",
        text: (n, name) =>
          `${n} daily-limit ${plural(n, "override is", "overrides are")} recorded for ${name}`,
      },
      {
        table: "appointments",
        column: "patient_category",
        text: (n, name) =>
          `${n} ${plural(n, "appointment is", "appointments are")} booked as ${name}`,
      },
    ],
  },
};

const kindOf = (kind) => {
  if (!Object.hasOwn(USAGE_KINDS, kind)) throw new Error(`whereUsed: unknown kind "${kind}"`);
  return USAGE_KINDS[kind];
};

export async function whereUsed(kind, key, db = pool) {
  const spec = kindOf(kind);
  const found = await db.query(
    `SELECT ${spec.label} AS name FROM ${spec.table} WHERE ${spec.key} = $1`,
    [key],
  );
  if (!found.rows.length) {
    throw Object.assign(new Error(`${kind} "${key}" not found`), { status: 404 });
  }
  const name = found.rows[0].name;
  const uses = [];
  for (const use of spec.uses) {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM ${use.table} WHERE ${use.column} = $1`,
      [key],
    );
    if (rows[0].n > 0) {
      uses.push({
        table: use.table,
        column: use.column,
        count: rows[0].n,
        text: use.text(rows[0].n, name),
      });
    }
  }
  return { name, uses };
}

export async function assertUnused(kind, key, db = pool) {
  const { name, uses } = await whereUsed(kind, key, db);
  if (uses.length) {
    throw Object.assign(
      new Error(
        `${name} can't be deleted because it is still used: ${uses.map((u) => u.text).join("; ")}. Deactivate it instead.`,
      ),
      { status: 409, uses },
    );
  }
  return { name };
}
