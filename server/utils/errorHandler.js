// Log full error server-side, return safe message to client
export function handleError(res, e, context = "Request") {
  console.error(`${context} error:`, e.message, e.detail || "");
  res.status(500).json({ error: "Internal server error" });
}
