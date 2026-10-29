import { useId, useState } from "react";
import api from "../../services/api.js";
import { PATIENT_CATEGORIES, categoryMeta } from "../../../shared/patientCategories.js";
import {
  GOVT_ID_TYPES,
  aadhaarDigits,
  formatAadhaar,
  identityProblems,
  schemeNeedsCard,
} from "../../../shared/patientIdentity.js";
import CaptureSlot from "./CaptureSlot.jsx";

export const EMPTY_IDENTITY = {
  scheme_code: "",
  scheme_ref: "",
  aadhaar: "",
  govt_id_type: "",
  govt_id: "",
  use_other_id: false,
};

export const EMPTY_FILES = { id_proof: null, scheme_card: null };

const requiresCard = (code) => {
  const meta = categoryMeta(code);
  return schemeNeedsCard(code, meta?.parent, meta?.requiresRef);
};

export const requiredScan = (code) =>
  !code ? "id_proof" : requiresCard(code) ? "scheme_card" : null;

export function registrationProblems(identity, files, { withFiles = true } = {}) {
  const problems = identityProblems(identity, {
    requiresCard: requiresCard(identity.scheme_code),
    useOtherId: !identity.scheme_code && identity.use_other_id,
  });
  const scan = requiredScan(identity.scheme_code);
  if (withFiles && scan && !files?.[scan]) {
    problems[scan] =
      scan === "scheme_card" ? "Scan or upload the card." : "Scan or upload the ID proof.";
  }
  return problems;
}

export function identityPayload(identity) {
  const general = !identity.scheme_code;
  const otherId = general && identity.use_other_id;
  return {
    scheme_code: identity.scheme_code,
    scheme_ref: requiresCard(identity.scheme_code) ? identity.scheme_ref.trim() : "",
    aadhaar: otherId ? "" : aadhaarDigits(identity.aadhaar),
    govt_id_type: otherId ? identity.govt_id_type : "",
    govt_id: otherId ? identity.govt_id.trim().toUpperCase() : "",
  };
}

const toBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

export async function uploadRegistrationFiles(patientId, files) {
  const failed = [];
  let state = null;
  for (const kind of Object.keys(EMPTY_FILES)) {
    const item = files?.[kind];
    if (!item) continue;
    try {
      const { data } = await api.post(`/api/registration-documents/${patientId}/${kind}`, {
        base64: await toBase64(item.blob),
        mediaType: item.mediaType,
        fileName: item.name,
      });
      state = data;
    } catch {
      failed.push(kind);
    }
  }
  return { failed, state };
}

export const FILE_LABELS = { id_proof: "ID proof", scheme_card: "Card scan" };

function Field({ id, label, error, children }) {
  return (
    <div className="regid__field">
      <label className="regid__label" htmlFor={id}>
        {label}
      </label>
      {children}
      {error && (
        <span className="regid__err" id={`${id}-err`} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export default function RegistrationIdentityFields({
  value,
  onChange,
  errors = {},
  files,
  onFilesChange,
  withFiles = true,
}) {
  const uid = useId();
  const [touched, setTouched] = useState({});
  const set = (patch) => onChange({ ...value, ...patch });
  const code = value.scheme_code;
  const meta = categoryMeta(code);
  const cardLabel = categoryMeta(meta?.parent)?.label || meta?.label;
  const cardNeeded = requiresCard(code);
  const general = !code;
  const setFile = (kind, item) => onFilesChange({ ...files, [kind]: item });

  const live = identityProblems(value, {
    requiresCard: cardNeeded,
    useOtherId: general && value.use_other_id,
  });
  const aadhaarComplete = aadhaarDigits(value.aadhaar).length === 12;
  const shown = (key) =>
    errors[key] || ((touched[key] || (key === "aadhaar" && aadhaarComplete)) && live[key]) || null;
  const touch = (key) => () => setTouched((t) => ({ ...t, [key]: true }));
  const inputProps = (key) => {
    const id = `${uid}-${key}`;
    const error = shown(key);
    return {
      id,
      onBlur: touch(key),
      "aria-invalid": error ? "true" : undefined,
      "aria-describedby": error ? `${id}-err` : undefined,
      "aria-required": "true",
    };
  };

  return (
    <div className="regid">
      <div className="regid__grid">
        <Field id={`${uid}-scheme_code`} label="Patient category *" error={shown("scheme_code")}>
          <select
            className="regid__input"
            value={code}
            onChange={(e) => {
              set({ scheme_code: e.target.value, scheme_ref: "" });
              setTouched({});
            }}
            {...inputProps("scheme_code")}
          >
            {PATIENT_CATEGORIES.map((c) => (
              <option key={c.value || "general"} value={c.value}>
                {c.value ? `${c.sub ? "\u00a0\u00a0" : ""}${c.label}` : "General"}
              </option>
            ))}
          </select>
        </Field>

        {cardNeeded && (
          <Field
            id={`${uid}-scheme_ref`}
            label={`${cardLabel} card number *`}
            error={shown("scheme_ref")}
          >
            <input
              className="regid__input"
              value={value.scheme_ref}
              onChange={(e) => set({ scheme_ref: e.target.value })}
              placeholder="Card / beneficiary number"
              maxLength={30}
              autoComplete="off"
              {...inputProps("scheme_ref")}
            />
          </Field>
        )}

        {(!general || !value.use_other_id) && (
          <Field
            id={`${uid}-aadhaar`}
            label={general ? "Aadhaar number *" : "Aadhaar number (optional)"}
            error={shown("aadhaar")}
          >
            <input
              className="regid__input"
              value={formatAadhaar(value.aadhaar)}
              onChange={(e) => set({ aadhaar: aadhaarDigits(e.target.value).slice(0, 12) })}
              placeholder="XXXX XXXX XXXX"
              inputMode="numeric"
              maxLength={14}
              autoComplete="off"
              {...inputProps("aadhaar")}
              aria-required={general ? "true" : undefined}
            />
          </Field>
        )}

        {general && value.use_other_id && (
          <>
            <Field id={`${uid}-govt_id_type`} label="Govt ID type *" error={shown("govt_id_type")}>
              <select
                className="regid__input"
                value={value.govt_id_type}
                onChange={(e) => set({ govt_id_type: e.target.value })}
                {...inputProps("govt_id_type")}
              >
                <option value="">Select type</option>
                {GOVT_ID_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </Field>
            <Field id={`${uid}-govt_id`} label="ID number *" error={shown("govt_id")}>
              <input
                className="regid__input"
                value={value.govt_id}
                onChange={(e) => set({ govt_id: e.target.value.toUpperCase() })}
                placeholder={value.govt_id_type === "PAN Card" ? "ABCDE1234F" : "ID number"}
                maxLength={20}
                autoComplete="off"
                {...inputProps("govt_id")}
              />
            </Field>
          </>
        )}
      </div>

      {general && (
        <button
          type="button"
          className="regid__toggle"
          onClick={() => {
            set({ use_other_id: !value.use_other_id });
            setTouched({});
          }}
        >
          {value.use_other_id ? "Use Aadhaar instead" : "No Aadhaar? Use another govt ID"}
        </button>
      )}

      {withFiles && (general || cardNeeded) && (
        <div className="regid__files">
          {general && (
            <CaptureSlot
              label={value.use_other_id ? "ID proof scan" : "Aadhaar scan"}
              required
              facing="environment"
              value={files.id_proof}
              onChange={(item) => setFile("id_proof", item)}
              error={errors.id_proof}
            />
          )}
          {cardNeeded && (
            <CaptureSlot
              label={`${cardLabel} card scan`}
              required
              facing="environment"
              value={files.scheme_card}
              onChange={(item) => setFile("scheme_card", item)}
              error={errors.scheme_card}
            />
          )}
        </div>
      )}
    </div>
  );
}
