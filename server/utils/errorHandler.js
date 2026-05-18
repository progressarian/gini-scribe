// Log full error server-side, return the real message to the client so the
// UI can show something more useful than "Internal server error". Honors
// `e.status` (or `e.statusCode`) when the caller throws a typed error.
export function handleError(res, e, context = "Request") {
  console.error(`${context} error:`, e?.message, e?.detail || "", e?.stack || "");

  const status = Number.isInteger(e?.status)
    ? e.status
    : Number.isInteger(e?.statusCode)
      ? e.statusCode
      : 500;

  const message =
    (typeof e?.message === "string" && e.message.trim()) ||
    (typeof e?.detail === "string" && e.detail.trim()) ||
    `${context} failed`;

  res.status(status).json({
    error: message,
    code: e?.code || undefined,
    context,
  });
}
