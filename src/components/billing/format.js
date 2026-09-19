export const rupees = (n) => {
  const amount = Number(n || 0);
  const paise = Number.isInteger(amount) ? 0 : 2;
  return `₹${amount.toLocaleString("en-IN", { minimumFractionDigits: paise, maximumFractionDigits: 2 })}`;
};

export const errorOf = (e, fallback = "Something went wrong") =>
  e?.response?.data?.error || fallback;

export const usesOf = (e) => (e?.response?.status === 409 ? e.response.data?.uses : null) || null;
