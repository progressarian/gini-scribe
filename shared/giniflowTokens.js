import { CHAIN, TERMINAL_STATUSES } from "./giniflowStatus.js";

export const TOKEN_MIN = 1;
export const TOKEN_MAX = 9999;

const after = (status) => CHAIN.slice(CHAIN.indexOf(status) + 1);

export const TOKEN_STAGES = [
  { key: "not_arrived", label: "Not arrived", statuses: ["booked", "confirmed"] },
  {
    key: "before_chief",
    label: "Before Chief (check-in / vitals)",
    statuses: ["checked_in", "vitals_pending", "with_vitals"],
  },
  { key: "waiting_chief", label: "Waiting for Chief", statuses: ["vitals_done", "sd_pending"] },
  { key: "with_chief", label: "With Chief", statuses: ["with_sd"] },
  {
    key: "past_chief",
    label: "Past Chief",
    statuses: after("with_sd").filter((s) => !TERMINAL_STATUSES.includes(s)),
  },
];

export const TOKEN_ACTIVE_STAGES = ["not_arrived", "before_chief", "waiting_chief", "with_chief"];

export const TOKEN_LOCKED_STATUSES = [...TERMINAL_STATUSES, "no_show", "cancelled", "abandoned"];

export const tokenStageOf = (status) =>
  TOKEN_STAGES.find((s) => s.statuses.includes(status)) ?? null;

export const tokenStatuses = (stageKeys) =>
  TOKEN_STAGES.filter((s) => stageKeys.includes(s.key)).flatMap((s) => s.statuses);
