import { Router } from "express";
import { handleError } from "../utils/errorHandler.js";
import { pharmacyHub } from "../services/pharmacy/live.js";

const router = Router();

router.get("/pharmacy/live/events", (req, res) => {
  try {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });
    const client = pharmacyHub.addClient(res, {
      lastEventId: req.headers["last-event-id"] || req.query.lastEventId || null,
    });
    if (!client) {
      res.write(`event: full\ndata: {"reason":"too many open screens"}\n\n`);
      return res.end();
    }
    req.on("close", () => pharmacyHub.removeClient(client));
  } catch (e) {
    handleError(res, e, "Pharmacy live events");
  }
});

export default router;
