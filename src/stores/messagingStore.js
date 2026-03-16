import { create } from "zustand";
import api from "../services/api.js";

const useMessagingStore = create((set, get) => ({
  // ── state ──
  unreadCount: 0,
  inbox: [],
  inboxLoading: false,
  inboxPage: 1,
  inboxTotalPages: 1,
  inboxLoadingMore: false,
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
        api.get("/api/messages/inbox?page=1&limit=30"),
        api.get("/api/messages/unread-count"),
      ]);
      const res = inboxResp.data;
      set({
        inbox: res.data || res,
        inboxPage: res.page || 1,
        inboxTotalPages: res.totalPages || 1,
        unreadCount: countResp.data.count || 0,
      });
    } catch (e) {
      console.warn("Failed to load messages");
    }
    set({ inboxLoading: false });
  },

  loadMoreInbox: async () => {
    const { inboxPage, inboxTotalPages } = get();
    if (inboxPage >= inboxTotalPages) return;
    const nextPage = inboxPage + 1;
    set({ inboxLoadingMore: true });
    try {
      const { data: res } = await api.get(`/api/messages/inbox?page=${nextPage}&limit=30`);
      set((s) => ({
        inbox: [...s.inbox, ...(res.data || [])],
        inboxPage: res.page || nextPage,
        inboxTotalPages: res.totalPages || s.inboxTotalPages,
      }));
    } catch (e) {
      console.warn("Failed to load more messages");
    }
    set({ inboxLoadingMore: false });
  },

  fetchThread: async (patientId) => {
    set({ threadLoading: true });
    try {
      const { data } = await api.get(`/api/patients/${patientId}/messages`);
      set({ threadMessages: data });
    } catch (e) {
      console.warn("Failed to load conversation");
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
        direction: "doctor_to_patient",
        sender_name: "Dr. Bhansali",
      });
      set({ replyText: "" });
      get().fetchThread(activeThread.patient_id);
      get().fetchInbox();
    } catch (e) {
      console.warn("Failed to send reply");
    }
    set({ sendingReply: false });
  },

  markRead: async (msgId) => {
    try {
      await api.put(`/api/messages/${msgId}/read`);
      get().fetchInbox();
    } catch (e) {
      console.warn("Failed to mark message as read");
    }
  },
}));

export default useMessagingStore;
