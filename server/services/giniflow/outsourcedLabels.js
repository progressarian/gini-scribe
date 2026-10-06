import pool from "../../config/db.js";
import { outsourcedTestNames } from "../billing/testMatch.js";

const ORDER_LISTS = ["pending", "awaitingSample", "cleared"];
const CASE_LISTS = ["healthrayLab", "healthrayLabCleared"];

export async function labelOutsourcedPayments(queue, db = pool) {
  const orders = ORDER_LISTS.flatMap((list) => queue[list] || []);
  const cases = CASE_LISTS.flatMap((list) => queue[list] || []).flatMap((lab) => lab.cases || []);
  const outsourced = await outsourcedTestNames(db, [
    ...orders.flatMap((order) => (order.tests || []).map((test) => test.name)),
    ...cases.flatMap((c) => c.tests || []),
  ]);
  const markOrder = (order) => ({
    ...order,
    tests: (order.tests || []).map((test) => ({ ...test, outsourced: outsourced.has(test.name) })),
  });
  const markLab = (lab) => ({
    ...lab,
    cases: (lab.cases || []).map((c) => ({
      ...c,
      outsourcedTests: (c.tests || []).filter((name) => outsourced.has(name)),
    })),
  });
  return {
    ...queue,
    ...Object.fromEntries(ORDER_LISTS.map((list) => [list, (queue[list] || []).map(markOrder)])),
    ...Object.fromEntries(CASE_LISTS.map((list) => [list, (queue[list] || []).map(markLab)])),
  };
}
