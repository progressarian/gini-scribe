import { useEffect } from "react";
import { Printer } from "lucide-react";
import useDialog from "../useDialog";
import BillDialogLayer from "../BillDialogLayer";
import HandoverSlip from "./HandoverSlip";
import "../../../pages/billing/shiftSlip.css";

export default function SlipDialog({ data, open, onClose }) {
  const ref = useDialog(open, onClose);
  useEffect(() => {
    if (!open) return undefined;
    document.body.classList.add("slip-printing");
    return () => document.body.classList.remove("slip-printing");
  }, [open]);
  if (!open) return null;
  return (
    <BillDialogLayer>
      <div className="flow-dialog-backdrop" onClick={onClose} role="presentation">
        <div
          ref={ref}
          className="flow-card bill-dialog slip-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="slip-dialog-title"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="bill-dialog__head">
            <h2 id="slip-dialog-title" className="bill-dialog__title">
              Handover slip
            </h2>
            <div className="slip-dialog__actions">
              <button
                type="button"
                className="flow-btn flow-btn-mini"
                onClick={() => window.print()}
              >
                <Printer size={13} aria-hidden="true" /> Print
              </button>
              <button
                type="button"
                className="flow-btn flow-btn-ghost flow-btn-mini"
                onClick={onClose}
              >
                Close
              </button>
            </div>
          </div>
          <HandoverSlip data={data} level={3} />
        </div>
      </div>
    </BillDialogLayer>
  );
}
