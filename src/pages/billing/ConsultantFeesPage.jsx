import { useId, useState } from "react";
import {
  useBillingCategories,
  useBillingConsultantFees,
  useBillingItemChoices,
  useSetBillingItemActive,
} from "../../queries/hooks/useBillingMaster";
import { toast } from "../../stores/uiStore";
import ConsultantFeeCopy from "../../components/billing/ConsultantFeeCopy";
import ConsultantFeeCreateItem from "../../components/billing/ConsultantFeeCreateItem";
import ConsultantFeeEditor from "../../components/billing/ConsultantFeeEditor";
import { cellSummary, paysText, whoOf } from "../../components/billing/consultantFeeText";
import { requestErrorOf, rupees } from "../../components/billing/format";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "./billing.css";
import "./consultantFees.css";

const RESERVED = "general";

function Picker({ label, value, onChange, children }) {
  const id = useId();
  return (
    <div className="fset__field">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="jb-assign" value={value} onChange={onChange}>
        {children}
      </select>
    </div>
  );
}

function inheritedNote(cell) {
  const fee = cell.fee_source !== "own";
  const pays = cell.pays.source !== "own";
  if (fee && pays) return "inherited";
  if (fee) return "fee inherited";
  if (pays) return "pays inherited";
  return "";
}

function FeeCell({ row, column, cell, parentLabel, onEdit }) {
  const who = `${whoOf(row)} (${row.visit_type})`;
  if (cell.general) {
    return (
      <td className="cf-cell cf-cell--general">
        <span className="cf-cell__fee">{rupees(cell.fee)}</span>
        <span className="cf-cell__note">base price</span>
      </td>
    );
  }
  const note = inheritedNote(cell);
  const summary = cellSummary(cell, parentLabel);
  return (
    <td className="cf-cell">
      <button
        type="button"
        className={`cf-cell__btn${note ? " cf-cell__btn--inherited" : ""}`}
        aria-label={`${column.display_label} for ${who}: ${summary}${cell.next_valid_from ? `, changes on ${cell.next_valid_from}` : ""}`}
        title={summary}
        onClick={onEdit}
      >
        <span className={cell.fee_source === "own" ? "cf-cell__fee" : "cf-cell__fee cf-dim"}>
          {rupees(cell.fee)}
        </span>
        <span className={cell.pays.source === "own" ? "cf-cell__pays" : "cf-cell__pays cf-dim"}>
          {paysText(cell.pays)}
        </span>
        {note ? <span className="cf-cell__note">{note}</span> : null}
        {cell.next_valid_from ? (
          <span className="cf-cell__note">changes {cell.next_valid_from}</span>
        ) : null}
      </button>
    </td>
  );
}

function ActivateButton({ doctor }) {
  const activate = useSetBillingItemActive();
  return (
    <button
      type="button"
      className="flow-btn flow-btn-ghost flow-btn-mini"
      aria-label={`Activate item ${doctor.item_code} for ${doctor.doctor_name} (${doctor.visit_type})`}
      disabled={activate.isPending}
      onClick={async () => {
        try {
          await activate.mutateAsync({ id: doctor.item_id, is_active: true });
          toast(`Activated ${doctor.item_code}`, "success");
        } catch (err) {
          toast(requestErrorOf(err, "Could not activate the item"), "error");
        }
      }}
    >
      Activate {doctor.item_code}
    </button>
  );
}

function NotPriced({ doctors, onCreate }) {
  return (
    <section className="flow-card cf-notpriced" aria-labelledby="cf-notpriced-title">
      <div className="fset__cardhead">
        <h2 id="cf-notpriced-title" className="flow-sec-title">
          Not priced
        </h2>
        <span className="fset__count">{doctors.length}</span>
      </div>
      <div className="fset__cardsub">
        These doctors have no consultation item for a visit type, so they have no fee to set here.
        Where the hospital default covers them, their visits are billed at the default fee
        meanwhile.
      </div>
      <div className="fset__scroll">
        <table className="flow-table" aria-label="Not priced">
          <thead>
            <tr>
              <th>Doctor</th>
              <th>Visit type</th>
              <th>Billed meanwhile</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {doctors.map((d) => (
              <tr key={`${d.doctor_id}-${d.visit_type}`}>
                <td>
                  {d.doctor_name}
                  {d.doctor_active === false ? (
                    <span className="flow-muted"> (inactive)</span>
                  ) : null}
                </td>
                <td>{d.visit_type}</td>
                <td>{d.default_covers ? "Hospital default fee" : "Nothing — no fee"}</td>
                <td className="bill-items__actions">
                  {d.status === "item_deactivated" ? <ActivateButton doctor={d} /> : null}
                  <button
                    type="button"
                    className="flow-btn flow-btn-primary flow-btn-mini"
                    aria-label={`Create item for ${d.doctor_name} (${d.visit_type})`}
                    onClick={() => onCreate(d)}
                  >
                    Create item
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function ConsultantFeesPage() {
  const { data: tree = [] } = useBillingCategories({ activeOnly: true });
  const { data: choices } = useBillingItemChoices();
  const [doctorId, setDoctorId] = useState("");
  const [schemeCode, setSchemeCode] = useState("");
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(null);
  const [copying, setCopying] = useState(false);
  const { data: grid, isLoading, isError } = useBillingConsultantFees({ doctorId, schemeCode });

  const categories = tree.filter((top) => top.code !== RESERVED);
  const labels = new Map(
    categories.flatMap((top) => [
      [top.code, top.label],
      ...top.sub_categories.map((sub) => [sub.code, sub.label]),
    ]),
  );
  const parentOf = (column) => labels.get(column.parent_code) ?? column.parent_code;
  const subgroupFor = (doctor) =>
    (grid?.rows ?? []).find((r) => r.doctor_id === doctor.doctor_id)?.item.subgroup_id ??
    grid?.rows?.[0]?.item.subgroup_id ??
    null;
  const copyFrom = schemeCode && schemeCode !== RESERVED ? schemeCode : "";

  return (
    <div className="flow-root fset cf-page">
      <div className="flow-card">
        <div className="fset__cardhead">
          <h2 className="flow-sec-title">Consultant fees</h2>
        </div>
        <div className="fset__cardsub">
          Each doctor's New and Follow Up fee for every category, and what the patient pays. Click a
          cell to change it. Greyed values are inherited — from the parent category, a wider rule or
          the base price — until the cell gets its own.
        </div>
        <div className="bill-form">
          <Picker label="Doctor" value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
            <option value="">All doctors</option>
            {(choices?.consultants ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Picker>
          <Picker
            label="Category"
            value={schemeCode}
            onChange={(e) => setSchemeCode(e.target.value)}
          >
            <option value="">All categories</option>
            {categories.flatMap((top) => [
              <option key={top.code} value={top.code}>
                {top.label}
              </option>,
              ...top.sub_categories.map((sub) => (
                <option key={sub.code} value={sub.code}>
                  {`   ${sub.display_label}`}
                </option>
              )),
            ])}
          </Picker>
          <button
            type="button"
            className="flow-btn flow-btn-ghost cf-page__copy"
            onClick={() => setCopying(true)}
          >
            Copy column to…
          </button>
        </div>
      </div>

      {grid?.not_priced?.length ? (
        <NotPriced doctors={grid.not_priced} onCreate={setCreating} />
      ) : null}

      {isError ? (
        <div className="flow-card fset__cardsub">Could not load the consultant fees.</div>
      ) : isLoading || !grid ? (
        <div className="flow-card fset__cardsub">Loading…</div>
      ) : (
        <div className="flow-card bill-rates">
          <div className="fset__cardhead">
            <h2 className="flow-sec-title">Fees</h2>
            <span className="fset__count">{grid.rows.length}</span>
            <span className="flow-muted bill-rates__on">as of {grid.date}</span>
          </div>
          {!grid.rows.length ? (
            <div className="fset__cardsub">
              {doctorId
                ? "This doctor has no consultation item yet."
                : "No consultant has a consultation item yet."}
            </div>
          ) : (
            <div className="fset__scroll cf-scroll">
              <table className="flow-table cf-grid" aria-label="Consultant fees">
                <thead>
                  <tr>
                    <th scope="col" className="cf-grid__who">
                      Doctor
                    </th>
                    <th scope="col">Visit</th>
                    {grid.columns.map((column) => (
                      <th
                        key={column.code}
                        scope="col"
                        className={column.parent_code ? "cf-grid__sub" : undefined}
                      >
                        {column.display_label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {grid.rows.map((row) => (
                    <tr key={row.item.id}>
                      <th scope="row" className="cf-grid__who">
                        {whoOf(row)}
                        {row.doctor_active === false ? (
                          <span className="flow-muted"> (inactive)</span>
                        ) : null}
                        <div className="flow-muted bill-items__sub">{row.item.code}</div>
                      </th>
                      <td>{row.visit_type}</td>
                      {grid.columns.map((column) => (
                        <FeeCell
                          key={column.code}
                          row={row}
                          column={column}
                          cell={row.cells[column.code]}
                          parentLabel={parentOf(column)}
                          onEdit={() => setEditing({ row, column, cell: row.cells[column.code] })}
                        />
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {editing ? (
        <ConsultantFeeEditor
          target={editing}
          parentLabel={parentOf(editing.column)}
          today={grid?.today}
          date={grid?.date}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {creating ? (
        <ConsultantFeeCreateItem
          doctor={creating}
          subgroupId={subgroupFor(creating)}
          onClose={() => setCreating(null)}
        />
      ) : null}
      {copying ? (
        <ConsultantFeeCopy
          tree={categories}
          from={copyFrom}
          date={grid?.date}
          onClose={() => setCopying(false)}
        />
      ) : null}
    </div>
  );
}
