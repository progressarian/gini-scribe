import { useEffect } from "react";

const EVENT = "gini:bill-paid";

export const announcePaid = (billId) =>
  window.dispatchEvent(new CustomEvent(EVENT, { detail: billId }));

export function useOnPaid(billId, onPaid) {
  useEffect(() => {
    const listen = (event) => {
      if (event.detail === billId) onPaid();
    };
    window.addEventListener(EVENT, listen);
    return () => window.removeEventListener(EVENT, listen);
  }, [billId, onPaid]);
}
