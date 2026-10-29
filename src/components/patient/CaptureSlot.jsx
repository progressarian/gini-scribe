import { useEffect, useRef, useState } from "react";
import { isHeic } from "../../services/extraction.js";

const MAX_PDF_BYTES = 3 * 1024 * 1024;
const MAX_EDGE = 1600;

const toJpeg = (source, width, height) => {
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
};

async function prepareFile(file) {
  if (file.type === "application/pdf") {
    if (file.size > MAX_PDF_BYTES) throw new Error("The PDF is larger than 3 MB.");
    return { blob: file, name: file.name, mediaType: "application/pdf" };
  }
  if (isHeic(file)) {
    throw new Error("iPhone HEIC photos aren't supported. Use the camera button or a JPG.");
  }
  if (!file.type.startsWith("image/")) throw new Error("Choose an image or a PDF.");
  const bitmap = await createImageBitmap(file);
  const blob = await toJpeg(bitmap, bitmap.width, bitmap.height);
  bitmap.close?.();
  return { blob, name: file.name.replace(/\.[^.]+$/, "") + ".jpg", mediaType: "image/jpeg" };
}

export const toCapture = async (file) => {
  const prepared = await prepareFile(file);
  return {
    ...prepared,
    previewUrl: URL.createObjectURL(prepared.blob),
  };
};

const isPdf = (item) => item?.mediaType === "application/pdf";

function PreviewDialog({ item, title, onClose }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className="capslot__overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div className="capslot__dialog capslot__dialog--view" onClick={(e) => e.stopPropagation()}>
        <div className="capslot__dialog-title">{title}</div>
        <span className="capslot__name" title={item.name}>
          {item.name}
        </span>
        {isPdf(item) ? (
          <iframe src={item.previewUrl} title={title} className="capslot__viewer" />
        ) : (
          <img src={item.previewUrl} alt={title} className="capslot__full" />
        )}
        <div className="capslot__dialog-actions">
          <button
            type="button"
            className="capslot__btn capslot__btn--primary"
            onClick={onClose}
            autoFocus
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function CameraDialog({ facing, title, onTake, onClose }) {
  const videoRef = useRef(null);
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    let stream = null;
    let cancelled = false;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: { ideal: facing } }, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        videoRef.current.srcObject = s;
        videoRef.current.play().catch(() => {});
        setReady(true);
      })
      .catch(() =>
        setError("The camera could not be opened. Allow camera access or upload a file."),
      );
    if (!navigator.mediaDevices?.getUserMedia) setError("This device has no camera access.");
    const onKey = (e) => e.key === "Escape" && closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
      window.removeEventListener("keydown", onKey);
    };
  }, [facing]);

  const take = async () => {
    const v = videoRef.current;
    if (!v?.videoWidth) return;
    const blob = await toJpeg(v, v.videoWidth, v.videoHeight);
    if (blob) onTake(new File([blob], "camera.jpg", { type: "image/jpeg" }));
  };

  return (
    <div className="capslot__overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="capslot__dialog">
        <div className="capslot__dialog-title">{title}</div>
        {error ? (
          <p className="capslot__err">{error}</p>
        ) : (
          <video ref={videoRef} className="capslot__video" playsInline muted />
        )}
        <div className="capslot__dialog-actions">
          <button type="button" className="capslot__btn" onClick={onClose}>
            Cancel
          </button>
          {!error && (
            <button
              type="button"
              className="capslot__btn capslot__btn--primary"
              onClick={take}
              disabled={!ready}
              autoFocus
            >
              Capture
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function CaptureSlot({ label, required, value, onChange, facing, error, hint }) {
  const inputRef = useRef(null);
  const [camera, setCamera] = useState(false);
  const [problem, setProblem] = useState(null);
  const [viewing, setViewing] = useState(false);

  const accept = async (file) => {
    if (!file) return;
    setProblem(null);
    try {
      onChange(await toCapture(file));
    } catch (e) {
      setProblem(e.message);
    }
  };

  const clear = () => {
    if (value?.previewUrl) URL.revokeObjectURL(value.previewUrl);
    onChange(null);
  };

  const shown = problem || error;

  return (
    <div className={`capslot ${shown ? "capslot--error" : ""}`}>
      <span className="capslot__label">
        {label}
        {required ? " *" : " (optional)"}
      </span>
      {value ? (
        <div className="capslot__picked">
          <button
            type="button"
            className="capslot__view"
            onClick={() => setViewing(true)}
            aria-label={`View ${label}`}
            title="Click to view"
          >
            {isPdf(value) ? (
              <span className="capslot__pdf">PDF</span>
            ) : (
              <img src={value.previewUrl} alt="" className="capslot__thumb" />
            )}
          </button>
          <span className="capslot__name" title={value.name}>
            {value.name}
          </span>
          <button type="button" className="capslot__link" onClick={() => setViewing(true)}>
            View
          </button>
          <button type="button" className="capslot__link" onClick={clear}>
            Remove
          </button>
        </div>
      ) : (
        <div className="capslot__actions">
          <button type="button" className="capslot__btn" onClick={() => setCamera(true)}>
            Take photo
          </button>
          <button type="button" className="capslot__btn" onClick={() => inputRef.current?.click()}>
            Upload file
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/*,application/pdf"
            hidden
            onChange={(e) => {
              accept(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
      )}
      {hint && !shown && <span className="capslot__hint">{hint}</span>}
      {shown && (
        <span className="capslot__err" role="alert">
          {shown}
        </span>
      )}
      {viewing && value && (
        <PreviewDialog item={value} title={label} onClose={() => setViewing(false)} />
      )}
      {camera && (
        <CameraDialog
          facing={facing}
          title={label}
          onClose={() => setCamera(false)}
          onTake={(file) => {
            setCamera(false);
            accept(file);
          }}
        />
      )}
    </div>
  );
}
