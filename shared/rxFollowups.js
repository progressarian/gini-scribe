export const RX_FOLLOWUP_RESOLVES = ["sent_whatsapp", "collected", "not_needed"];

export const RX_FOLLOWUP_ACTIONS = ["not_taken", "note", ...RX_FOLLOWUP_RESOLVES];

export const RX_FOLLOWUP_LABEL = {
  not_taken: "Not taken",
  note: "Remark",
  sent_whatsapp: "Sent on WhatsApp",
  collected: "Collected in person",
  not_needed: "No need",
};

export const RX_NOT_TAKEN_REASON_LABEL = {
  not_explained: "Not explained",
  not_taken: "Not taken",
};
