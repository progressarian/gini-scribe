export function errorText(e, fallback) {
  const message = e?.response?.data?.error || e?.message || "";
  if (
    !message ||
    /^Request failed with status code/i.test(message) ||
    /Network Error/i.test(message)
  ) {
    return `${fallback} Please try again. If the problem continues, contact an administrator.`;
  }
  return message;
}
