import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileSpreadsheet } from "lucide-react";
import SheetImportDialog from "./SheetImportDialog";

export default function SheetImportButton({
  label,
  invalidate = [],
  icon = true,
  disabled = false,
  describedBy,
  ...dialog
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="flow-btn flow-btn-ghost phs-upload"
        disabled={disabled}
        aria-describedby={describedBy}
        onClick={() => setOpen(true)}
      >
        {icon ? <FileSpreadsheet size={15} aria-hidden="true" /> : null}
        {label}
      </button>
      {open ? (
        <SheetImportDialog
          {...dialog}
          onImported={(result) => {
            for (const queryKey of invalidate) queryClient.invalidateQueries({ queryKey });
            dialog.onImported?.(result);
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
