import { Router } from "express";
import { validate, validateQuery } from "../middleware/validate.js";
import { handleError } from "../utils/errorHandler.js";
import { notificationListQuerySchema, notificationReadSchema } from "../schemas/index.js";
import { listNotifications, markNotificationsRead } from "../services/notifications.js";

const router = Router();

router.use("/notifications", (req, res, next) =>
  req.doctor?.doctor_id ? next() : res.status(403).json({ error: "Staff sign-in needed" }),
);

router.get("/notifications", validateQuery(notificationListQuerySchema), async (req, res) => {
  try {
    res.json(
      await listNotifications(req.doctor, {
        limit: req.query.limit,
        unread: req.query.unread === "1",
      }),
    );
  } catch (e) {
    handleError(res, e, "Notifications");
  }
});

router.post("/notifications/read", validate(notificationReadSchema), async (req, res) => {
  try {
    res.json(await markNotificationsRead(req.doctor, req.body));
  } catch (e) {
    handleError(res, e, "Mark notifications read");
  }
});

export default router;
