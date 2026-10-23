import pool from "../../config/db.js";

export const readiness = (sql) => {
  let ready = false;
  let checking = null;
  let checkedAt = 0;
  return async (client = pool) => {
    if (ready) return true;
    if (checking) return checking;
    if (Date.now() - checkedAt < 5_000) return false;
    checking = client
      .query(sql)
      .then(({ rows }) => {
        ready = rows[0].ok;
        return ready;
      })
      .finally(() => {
        checkedAt = Date.now();
        checking = null;
      });
    return checking;
  };
};

export const columnReady = (table, column) =>
  readiness(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = '${column}'
     ) AS ok`,
  );
