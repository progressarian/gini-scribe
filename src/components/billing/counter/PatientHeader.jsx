import { useEffect, useMemo, useRef, useState } from "react";
import api from "../../../services/api";
import { usePatientSchemeList, useSetBillCategory } from "../../../queries/hooks/useBilling";
import { errorOf } from "../format";

const readFile = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(String(e.target.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Could not read that file"));
    reader.readAsDataURL(file);
  });

const labelOf = (entry) => entry.category.display_label || entry.category.label;

export default function PatientHeader({ patient, bill, needsCategory, suggestions, onBill }) {
  const { data: schemes } = usePatientSchemeList();
  const setCategory = useSetBillCategory();
  const [chosen, setChosen] = useState(bill.category || "");
  const [cardNo, setCardNo] = useState("");
  const [referralNo, setReferralNo] = useState("");
  const [error, setError] = useState(null);
  const [choices, setChoices] = useState([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    setChosen(bill.category || "");
    setChoices([]);
  }, [bill.id, bill.category]);

  const list = useMemo(() => schemes || [], [schemes]);
  const subsOf = (code) => list.filter((s) => s.parent_code === code);
  const scheme = list.find((s) => s.code === bill.category) || null;
  const parent = scheme ? list.find((s) => s.code === scheme.parent_code) : null;
  const needs = (flag) => Boolean(scheme?.[flag] || parent?.[flag]);
  const needsCard = needs("requires_ref");
  const needsReferral = needs("requires_referral");
  const needsDoc = needs("requires_referral_doc");

  const save = async (body) => {
    setError(null);
    setChoices([]);
    try {
      onBill(await setCategory.mutateAsync({ billId: bill.id, visitId: bill.visit_id, ...body }));
      return true;
    } catch (e) {
      setError(errorOf(e, "That could not be saved"));
      if (e?.response?.data?.needs_sub_category) setChoices(e.response.data.suggestions || []);
      return false;
    }
  };

  const upload = async (file) => {
    setError(null);
    setUploading(true);
    try {
      const base64 = await readFile(file);
      const { data: doc } = await api.post(`/api/patients/${bill.patient_id}/documents`, {
        doc_type: "referral",
        title: `Referral — ${file.name}`,
        file_name: file.name,
        source: "billing_counter",
      });
      await api.post(`/api/documents/${doc.id}/upload-file`, {
        base64,
        mediaType: file.type || "application/pdf",
        fileName: file.name,
      });
      await save({ referral_doc_id: doc.id });
    } catch (e) {
      setError(errorOf(e, "That scan could not be saved"));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const offered = choices.length ? choices : needsCategory ? suggestions || [] : [];

  return (
    <section className="bc-card bc-head" aria-label="Patient">
      <div className="bc-head__top">
        <h2 className="bc-head__name">{patient?.name || "—"}</h2>
        <div className="bc-head__meta">
          {patient?.fileNo || "—"}
          {" · "}
          {bill.patient_age ?? patient?.age ?? "—"}
          {(patient?.sex || "")[0] || ""}
        </div>
        <span className="badge b-ink bc-head__cat">
          {bill.category_label || (needsCategory ? "Category not confirmed" : "General")}
        </span>
        {bill.payer_name && <span className="bc-head__payer">Payer: {bill.payer_name}</span>}
      </div>

      {offered.length > 0 && (
        <div className="bc-head__suggest">
          <span className="bc-head__hint">
            {choices.length
              ? "That category has sub-categories — choose one:"
              : "Suggested from this patient's booking:"}
          </span>
          {offered.map((entry) => (
            <button
              key={entry.category.code}
              type="button"
              className="st-btn st-btn-blu"
              disabled={setCategory.isPending}
              onClick={() => save({ category: entry.category.code })}
            >
              {labelOf(entry)}
            </button>
          ))}
        </div>
      )}

      <form
        className="bc-head__row"
        onSubmit={(e) => {
          e.preventDefault();
          save({ category: chosen });
        }}
      >
        <label className="bc-field">
          <span className="bc-field__lbl">Category</span>
          <select
            className="bc-field__in"
            value={chosen}
            onChange={(e) => setChosen(e.target.value)}
          >
            <option value="">General (no category)</option>
            {list
              .filter((s) => !s.parent_code)
              .map((top) => {
                const subs = subsOf(top.code);
                return subs.length ? (
                  <optgroup key={top.code} label={top.label}>
                    {subs.map((sub) => (
                      <option key={sub.code} value={sub.code}>
                        {sub.label}
                      </option>
                    ))}
                  </optgroup>
                ) : (
                  <option key={top.code} value={top.code}>
                    {top.label}
                  </option>
                );
              })}
          </select>
        </label>
        <button type="submit" className="st-btn st-btn-grn" disabled={setCategory.isPending}>
          Confirm category
        </button>
      </form>

      {(needsCard || needsReferral || needsDoc) && (
        <form
          className="bc-head__row"
          onSubmit={(e) => {
            e.preventDefault();
            save({
              ...(needsCard && cardNo.trim() ? { scheme_ref: cardNo.trim() } : {}),
              ...(needsReferral && referralNo.trim() ? { referral_no: referralNo.trim() } : {}),
            }).then((ok) => {
              if (!ok) return;
              setCardNo("");
              setReferralNo("");
            });
          }}
        >
          {needsCard && (
            <label className="bc-field">
              <span className="bc-field__lbl">Card number</span>
              <input
                className="bc-field__in"
                value={cardNo}
                placeholder={bill.scheme_ref || "Not on file"}
                onChange={(e) => setCardNo(e.target.value)}
              />
            </label>
          )}
          {needsReferral && (
            <label className="bc-field">
              <span className="bc-field__lbl">Referral number</span>
              <input
                className="bc-field__in"
                value={referralNo}
                placeholder={bill.referral_no || "Not on file"}
                onChange={(e) => setReferralNo(e.target.value)}
              />
            </label>
          )}
          {needsDoc && (
            <label className="bc-field">
              <span className="bc-field__lbl">
                Referral scan {bill.referral_doc_id ? "(on file)" : ""}
              </span>
              <input
                ref={fileRef}
                className="bc-field__in"
                type="file"
                accept="image/*,application/pdf"
                disabled={uploading}
                onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
              />
            </label>
          )}
          {(needsCard || needsReferral) && (
            <button type="submit" className="st-btn" disabled={setCategory.isPending}>
              Save numbers
            </button>
          )}
        </form>
      )}

      {error && <div className="bc-err">{error}</div>}
    </section>
  );
}
