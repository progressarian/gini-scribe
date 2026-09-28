import { createPortal } from "react-dom";

export default function BillDialogLayer({ children }) {
  return createPortal(
    <div className="flow-root fset bill-ui bill-dialog-layer">{children}</div>,
    document.body,
  );
}
