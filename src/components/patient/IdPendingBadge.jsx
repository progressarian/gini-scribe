import { useEffect, useState } from "react";
import api from "../../services/api.js";
import CaptureSlot from "./CaptureSlot.jsx";
import { FILE_LABELS, uploadRegistrationFiles } from "./RegistrationIdentityFields.jsx";

function AddIdScanDialog({ patientId, name, fileNo, onClose, onSaved }) {
  const [kind, setKind] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [item, setItem] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api
      .get(`/api/registration-documents/${patientId}`)
      .then(({ data }) => setKind(data.required_scan || "id_proof"))
      .catch(() => setLoadErr("Could not load this patient's ID details. Try again."));
  }, [patientId]);

  const save = async () => {
    setSaving(true);
    setErr(null);
    const { failed } = await uploadRegistrationFiles(patientId, { [kind]: item });
    setSaving(false);
    if (failed.length) return setErr(`The ${FILE_LABELS[kind]} could not be saved. Try again.`);
    onSaved();
  };

  return (
    <div className="capslot__overlay" role="dialog" aria-modal="true" aria-label="Add ID scan">
      <div className="capslot__dialog">
        <div className="capslot__dialog-title">Add ID scan</div>
        <div className="capslot__hint">
          <b>{name}</b>
          {fileNo ? ` · ${fileNo}` : ""}
        </div>
        {loadErr && <p className="capslot__err">{loadErr}</p>}
        {!kind && !loadErr && <p className="capslot__hint">Loading…</p>}
        {kind && (
          <CaptureSlot
            label={FILE_LABELS[kind]}
            required
            facing="environment"
            value={item}
            onChange={setItem}
            error={err}
          />
        )}
        <div className="capslot__dialog-actions">
          <button type="button" className="capslot__btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="capslot__btn capslot__btn--primary"
            onClick={save}
            disabled={!item || saving}
          >
            {saving ? "Saving…" : "Save scan"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function IdPendingBadge({ patientId, name, fileNo, onSaved }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="badge b-amb"
        title="ID or card scan not collected yet"
        onClick={() => setOpen(true)}
      >
        🪪 ID pending · Add scan
      </button>
      {open && (
        <AddIdScanDialog
          patientId={patientId}
          name={name}
          fileNo={fileNo}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            onSaved?.();
          }}
        />
      )}
    </>
  );
}
