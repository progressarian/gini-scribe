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
