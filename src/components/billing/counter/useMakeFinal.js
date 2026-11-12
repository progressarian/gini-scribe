import { useState } from "react";
import {
  billPdfHref,
  useFinaliseBill,
  usePayAndFinalise,
  useRereadBill,
} from "../../../queries/hooks/useBilling";
import { errorOf } from "../format";

export function useMakeFinal({ onBill, onPricesChanged, form }) {
  const finalise = useFinaliseBill();
  const payAndFinalise = usePayAndFinalise();
  const reread = useRereadBill();
  const [error, setError] = useState(null);
  const [printing, setPrinting] = useState(null);

  const makeFinal = async (
    bill,
    { payLater = false, showIfRefused = null, payments = null } = {},
  ) => {
    setError(null);
    try {
      const request = {
        billId: bill.id,
        visitId: bill.visit_id,
        version: bill.version,
        ...(payLater ? { pay_later: true } : {}),
      };
      const made = payments
        ? await payAndFinalise.mutateAsync({ ...request, payments })
        : await finalise.mutateAsync(request);
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
    isPending: finalise.isPending || payAndFinalise.isPending,
    printing,
    closePrinting: () => setPrinting(null),
  };
}
