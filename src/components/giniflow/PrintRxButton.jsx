import { useEffect, useRef, useState } from "react";
import { printPdf } from "../visit/PdfViewerModal";
import { fetchPrintableRx } from "../../queries/hooks/useGiniflowRx";
import useAuthStore from "../../stores/authStore";
import { hasCapability, CAPABILITIES } from "../../../shared/permissions";

export default function PrintRxButton({
  visitId,
  patientName,
  label = "🖨 Print Rx",
  className = "st-btn",
  onToast,
}) {
  const role = useAuthStore((st) => st.currentDoctor?.role);
  const [printing, setPrinting] = useState(false);
  const frame = useRef(null);
  const objectUrl = useRef(null);

  useEffect(
    () => () => {
      frame.current?.remove();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  if (!visitId || !hasCapability(role, CAPABILITIES.GINIFLOW_PRINT_RX)) return null;

  const print = async () => {
    if (printing) return;
    setPrinting(true);
    try {
      const blob = await fetchPrintableRx(visitId);
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = URL.createObjectURL(blob);
      frame.current = printPdf(
        objectUrl.current,
        `Prescription — ${patientName || "patient"}`,
        frame.current,
      );
    } catch (e) {
      onToast?.(e?.message || "The prescription could not be opened");
    } finally {
      setPrinting(false);
    }
  };

  return (
    <button
      type="button"
      className={className}
      disabled={printing}
      aria-label={`Print ${patientName || "the patient"}'s prescription`}
      onClick={print}
    >
      {printing ? "🖨 Preparing…" : label}
    </button>
  );
}
