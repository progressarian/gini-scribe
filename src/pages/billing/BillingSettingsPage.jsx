import { useEffect, useId, useState } from "react";
import { Pencil, Power, PowerOff, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { BILL_SERIES, STACKING_MODES, financialYearOf } from "../../../shared/billingVocab.js";
import {
  useBillingSettings,
  useBillingTaxCodes,
  useBillSeries,
  useCreateBillingTaxCode,
  useDeleteBillingTaxCode,
  useSaveBillSeries,
  useSetBillingTaxCodeActive,
  useUpdateBillingSettings,
  useUpdateBillingTaxCode,
} from "../../queries/hooks/useBillingMaster";
import { toast } from "../../stores/uiStore";
import UsedInDialog from "../../components/billing/UsedInDialog";
import {
  codeTyped,
  digitsTyped,
  errorOf,
  moneyTyped,
  usesOf,
} from "../../components/billing/format";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "./billing.css";
import "./billingUi.css";

const STACKING_LABEL = {
  best_only: "Only the best discount",
  per_rule: "Each rule's discount, one after another",
};
const SERIES_LABEL = { MAIN: "Bills", RCPT: "Receipts" };

const text = (v) => (v === null || v === undefined ? "" : String(v));
const indiaToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const nextYear = (fy) => {
  const start = Number(fy.slice(0, 4)) + 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
};
const gstinTyped = (value) => value.toUpperCase().replace(/[^0-9A-Z]/g, "");
const TYPED = {
  max_codes_per_bill: digitsTyped,
  gstin: gstinTyped,
  state_code: digitsTyped,
  code: codeTyped,
  sac_hsn: digitsTyped,
  rate_pct: moneyTyped,
  prefix: codeTyped,
  number_width: digitsTyped,
  next_no: digitsTyped,
};
const typed = (key, value) => (TYPED[key] ? TYPED[key](value) : value);
const changedOnly = (after, before) =>
  Object.fromEntries(
    Object.entries(after).filter(([key, value]) => String(value) !== String(before[key])),
  );

function Field({ label, hint, children }) {
  const id = useId();
  return (
    <div className="fset__field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint ? <small className="flow-muted">{hint}</small> : null}
    </div>
  );
}

function Actions({ error, dirty, busy }) {
  return (
    <>
      {error ? (
        <p className="bill-dialog__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="bill-dialog__actions">
        <button type="submit" className="flow-btn flow-btn-primary" disabled={!dirty || busy}>
          Save
        </button>
      </div>
    </>
  );
}

function useSettingsForm(settings, pick) {
  const [base, setBase] = useState(() => pick(settings));
  const [form, setForm] = useState(base);
  const [error, setError] = useState("");
  const update = useUpdateBillingSettings();
  const changes = changedOnly(form, base);
  const dirty = Object.keys(changes).length > 0;
  const latest = JSON.stringify(pick(settings));

  useEffect(() => {
    if (dirty || latest === JSON.stringify(base)) return;
    const fresh = JSON.parse(latest);
    setBase(fresh);
    setForm(fresh);
  }, [latest, dirty, base]);

  const set = (key) => (e) =>
    setForm({
      ...form,
      [key]: e.target.type === "checkbox" ? e.target.checked : typed(key, e.target.value),
    });
  const save = async (e, message) => {
    e.preventDefault();
    setError("");
    try {
      const saved = pick(await update.mutateAsync(changes));
      setBase(saved);
      setForm(saved);
      toast(message, "success");
    } catch (err) {
      setError(errorOf(err, "Could not save"));
    }
  };
  return { form, set, save, error, dirty, busy: update.isPending };
}

const pickGeneral = (s) => ({
  discount_stacking: s.discount_stacking,
  allow_pay_later: s.allow_pay_later,
  max_codes_per_bill: text(s.max_codes_per_bill),
  bill_footer: text(s.bill_footer),
});

function GeneralCard({ settings }) {
  const { form, set, save, error, dirty, busy } = useSettingsForm(settings, pickGeneral);
  return (
    <form
      className="flow-card"
      aria-label="Bills"
      onSubmit={(e) => save(e, "Saved the bill settings")}
    >
      <div className="fset__cardhead">
        <h2 className="flow-sec-title">Bills</h2>
      </div>
      <div className="fset__cardsub">
        How discounts combine, whether patients can pay later, and the note printed on every bill.
      </div>
      <div className="bill-form bill-set__bills">
        <Field label="When several discounts apply">
          {(id) => (
            <select
              id={id}
              className="jb-assign"
              value={form.discount_stacking}
              onChange={set("discount_stacking")}
            >
              {STACKING_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {STACKING_LABEL[mode] ?? mode}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Most codes on one bill" hint="Leave empty for no limit">
          {(id) => (
            <input
              id={id}
              className="jb-assign"
              inputMode="numeric"
              maxLength={9}
              placeholder="e.g. 2"
              value={form.max_codes_per_bill}
              onChange={set("max_codes_per_bill")}
            />
          )}
        </Field>
      </div>
      <label className="fset__check bill-settings__check">
        <input type="checkbox" checked={form.allow_pay_later} onChange={set("allow_pay_later")} />
        Allow pay later (a category can override this)
      </label>
      <Field label="Bill footer">
        {(id) => (
          <textarea
            id={id}
            className="jb-assign bill-settings__footer"
            rows={3}
            maxLength={1000}
            placeholder="e.g. Thank you for choosing Gini. Please keep this bill for your records."
            value={form.bill_footer}
            onChange={set("bill_footer")}
          />
        )}
      </Field>
      <p className="fset__hint">
        The logo and letterhead printed on bills come from{" "}
        <Link to="/settings/prescription">Prescription settings</Link>.
      </p>
      <Actions error={error} dirty={dirty} busy={busy} />
    </form>
  );
}

const pickGst = (s) => ({
  gst_enabled: s.gst_enabled,
  gstin: text(s.gstin),
  state_code: text(s.state_code),
  legal_name: text(s.legal_name),
});

function GstCard({ settings }) {
  const { form, set, save, error, dirty, busy } = useSettingsForm(settings, pickGst);
  return (
    <form className="flow-card" aria-label="GST" onSubmit={(e) => save(e, "Saved the GST details")}>
      <div className="fset__cardhead">
        <h2 className="flow-sec-title">GST</h2>
      </div>
      <div className="fset__cardsub">
        Printed on GST bills. GST can only be switched on once all three details are filled in.
      </div>
      <label className="fset__check bill-settings__check">
        <input type="checkbox" checked={form.gst_enabled} onChange={set("gst_enabled")} />
        Charge GST on bills
      </label>
      <div className="bill-form bill-set__gst">
        <Field label="GSTIN">
          {(id) => (
            <input
              id={id}
              className="jb-assign"
              placeholder="e.g. 03ABCDE1234F1Z5"
              maxLength={15}
              value={form.gstin}
              onChange={set("gstin")}
            />
          )}
        </Field>
        <Field label="State code" hint="Filled from the GSTIN if left empty">
          {(id) => (
            <input
              id={id}
              className="jb-assign"
              inputMode="numeric"
              maxLength={2}
              placeholder="e.g. 03"
              value={form.state_code}
              onChange={set("state_code")}
            />
          )}
        </Field>
        <Field label="Legal name">
          {(id) => (
            <input
              id={id}
              className="jb-assign"
              maxLength={200}
              placeholder="e.g. Gini Health Private Limited"
              value={form.legal_name}
              onChange={set("legal_name")}
            />
          )}
        </Field>
      </div>
      <Actions error={error} dirty={dirty} busy={busy} />
    </form>
  );
}

function TaxRow({ tax, onBlocked }) {
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const update = useUpdateBillingTaxCode();
  const setActive = useSetBillingTaxCodeActive();
  const remove = useDeleteBillingTaxCode();
  const attempt = async (work, message) => {
    try {
      await work();
      toast(message, "success");
      return true;
    } catch (err) {
      toast(errorOf(err), "error");
      return false;
    }
  };
  const destroy = async () => {
    setConfirming(false);
    try {
      await remove.mutateAsync(tax.id);
      toast(`Deleted ${tax.code}`, "success");
    } catch (err) {
      const uses = usesOf(err);
      if (!uses) return toast(errorOf(err), "error");
      onBlocked({
        name: tax.code,
        uses,
        canDeactivate: tax.is_active,
        deactivate: () => setActive.mutateAsync({ id: tax.id, is_active: false }),
      });
    }
  };

  if (form) {
    const before = { sac_hsn: text(tax.sac_hsn), rate_pct: text(tax.rate_pct) };
    const changes = changedOnly(form, before);
    const save = async () => {
      const body = {
        ...changes,
        ...("sac_hsn" in changes ? { sac_hsn: form.sac_hsn.trim() || null } : {}),
      };
      if (!Object.keys(body).length) return setForm(null);
      setError("");
      try {
        await update.mutateAsync({ id: tax.id, ...body });
        toast(`Saved ${tax.code}`, "success");
        setForm(null);
      } catch (err) {
        setError(errorOf(err, `Could not save ${tax.code}`));
      }
    };
    const edit = (key) => (e) => setForm({ ...form, [key]: typed(key, e.target.value) });
    const close = () => {
      setError("");
      setForm(null);
    };
    return (
      <tr>
        <td data-label="Code">{tax.code}</td>
        <td data-label="SAC/HSN">
          <input
            className="jb-assign"
            aria-label={`SAC/HSN for ${tax.code}`}
            inputMode="numeric"
            maxLength={8}
            value={form.sac_hsn}
            onChange={edit("sac_hsn")}
          />
        </td>
        <td data-label="Rate">
          <input
            className="jb-assign"
            aria-label={`Rate % for ${tax.code}`}
            inputMode="decimal"
            maxLength={6}
            value={form.rate_pct}
            onChange={edit("rate_pct")}
          />
        </td>
        <td data-label="Items">{tax.item_count}</td>
        <td data-label="Active">
          <span className={`bill-status disc-status--${tax.is_active ? "on" : "off"}`}>
            {tax.is_active ? "Yes" : "No"}
          </span>
        </td>
        <td data-label="" className="bill-items__actions">
          <button
            type="button"
            className="flow-btn flow-btn-primary flow-btn-mini"
            disabled={update.isPending || !form.rate_pct.trim()}
            onClick={save}
          >
            Save
          </button>
          <button type="button" className="flow-btn flow-btn-ghost flow-btn-mini" onClick={close}>
            Cancel
          </button>
          {error ? (
            <p className="bill-dialog__error" role="alert">
              {error}
            </p>
          ) : null}
        </td>
      </tr>
    );
  }

  return (
    <tr className={tax.is_active ? "" : "fset__row--off"}>
      <td data-label="Code">{tax.code}</td>
      <td data-label="SAC/HSN">{tax.sac_hsn ?? "—"}</td>
      <td data-label="Rate">{tax.rate_pct}%</td>
      <td data-label="Items">{tax.item_count}</td>
      <td data-label="Active">
        <span className={`bill-status disc-status--${tax.is_active ? "on" : "off"}`}>
          {tax.is_active ? "Yes" : "No"}
        </span>
      </td>
      <td data-label="" className="bill-items__actions">
        <button
          type="button"
          className="bill-icon-btn"
          aria-label={`Edit ${tax.code}`}
          title="Edit"
          onClick={() => setForm({ sac_hsn: text(tax.sac_hsn), rate_pct: text(tax.rate_pct) })}
        >
          <Pencil size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="bill-icon-btn"
          aria-label={`${tax.is_active ? "Deactivate" : "Activate"} ${tax.code}`}
          title={tax.is_active ? "Deactivate" : "Activate"}
          onClick={() =>
            attempt(
              () => setActive.mutateAsync({ id: tax.id, is_active: !tax.is_active }),
              `${tax.code} ${tax.is_active ? "deactivated" : "activated"}`,
            )
          }
        >
          {tax.is_active ? (
            <PowerOff size={15} aria-hidden="true" />
          ) : (
            <Power size={15} aria-hidden="true" />
          )}
        </button>
        {confirming ? (
          <>
            <button
              type="button"
              className="flow-btn flow-btn-red flow-btn-mini"
              aria-label={`Confirm delete ${tax.code}`}
              onClick={destroy}
            >
              Confirm delete
            </button>
            <button
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini"
              onClick={() => setConfirming(false)}
            >
              Keep
            </button>
          </>
        ) : (
          <button
            type="button"
            className="bill-icon-btn bill-icon-btn--danger"
            aria-label={`Delete ${tax.code}`}
            title="Delete"
            onClick={() => setConfirming(true)}
          >
            <Trash2 size={15} aria-hidden="true" />
          </button>
        )}
      </td>
    </tr>
  );
}

const EMPTY_TAX = { code: "", sac_hsn: "", rate_pct: "" };

function TaxAddForm() {
  const [draft, setDraft] = useState(EMPTY_TAX);
  const [error, setError] = useState("");
  const create = useCreateBillingTaxCode();
  const set = (key) => (e) => setDraft({ ...draft, [key]: typed(key, e.target.value) });
  const submit = async (e) => {
    e.preventDefault();
    setError("");
    const code = draft.code.trim();
    try {
      await create.mutateAsync({
        code,
        rate_pct: draft.rate_pct.trim(),
        ...(draft.sac_hsn.trim() ? { sac_hsn: draft.sac_hsn.trim() } : {}),
      });
      toast(`Added ${code}`, "success");
      setDraft(EMPTY_TAX);
    } catch (err) {
      setError(errorOf(err, "Could not add the tax code"));
    }
  };
  return (
    <form aria-label="Add tax code" onSubmit={submit}>
      <div className="bill-form bill-set__tax">
        <Field label="Code">
          {(id) => (
            <input
              id={id}
              className="jb-assign"
              maxLength={40}
              placeholder="e.g. GST18"
              value={draft.code}
              onChange={set("code")}
            />
          )}
        </Field>
        <Field label="SAC/HSN">
          {(id) => (
            <input
              id={id}
              className="jb-assign"
              inputMode="numeric"
              maxLength={8}
              placeholder="e.g. 999312 (optional)"
              value={draft.sac_hsn}
              onChange={set("sac_hsn")}
            />
          )}
        </Field>
        <Field label="Rate %">
          {(id) => (
            <input
              id={id}
              className="jb-assign"
              inputMode="decimal"
              maxLength={6}
              placeholder="e.g. 18"
              value={draft.rate_pct}
              onChange={set("rate_pct")}
            />
          )}
        </Field>
      </div>
      {error ? (
        <p className="bill-dialog__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="bill-dialog__actions">
        <button
          type="submit"
          className="flow-btn flow-btn-primary"
          disabled={create.isPending || !draft.code.trim() || !draft.rate_pct.trim()}
        >
          + Add tax code
        </button>
      </div>
    </form>
  );
}

function TaxCodesCard({ onBlocked }) {
  const { data: taxes = [], isLoading, isError } = useBillingTaxCodes();
  return (
    <section className="flow-card bill-stack" aria-label="Tax codes">
      <div className="fset__cardhead">
        <h2 className="flow-sec-title">Tax codes</h2>
        <span className="fset__count">{taxes.length}</span>
      </div>
      <div className="fset__cardsub">
        The GST rates items can carry. A code used by an item can't be deleted, only switched off.
      </div>
      {isLoading ? (
        <div className="fset__cardsub">Loading…</div>
      ) : isError ? (
        <div className="fset__cardsub">Could not load the tax codes.</div>
      ) : taxes.length ? (
        <div className="fset__scroll">
          <table className="flow-table" aria-label="Tax codes">
            <thead>
              <tr>
                <th>Code</th>
                <th>SAC/HSN</th>
                <th>Rate</th>
                <th>Items</th>
                <th>Active</th>
                <th className="bill-items__actions-head">Actions</th>
              </tr>
            </thead>
            <tbody>
              {taxes.map((tax) => (
                <TaxRow key={tax.id} tax={tax} onBlocked={onBlocked} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="fset__cardsub">No tax codes yet.</div>
      )}
      <div className="fset__add">
        <div className="fset__addtitle">Add tax code</div>
        <TaxAddForm />
      </div>
    </section>
  );
}

function SeriesRow({ series, fy, row }) {
  const initial = {
    prefix: text(row?.prefix),
    number_width: text(row?.number_width ?? 6),
    next_no: text(row?.next_no ?? 1),
  };
  const [form, setForm] = useState(initial);
  const [error, setError] = useState("");
  const save = useSaveBillSeries();
  const changes = row ? changedOnly(form, initial) : form;
  const dirty = !row || Object.keys(changedOnly(form, initial)).length > 0;
  const width = Number(form.number_width) || 0;
  const preview =
    width > 0 && /^\d+$/.test(form.next_no)
      ? `${form.prefix.trim()}${form.next_no.padStart(width, "0")}`
      : "—";
  const set = (key) => (e) => setForm({ ...form, [key]: typed(key, e.target.value) });
  const submit = async () => {
    setError("");
    try {
      await save.mutateAsync({ series, fy, ...changes });
      toast(`Saved the ${SERIES_LABEL[series] ?? series} series for ${fy}`, "success");
    } catch (err) {
      setError(errorOf(err, "Could not save the series"));
    }
  };
  const label = SERIES_LABEL[series] ?? series;
  return (
    <tr>
      <td data-label="Series">
        {label}
        {row ? null : <div className="flow-muted bill-items__sub">Not set up yet</div>}
      </td>
      <td data-label="Prefix">
        <input
          className="jb-assign"
          aria-label={`${label} prefix`}
          maxLength={30}
          placeholder="None"
          value={form.prefix}
          onChange={set("prefix")}
        />
      </td>
      <td data-label="Digits">
        <input
          className="jb-assign"
          aria-label={`${label} digits`}
          inputMode="numeric"
          maxLength={2}
          value={form.number_width}
          onChange={set("number_width")}
        />
      </td>
      <td data-label="Next number">
        <input
          className="jb-assign"
          aria-label={`${label} next number`}
          inputMode="numeric"
          maxLength={12}
          value={form.next_no}
          onChange={set("next_no")}
        />
      </td>
      <td data-label="Next looks like">
        <code>{preview}</code>
      </td>
      <td data-label="" className="bill-items__actions">
        <button
          type="button"
          className="flow-btn flow-btn-primary flow-btn-mini"
          aria-label={`Save ${label} series`}
          disabled={!dirty || save.isPending}
          onClick={submit}
        >
          {row ? "Save" : "Set up"}
        </button>
        {error ? (
          <p className="bill-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
      </td>
    </tr>
  );
}

function SeriesCard() {
  const { data: rows = [], isLoading, isError } = useBillSeries();
  const current = financialYearOf(indiaToday());
  const [fy, setFy] = useState(current);
  const id = useId();
  return (
    <section className="flow-card bill-stack" aria-label="Number series">
      <div className="fset__cardhead">
        <h2 className="flow-sec-title">Number series</h2>
      </div>
      <div className="fset__cardsub">
        Bill and receipt numbers start again each financial year (April–March). The next number can
        only go up, so a number is never used twice.
      </div>
      <div className="bill-form bill-set__fy">
        <div className="fset__field fset__field--narrow bill-rates__asof">
          <label htmlFor={id}>Financial year</label>
          <select id={id} className="jb-assign" value={fy} onChange={(e) => setFy(e.target.value)}>
            <option value={current}>{current}</option>
            <option value={nextYear(current)}>{nextYear(current)}</option>
          </select>
        </div>
      </div>
      {isLoading ? (
        <div className="fset__cardsub">Loading…</div>
      ) : isError ? (
        <div className="fset__cardsub">Could not load the number series.</div>
      ) : (
        <div className="fset__scroll">
          <table className="flow-table" aria-label={`Number series ${fy}`}>
            <thead>
              <tr>
                <th>Series</th>
                <th>Prefix</th>
                <th>Digits</th>
                <th>Next number</th>
                <th>Next looks like</th>
                <th className="bill-items__actions-head">Actions</th>
              </tr>
            </thead>
            <tbody>
              {BILL_SERIES.map((series) => {
                const row = rows.find((r) => r.series === series && r.fy === fy) ?? null;
                return (
                  <SeriesRow
                    key={`${series}-${fy}-${row ? row.updated_at : "new"}`}
                    series={series}
                    fy={fy}
                    row={row}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function BillingSettingsPage() {
  const { data: settings, isLoading, isError } = useBillingSettings();
  const [blocked, setBlocked] = useState(null);
  const [blockedError, setBlockedError] = useState("");
  const [deactivating, setDeactivating] = useState(false);

  const deactivateBlocked = async () => {
    setDeactivating(true);
    setBlockedError("");
    try {
      await blocked.deactivate();
      toast(`${blocked.name} deactivated`, "success");
      setBlocked(null);
    } catch (err) {
      setBlockedError(errorOf(err, "Could not deactivate it"));
    } finally {
      setDeactivating(false);
    }
  };

  return (
    <div className="flow-root fset bill-ui bill-settings-page">
      {isError ? (
        <div className="flow-card fset__cardsub">Could not load the billing settings.</div>
      ) : isLoading || !settings ? (
        <div className="flow-card fset__cardsub">Loading…</div>
      ) : (
        <div className="bill-settings">
          <GeneralCard settings={settings} />
          <GstCard settings={settings} />
          <TaxCodesCard onBlocked={setBlocked} />
          <SeriesCard />
        </div>
      )}
      <UsedInDialog
        blocked={blocked}
        error={blockedError}
        busy={deactivating}
        onClose={() => {
          setBlocked(null);
          setBlockedError("");
        }}
        onDeactivate={deactivateBlocked}
      />
    </div>
  );
}
