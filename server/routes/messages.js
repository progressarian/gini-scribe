import { Router } from "express";
import { createRequire } from "module";
import { handleError } from "../utils/errorHandler.js";
import { validate } from "../middleware/validate.js";
import { messageCreateSchema } from "../schemas/index.js";

const require = createRequire(import.meta.url);
let getMessagesFromGenie = null;
let sendReplyToGenie = null;
let getThreadFromGenie = null;
let markMessageReadInGenie = null;
try {
  const genie = require("../genie-sync.cjs");
  getMessagesFromGenie = genie.getMessagesFromGenie;
  sendReplyToGenie = genie.sendReplyToGenie;
  getThreadFromGenie = genie.getThreadFromGenie;
  markMessageReadInGenie = genie.markMessageReadInGenie;
} catch {
  console.log("genie-sync.cjs not loaded — message sync disabled");
}

const router = Router();

// Inbox — latest message per patient from Supabase, unread first.
// Optional ?role=lab|reception filters to role-scoped inboxes.
router.get("/messages/from-genie", async (req, res) => {
  try {
    if (!getMessagesFromGenie) return res.json({ data: [], total: 0 });
    const role = req.query.role || null;
    const messages = await getMessagesFromGenie(null, role);
    const grouped = {};
    for (const m of messages) {
      if (!grouped[m.patient_id]) grouped[m.patient_id] = [];
      grouped[m.patient_id].push(m);
    }
    const inbox = Object.entries(grouped).map(([pid, msgs]) => {
      const latest = msgs[0];
      const unread = msgs.filter((m) => !m.is_read).length;
      return {
        ...latest,
        patient_id: pid,
        patient_name: latest.sender_name || "Patient",
        unread_count: unread,
        direction: "outbound",
      };
    });
    inbox.sort((a, b) => {
      if (a.unread_count > 0 && b.unread_count === 0) return -1;
      if (a.unread_count === 0 && b.unread_count > 0) return 1;
      return new Date(b.created_at) - new Date(a.created_at);
    });
    res.json({ data: inbox, total: inbox.length });
  } catch (e) {
    handleError(res, e, "Messages inbox");
  }
});

// Backward-compatible inbox endpoint
router.get("/messages/inbox", async (req, res) => {
  try {
    if (!getMessagesFromGenie) return res.json({ data: [], total: 0, page: 1, totalPages: 1 });
    const messages = await getMessagesFromGenie(null);
    const grouped = {};
    for (const m of messages) {
      if (!grouped[m.patient_id]) grouped[m.patient_id] = [];
      grouped[m.patient_id].push(m);
    }
    const inbox = Object.entries(grouped).map(([pid, msgs]) => {
      const latest = msgs[0];
      const unread = msgs.filter((m) => !m.is_read).length;
      return {
        ...latest,
        patient_id: pid,
        patient_name: latest.sender_name || "Patient",
        unread_count: unread,
        direction: "outbound",
      };
    });
    inbox.sort((a, b) => {
      if (a.unread_count > 0 && b.unread_count === 0) return -1;
      if (a.unread_count === 0 && b.unread_count > 0) return 1;
      return new Date(b.created_at) - new Date(a.created_at);
    });
    res.json({ data: inbox, total: inbox.length, page: 1, totalPages: 1 });
  } catch (e) {
    handleError(res, e, "Inbox");
  }
});

// Unread count from Supabase
router.get("/messages/unread-count", async (req, res) => {
  try {
    if (!getMessagesFromGenie) return res.json({ count: 0 });
    const messages = await getMessagesFromGenie(null);
    const count = messages.filter((m) => !m.is_read).length;
    res.json({ count });
  } catch (e) {
    handleError(res, e, "Unread count");
  }
});

// Mark message as read in Supabase
router.put("/messages/:id/read", async (req, res) => {
  try {
    if (!markMessageReadInGenie) return res.json({ success: false });
    const success = await markMessageReadInGenie(req.params.id);
    res.json({ success });
  } catch (e) {
    handleError(res, e, "Mark read");
  }
});

// Full conversation thread for a patient (both directions from Supabase)
router.get("/patients/:id/messages", async (req, res) => {
  try {
    if (!getThreadFromGenie) return res.json([]);
    const data = await getThreadFromGenie(req.params.id);
    res.json(data);
  } catch (e) {
    handleError(res, e, "Messages thread");
  }
});

// Doctor / Lab / Reception sends a reply — writes to Supabase patient_messages
router.post("/patients/:id/messages", validate(messageCreateSchema), async (req, res) => {
  try {
    const { message, sender_name, sender_role } = req.body;
    if (!sendReplyToGenie) return res.status(400).json({ error: "Genie sync not configured" });
    const patientId = req.params.id;
    const doctorName = sender_name || "Dr. Bhansali";
    const reply = await sendReplyToGenie(patientId, message, doctorName, sender_role || null);
    if (!reply) return res.status(500).json({ error: "Failed to send reply" });
    res.json(reply);
  } catch (e) {
    handleError(res, e, "Send message");
  }
});

export default router;
