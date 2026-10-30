import { forgetOutsidePending } from "../services/giniflow/outsidePending.js";

const CHANGES_PENDING =
  /^\/api\/(giniflow\/(stations\/(lab|lab-site|reception|doctor|mo)\/|stations\/[^/]+\/cancelled\/|lab\/|test-catalog)|billing\/master\/)/;

export default function outsidePendingRefresh(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (!CHANGES_PENDING.test(req.path)) return next();
  res.on("finish", () => {
    if (res.statusCode < 400) forgetOutsidePending();
  });
  next();
}
