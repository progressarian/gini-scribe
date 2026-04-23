import { create } from "zustand";
import api from "../services/api.js";

const useMessagingStore = create((set, get) => ({
  // ── state ──
  unreadCount: 0,
  inbox: [],
  inboxLoading: false,
  activeThread: null,
  threadMessages: [],
  threadLoading: false,
  replyText: "",
  sendingReply: false,

  // ── simple setters ──
  setUnreadCount: (val) => set({ unreadCount: val }),
  setInbox: (val) => set({ inbox: val }),
  setActiveThread: (val) => set({ activeThread: val }),
  setThreadMessages: (val) => set({ threadMessages: val }),
  setReplyText: (val) => set({ replyText: val }),
  setSendingReply: (val) => set({ sendingReply: val }),

  // ── actions ──

  fetchInbox: async ({ silent = false } = {}) => {
    if (!silent) set({ inboxLoading: true });
    try {
      const [inboxResp, countResp] = await Promise.all([
        api.get("/api/messages/from-genie"),
        api.get("/api/messages/unread-count"),
      ]);
      const res = inboxResp.data;
      set({
        inbox: res.data || res,
        unreadCount: countResp.data.count || 0,
      });
    } catch (e) {
      console.warn("Failed to load messages:", e.message);
    }
    if (!silent) set({ inboxLoading: false });
  },

  fetchThread: async (patientId, { silent = false } = {}) => {
    if (!silent) set({ threadLoading: true });
    try {
      const { data } = await api.get(`/api/patients/${patientId}/messages`);
      set({ threadMessages: data });
    } catch (e) {
      console.warn("Failed to load conversation:", e.message);
    }
    if (!silent) set({ threadLoading: false });
  },

  sendReply: async () => {
    const { replyText, activeThread, threadMessages } = get();
    const text = replyText.trim();
    if (!text || !activeThread) return;
    set({ sendingReply: true });
    // Optimistic append so the bubble appears instantly — no flashing reload.
    const optimistic = {
      id: `tmp-${Date.now()}`,
      patient_id: activeThread.patient_id,
      message: text,
      direction: "inbound",
      sender_name: "Dr. Bhansali",
      created_at: new Date().toISOString(),
      is_read: true,
      _optimistic: true,
    };
    set({ threadMessages: [...threadMessages, optimistic], replyText: "" });
    try {
      await api.post(`/api/patients/${activeThread.patient_id}/messages`, {
        message: text,
        sender_name: "Dr. Bhansali",
      });
      // Silent refetch — no shimmer flash.
      get().fetchThread(activeThread.patient_id, { silent: true });
      get().fetchInbox();
    } catch (e) {
      console.warn("Failed to send reply:", e.message);
      // Roll back optimistic bubble on failure.
      set({
        threadMessages: get().threadMessages.filter((m) => m.id !== optimistic.id),
        replyText: text,
      });
    }
    set({ sendingReply: false });
  },

  markRead: async (msgId) => {
    try {
      await api.put(`/api/messages/${msgId}/read`);
      get().fetchInbox();
    } catch (e) {
      console.warn("Failed to mark message as read:", e.message);
    }
  },
}));

export default useMessagingStore;
