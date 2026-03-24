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

  fetchInbox: async () => {
    set({ inboxLoading: true });
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
    set({ inboxLoading: false });
  },

  fetchThread: async (patientId) => {
    set({ threadLoading: true });
    try {
      const { data } = await api.get(`/api/patients/${patientId}/messages`);
      set({ threadMessages: data });
    } catch (e) {
      console.warn("Failed to load conversation:", e.message);
    }
    set({ threadLoading: false });
  },

  sendReply: async () => {
    const { replyText, activeThread } = get();
    if (!replyText.trim() || !activeThread) return;
    set({ sendingReply: true });
    try {
      await api.post(`/api/patients/${activeThread.patient_id}/messages`, {
        message: replyText,
        sender_name: "Dr. Bhansali",
      });
      set({ replyText: "" });
      get().fetchThread(activeThread.patient_id);
      get().fetchInbox();
    } catch (e) {
      console.warn("Failed to send reply:", e.message);
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
