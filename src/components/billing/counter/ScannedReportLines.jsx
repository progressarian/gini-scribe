import { useRef, useState } from "react";
import {
  scannedReportHref,
  useDeleteScannedReport,
  useScanBillReport,
  useScannedBillLines,
} from "../../../queries/hooks/useBilling";
import ConfirmModal from "../../ui/ConfirmModal";
import { errorOf } from "../format";
import { readFile } from "./PatientHeader";
import { PdfButton } from "./PdfViewer";
import SuggestedBillLines from "./SuggestedBillLines";

const ACCEPTED = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 5 * 1024 * 1024;

const scannedAt = (iso) =>
  new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  });

export default function ScannedReportLines({ bill, onBill }) {
  const draft = bill.status === "draft" && Boolean(bill.visit_id);
  const { data, isLoading } = useScannedBillLines(bill.id, bill.version, { enabled: draft });
  const scan = useScanBillReport();
  const removeReport = useDeleteScannedReport();
  const fileRef = useRef(null);
  const cancelRef = useRef(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [asking, setAsking] = useState(null);
  const [deleteError, setDeleteError] = useState(null);

  if (!draft) return null;
  const reports = data?.reports || [];
  const lines = data?.lines || [];
  const notMatched = data?.not_matched || [];

  const upload = async (file) => {
    setError(null);
    setNote(null);
    if (!ACCEPTED.includes(file.type)) {
      setError("Upload the bill as a PDF or a photo (JPG, PNG or WebP).");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("The report is larger than 5 MB — upload a smaller PDF or photo.");
      return;
    }
    const controller = new AbortController();
    cancelRef.current = controller;
    try {
      await scan.mutateAsync({
        billId: bill.id,
        version: bill.version,
        base64: await readFile(file),
        mediaType: file.type,
        fileName: file.name,
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) setNote("Scan cancelled — nothing was saved.");
      else setError(errorOf(e, "The report couldn't be scanned"));
    } finally {
      cancelRef.current = null;
    }
  };

  const confirmDelete = async () => {
    setDeleteError(null);
    try {
      await removeReport.mutateAsync({ documentId: asking.id, billId: bill.id });
      setNote(`${asking.file_name} was deleted.`);
      setAsking(null);
    } catch (e) {
      setDeleteError(errorOf(e, "The report couldn't be deleted"));
    }
  };

  return (
    <section className="bc-card" aria-label="Scanned billing reports">
      <h3 className="bc-card__title">
        Scanned billing reports
        {reports.length > 0 && (
          <span className="grp-split">{lines.length + notMatched.length}</span>
        )}
      </h3>
      <div className="bc-hint">
        Upload a bill PDF or photo to read its items. Check each item before adding — a scan can
        misread names or amounts.
      </div>
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPTED.join(",")}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) upload(file);
        }}
      />
      <button
        type="button"
        className="st-btn st-btn-blu"
        disabled={scan.isPending}
        onClick={() => fileRef.current?.click()}
      >
        {scan.isPending ? "Scanning report…" : "Upload billing report"}
      </button>
      {scan.isPending && (
        <button
          type="button"
          className="st-btn st-btn-g"
          onClick={() => cancelRef.current?.abort()}
        >
          Cancel scan
        </button>
      )}
      {scan.isPending && (
        <div className="bc-hint" role="status">
          Reading the report — this can take up to a minute.
        </div>
      )}
      {isLoading && (
        <div className="bc-hint" role="status">
          Loading scanned reports…
        </div>
      )}
      {note && (
        <div className="bc-hint" role="status">
          {note}
        </div>
      )}
      {error && (
        <div className="bc-err" role="alert">
          {error}
        </div>
      )}
      {reports.length > 0 && (
        <ul className="bc-labcase">
          {reports.map((report) => (
            <li key={report.id} className="bc-labcase__row">
              <span className="bc-labcase__name">
                {report.bill_no ? `Bill ${report.bill_no}` : report.file_name}
                <span className="bc-labcase__service">
                  {report.file_name} · scanned {scannedAt(report.scanned_at)}
                </span>
                {report.warning && (
                  <span className="bc-err" role="alert">
                    {report.warning}
                  </span>
                )}
              </span>
              <PdfButton
                className="st-btn st-btn-g"
                href={scannedReportHref(report.id)}
                title={report.bill_no ? `Billing report ${report.bill_no}` : "Billing report"}
                fileName={report.file_name}
                mimeType={report.mime_type}
                aria-label={`View ${report.file_name}`}
              >
                View
              </PdfButton>
              <button
                type="button"
                className="st-btn st-btn-red"
                aria-label={`Delete ${report.file_name}`}
                disabled={removeReport.isPending}
                onClick={() => {
                  setDeleteError(null);
                  setAsking(report);
                }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      {lines.length + notMatched.length > 0 ? (
        <SuggestedBillLines
          bill={bill}
          onBill={onBill}
          lines={lines}
          notMatched={notMatched}
          source="Report"
        />
      ) : (
        reports.length > 0 && (
          <div className="bc-hint">Everything on the scanned reports is already on this bill.</div>
        )
      )}
      <ConfirmModal
        open={Boolean(asking)}
        title="Delete this scanned report?"
        message={
          asking &&
          `${asking.file_name}${asking.bill_no ? ` (bill ${asking.bill_no})` : ""} will be removed from the patient's documents and its items will no longer be suggested. Anything already added to this bill stays on it.`
        }
        confirmLabel={removeReport.isPending ? "Deleting…" : "Delete report"}
        busy={removeReport.isPending}
        error={deleteError}
        onConfirm={confirmDelete}
        onCancel={() => {
          if (!removeReport.isPending) setAsking(null);
        }}
      />
    </section>
  );
}
