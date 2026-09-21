export const rupees = (n) => {
  const amount = Number(n || 0);
  const paise = Number.isInteger(amount) ? 0 : 2;
  return `₹${amount.toLocaleString("en-IN", { minimumFractionDigits: paise, maximumFractionDigits: 2 })}`;
};

export const moneyTyped = (value) => {
  const [whole, ...rest] = value.replace(/[^\d.]/g, "").split(".");
  return rest.length ? `${whole}.${rest.join("").slice(0, 2)}` : whole;
};

export const digitsTyped = (value) => value.replace(/\D/g, "");

export const codeTyped = (value) => value.replace(/\s/g, "");

export const categoryCodeTyped = (value) => value.toLowerCase().replace(/[^a-z0-9_]/g, "");

export const errorOf = (e, fallback = "Something went wrong") =>
  e?.response?.data?.error || fallback;

export const usesOf = (e) => (e?.response?.status === 409 ? e.response.data?.uses : null) || null;
