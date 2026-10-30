import { forgetOutsidePending } from "../services/giniflow/outsidePending.js";

const CHANGES_PENDING =
  /^\/api\/giniflow\/(stations\/(lab|lab-site|reception|doctor|mo)\/|stations\/[^/]+\/cancelled\/|lab\/|test-catalog)/;

const CHANGES_NAMES = /^\/api\/(billing\/master\/|giniflow\/test-catalog)/;

export default function outsidePendingRefresh(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const pending = CHANGES_PENDING.test(req.path);
  const names = CHANGES_NAMES.test(req.path);
  if (!pending && !names) return next();
  res.on("finish", () => {
    if (res.statusCode < 400) forgetOutsidePending({ names });
  });
  next();
}
