import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "../services/api.js";
import { toast } from "../stores/uiStore.js";
import { hydrateCategories } from "../../shared/patientCategories.js";
// The card, table and button classes below are the flow settings vocabulary:
// .flow-* comes from flow.css and the .fset__* wrappers from FlowSettings.css.
// Both are needed, and so is the .flow-root .fset wrapper — FlowSettings.css
// scopes its rules as `.fset .flow-card`, so without it the page renders
// unstyled even with the sheets loaded.
import "../styles/flow.css";
import "./flow/FlowSettings.css";

// The schemes a patient can be billed under — CGHS, ECHS, and whatever the
// hospital agrees next. The list used to be a hardcoded array, so adding one was
// a deploy (33-PATIENT-SCHEME-PLAN.md §1).
//
// `code` is deliberately not editable after creation: it is the join key the
// daily cap and every price table hang off, so renaming it would orphan those
// rows. Retire the scheme and add a new one instead.

const useSchemes = () =>
  useQuery({
    queryKey: ["patient-schemes", "all"],
    queryFn: async () => (await api.get("/api/patient-schemes?all=1")).data,
  });

const useSaveScheme = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ code, ...patch }) =>
      (await api.patch(`/api/patient-schemes/${code}`, patch)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["patient-schemes"] }),
  });
};

const useAddScheme = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body) => (await api.post("/api/patient-schemes", body)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["patient-schemes"] }),
  });
};

const COLORS = ["gray", "blue", "teal", "green", "purple", "amber", "red"];

// A cap and a label are edited in place and saved per row, the way the test
// catalogue prices are — no form, no modal, no unsaved-changes state to lose.
function SchemeRow({ scheme, onSave, saving }) {
  const [label, setLabel] = useState(scheme.label);
  const [color, setColor] = useState(scheme.color);
  const [cap, setCap] = useState(scheme.daily_cap ?? "");
  const [ref, setRef] = useState(!!scheme.requires_ref);

  useEffect(() => {
    setLabel(scheme.label);
    setColor(scheme.color);
    setCap(scheme.daily_cap ?? "");
    setRef(!!scheme.requires_ref);
  }, [scheme]);

  const dirty =
    label !== scheme.label ||
    color !== scheme.color ||
    String(cap) !== String(scheme.daily_cap ?? "") ||
    ref !== !!scheme.requires_ref;

  return (
    <tr className={scheme.is_active ? "" : "sch-retired"}>
      <td>
        <code className="sch-code">{scheme.code}</code>
      </td>
      <td>
        <input className="jb-assign" value={label} onChange={(e) => setLabel(e.target.value)} />
      </td>
      <td>
        <select className="jb-assign" value={color} onChange={(e) => setColor(e.target.value)}>
          {COLORS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          className="jb-dur"
          type="number"
          min="0"
          value={cap}
          placeholder="∞"
          title="Patients of this scheme allowed per day, hospital-wide. Blank means no limit."
          onChange={(e) => setCap(e.target.value)}
        />
      </td>
      <td>
        <input
          type="checkbox"
          checked={ref}
          title="Prompt the desk for a card / beneficiary number when tagging a patient"
          onChange={(e) => setRef(e.target.checked)}
        />
      </td>
      <td>
        <input
          type="checkbox"
          checked={scheme.is_active}
          title={scheme.is_active ? "Retire this scheme" : "Bring this scheme back"}
          onChange={(e) => onSave({ code: scheme.code, is_active: e.target.checked })}
        />
      </td>
      <td>
        <button
          className="flow-btn flow-btn-primary"
          disabled={!dirty || saving}
          onClick={() =>
            onSave({
              code: scheme.code,
              label: label.trim(),
              color,
              daily_cap: cap,
              requires_ref: ref,
            })
          }
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </td>
    </tr>
  );
}

export default function SchemesSettingsPage() {
  const { data: schemes = [], isLoading } = useSchemes();
  const save = useSaveScheme();
  const add = useAddScheme();
  const [draft, setDraft] = useState({ code: "", label: "", color: "gray" });

  // The rest of the app reads this list through shared/patientCategories.js, so
  // an edit here has to reach the seed cache or the sheet would keep rendering
  // the old label until a reload.
  useEffect(() => {
    if (schemes.length) hydrateCategories(schemes.filter((s) => s.is_active));
  }, [schemes]);

  const onSave = (patch) =>
    save.mutate(patch, {
      onSuccess: () => toast(`Saved ${patch.code}`, "success"),
      onError: (e) => toast(e?.response?.data?.error || "Could not save that", "error"),
    });

  const onAdd = () => {
    const code = draft.code.trim().toLowerCase();
    if (!code || !draft.label.trim()) return toast("A scheme needs a code and a label", "error");
    add.mutate(
      { ...draft, code },
      {
        onSuccess: () => {
          setDraft({ code: "", label: "", color: "gray" });
          toast(`Added ${code}`, "success");
        },
        onError: (e) => toast(e?.response?.data?.error || "Could not add that scheme", "error"),
      },
    );
  };

  return (
    <div className="flow-root fset">
      <div className="flow-card">
        <div className="fset__cardhead">
          <div className="flow-sec-title">Patient schemes</div>
          <span className="fset__count">{schemes.length}</span>
        </div>
        <div className="fset__cardsub">
          Who is billed at a scheme rate, and how many of them the hospital will see in a day. The
          daily cap is hospital-wide, not per doctor.
        </div>

        {isLoading ? (
          <div className="fset__cardsub">Loading…</div>
        ) : (
          <div className="fset__scroll">
            <table className="flow-table" style={{ border: "none" }}>
              <thead>
                <tr>
                  <th style={{ width: 130 }}>Code</th>
                  <th>Label</th>
                  <th style={{ width: 100 }}>Colour</th>
                  <th style={{ width: 90 }}>Cap / day</th>
                  <th style={{ width: 70 }}>Card no.</th>
                  <th style={{ width: 60 }}>Active</th>
                  <th style={{ width: 80 }} />
                </tr>
              </thead>
              <tbody>
                {schemes.map((s) => (
                  <SchemeRow key={s.code} scheme={s} onSave={onSave} saving={save.isPending} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="fset__add">
          <div className="fset__addtitle">Add scheme</div>
          <div className="fset__addrow">
            <input
              className="jb-assign"
              placeholder="code (e.g. esic)"
              value={draft.code}
              title="Lower case, digits and underscore. Cannot be changed later — it is the key prices and caps hang off."
              onChange={(e) => setDraft({ ...draft, code: e.target.value })}
            />
            <input
              className="jb-assign"
              placeholder="Label (e.g. ESIC)"
              style={{ flex: "2 1 150px", maxWidth: "none" }}
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
            <select
              className="jb-assign"
              value={draft.color}
              onChange={(e) => setDraft({ ...draft, color: e.target.value })}
            >
              {COLORS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <button className="flow-btn flow-btn-primary" disabled={add.isPending} onClick={onAdd}>
              + Add
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
