import express from "express";
import { searchReferringDoctors } from "../crm/registration.js";
import { handleError } from "../utils/errorHandler.js";

const router = express.Router();

// The doctor picker behind "who referred you?" on the registration forms.
// Search-as-you-type, so it must stay cheap and must never make the front desk
// wait: the query is capped, the result set is capped, and a short query
// returns nothing rather than scanning the universe.
router.get("/crm/registration/referring-doctors", async (req, res) => {
  try {
    const rows = await searchReferringDoctors(req.query.q, Number(req.query.limit) || 8);
    res.json(rows);
  } catch (e) {
    handleError(res, e, "Referring doctor search");
  }
});

export default router;
