import { create } from "zustand";
import { aiChat } from "../services/chat.js";

const useChatStore = create((set, get) => ({
  // ── state ──
  aiMessages: [],
  aiInput: "",
  aiLoading: false,

  // ── simple setters ──
  setAiMessages: (val) =>
    set(
      typeof val === "function"
        ? (state) => ({ aiMessages: val(state.aiMessages) })
        : { aiMessages: val },
    ),
  setAiInput: (val) => set({ aiInput: val }),
  setAiLoading: (val) => set({ aiLoading: val }),

  // ── actions ──

  sendAiMessage: async (patientContext) => {
    const { aiInput, aiLoading, aiMessages } = get();
    if (!aiInput.trim() || aiLoading) return;
    const userMsg = aiInput.trim();
    set({ aiInput: "" });
    const newMessages = [...aiMessages, { role: "user", content: userMsg }];
    set({ aiMessages: newMessages, aiLoading: true });
    const apiMessages = newMessages.map((m) => ({ role: m.role, content: m.content }));
    const { text, error } = await aiChat(apiMessages, patientContext || "");
    if (error)
      set((state) => ({
        aiMessages: [...state.aiMessages, { role: "assistant", content: `Error: ${error}` }],
      }));
    else
      set((state) => ({ aiMessages: [...state.aiMessages, { role: "assistant", content: text }] }));
    set({ aiLoading: false });
  },

  resetChat: () => set({ aiMessages: [], aiInput: "", aiLoading: false }),
}));

export default useChatStore;
