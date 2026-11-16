import { Router } from "express";
import { handleError } from "../utils/errorHandler.js";
import { ghmHub } from "../services/ghmLive.js";

const router = Router();

router.get("/ghm-live/events", (req, res) => {
  try {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });
    const client = ghmHub.addClient(res, {
      lastEventId: req.headers["last-event-id"] || req.query.lastEventId || null,
    });
    if (!client) {
      res.write(`event: full\ndata: {"reason":"too many open screens"}\n\n`);
      return res.end();
    }
    req.on("close", () => ghmHub.removeClient(client));
  } catch (e) {
    handleError(res, e, "GHM live events");
  }
});

router.get("/ghm-live/status", (_req, res) => res.json(ghmHub.hubStatus()));

export default router;
