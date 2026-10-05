import { useState } from "react";
import { createPortal } from "react-dom";
import PdfViewerModal from "../../visit/PdfViewerModal";
import { API_URL } from "../../../services/api";

const sameOrigin = (href) => (href.startsWith(API_URL) ? href.slice(API_URL.length) : href);

export default function PdfViewer({ pdf, onClose }) {
  if (!pdf) return null;
  return createPortal(
    <PdfViewerModal
      src={{
        url: sameOrigin(pdf.href),
        mimeType: pdf.mimeType || "application/pdf",
        fileName: pdf.fileName,
        title: pdf.title,
      }}
      printable
      onClose={onClose}
    />,
    document.body,
  );
}

export function PdfButton({ href, title, fileName, mimeType, children, ...button }) {
  const [pdf, setPdf] = useState(null);
  return (
    <>
      <button type="button" {...button} onClick={() => setPdf({ href, title, fileName, mimeType })}>
        {children}
      </button>
      <PdfViewer pdf={pdf} onClose={() => setPdf(null)} />
    </>
  );
}
