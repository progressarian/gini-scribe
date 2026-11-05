import { useState } from "react";
import { billPdfHref, useFinaliseBill, useRereadBill } from "../../../queries/hooks/useBilling";
import { errorOf } from "../format";

export function useMakeFinal({ onBill, onPricesChanged, form }) {
  const finalise = useFinaliseBill();
  const reread = useRereadBill();
  const [error, setError] = useState(null);
  const [printing, setPrinting] = useState(null);

  const makeFinal = async (bill, { payLater = false, showIfRefused = null } = {}) => {
    setError(null);
    try {
      const made = await finalise.mutateAsync({
        billId: bill.id,
        visitId: bill.visit_id,
        version: bill.version,
        ...(payLater ? { pay_later: true } : {}),
      });
      onBill(made);
      form.clear();
      setPrinting({
        href: billPdfHref(made.id),
        title: `Bill ${made.bill_no}`,
        fileName: `Bill_${made.bill_no}.pdf`,
      });
      return made;
    } catch (e) {
      if (showIfRefused) onBill(showIfRefused);
      if (e?.response?.data?.code === "prices_changed") {
        onPricesChanged();
        return null;
      }
      const version = e?.response?.data?.version;
      setError(
        errorOf(e, "This bill could not be made final") +
          (version ? ` (it is now version ${version})` : ""),
      );
      if (version) {
        try {
          onBill(await reread.mutateAsync({ billId: bill.id }));
        } catch {
          setError("This bill changed and could not be read again — open it again");
        }
      }
      return null;
    }
  };

  return {
    makeFinal,
    error,
    isPending: finalise.isPending,
    printing,
    closePrinting: () => setPrinting(null),
  };
}
