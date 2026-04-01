import { create } from "zustand";
import { callClaude } from "../services/api.js";
import { VITALS_VOICE_PROMPT } from "../config/prompts.js";
import useUiStore from "./uiStore.js";

const EMPTY_VITALS = {
  bp_sys: "",
  bp_dia: "",
  pulse: "",
  temp: "",
  spo2: "",
  weight: "",
  height: "",
  bmi: "",
  waist: "",
  body_fat: "",
  muscle_mass: "",
};

const useVitalsStore = create((set, get) => ({
  // ── state ──
  vitals: { ...EMPTY_VITALS },

  // ── simple setter ──
  setVitals: (valOrFn) => {
    if (typeof valOrFn === "function") {
      set((state) => ({ vitals: valOrFn(state.vitals) }));
    } else {
      set({ vitals: valOrFn });
    }
  },

  // ── updateVital: includes BMI auto-calc ──
  updateVital: (k, v) => {
    set((state) => {
      const u = { ...state.vitals, [k]: v };
      if ((k === "weight" || k === "height") && u.weight && u.height) {
        const h = parseFloat(u.height) / 100;
        u.bmi = h > 0 ? (parseFloat(u.weight) / (h * h)).toFixed(1) : "";
      }
      return { vitals: u };
    });
  },

  // ── voiceFillVitals ──
  voiceFillVitals: async (transcript) => {
    // Uses uiStore for loading/errors

    useUiStore.getState().setLoading((p) => ({ ...p, vv: true }));
    useUiStore.getState().clearErr("vv");
    const { data, error } = await callClaude(VITALS_VOICE_PROMPT, transcript);
    if (error) useUiStore.getState().setErrors((p) => ({ ...p, vv: error }));
    else if (data) {
      set((state) => {
        const u = { ...state.vitals };
        if (data.bp_sys) u.bp_sys = String(data.bp_sys);
        if (data.bp_dia) u.bp_dia = String(data.bp_dia);
        if (data.pulse) u.pulse = String(data.pulse);
        if (data.temp) u.temp = String(data.temp);
        if (data.spo2) u.spo2 = String(data.spo2);
        if (data.weight) u.weight = String(data.weight);
        if (data.height) u.height = String(data.height);
        if (u.weight && u.height) {
          const h = parseFloat(u.height) / 100;
          u.bmi = h > 0 ? (parseFloat(u.weight) / (h * h)).toFixed(1) : "";
        }
        return { vitals: u };
      });
    }
    useUiStore.getState().setLoading((p) => ({ ...p, vv: false }));
  },

  // ── resetVitals ──
  resetVitals: () => set({ vitals: { ...EMPTY_VITALS } }),
}));

export default useVitalsStore;
