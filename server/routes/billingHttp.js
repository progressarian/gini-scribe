import crypto from "node:crypto";

const DETAILS = [
  "uses",
  "active",
  "conflicts",
  "needs_sub_category",
  "suggestions",
  "line_no",
  "version",
  "bill_id",
  "bill_no",
  "service_item_id",
  "items",
  "rules",
  "problems",
];

export function sendFailure(context, res, e) {
  if (Number.isInteger(e?.status) && e.status >= 400 && e.status < 500) {
    const details = Object.fromEntries(DETAILS.filter((k) => k in e).map((k) => [k, e[k]]));
    return res.status(e.status).json({ error: e.message, ...details });
  }
  const ref = crypto.randomBytes(4).toString("hex");
  console.error(`${context} failed [ref ${ref}]:`, e?.message, e?.code || "", e?.stack || "");
  return res
    .status(500)
    .json({ error: `Something went wrong — it has been logged (ref ${ref})`, ref });
}

export const billingRoute = (context, status, work) => async (req, res) => {
  try {
    res.status(status).json(await work(req));
  } catch (e) {
    sendFailure(context, res, e);
  }
};
