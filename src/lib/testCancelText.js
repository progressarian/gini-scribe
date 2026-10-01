export const TOAST_MS = 3500;
export const REFUND_TOAST_MS = 8000;

export const cancelledText = (text, result) =>
  [text, ...(result?.refunds || []).map((refund) => refund.message)].join(". ");

export const cancelledToastMs = (result) => (result?.refunds?.length ? REFUND_TOAST_MS : TOAST_MS);
