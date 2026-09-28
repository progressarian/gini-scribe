import { useEffect, useId, useRef, useState } from "react";
import {
  useBillingCategories,
  useBillingConsultantFees,
  useBillingConsultantFeesNotPriced,
  useBillingItemChoices,
  useSetBillingItemActive,
} from "../../queries/hooks/useBillingMaster";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import useAuthStore from "../../stores/authStore";
import DeleteDoctorModal from "../../components/doctors/DeleteDoctorModal";
import { toast } from "../../stores/uiStore";
import { CONSULTANT_FEES_PAGE_SIZE } from "../../../shared/billingVocab";
import useDebounced from "../../hooks/useDebounced";
import Pagination from "../../components/ui/Pagination";
import ConsultantFeeCopy from "../../components/billing/ConsultantFeeCopy";
import ConsultantFeeCreateItem from "../../components/billing/ConsultantFeeCreateItem";
import ConsultantFeeEditor from "../../components/billing/ConsultantFeeEditor";
import { cellSummary, paysText, whoOf } from "../../components/billing/consultantFeeText";
import { requestErrorOf, rupees } from "../../components/billing/format";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "./billing.css";
import "./billingUi.css";
import "./consultantFees.css";

const RESERVED = "general";

function Picker({ label, value, onChange, note, children }) {
  const id = useId();
  const noteId = `${id}-note`;
  return (
    <div className="fset__field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="jb-assign"
        value={value}
        onChange={onChange}
        aria-describedby={note ? noteId : undefined}
      >
        {children}
      </select>
      {note ? (
        <p id={noteId} className="fset__hint cf-page__note" role="alert">
          {note}
        </p>
      ) : null}
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

function SearchBox({ label, value, onChange }) {
  return (
    <input
      type="search"
      className="jb-assign bill-np-search"
      aria-label={label}
      placeholder={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function NotPriced({ list, doctors, search, paging, headingRef, buttonRefs, onCreate, onRemove }) {
  return (
    <section className="flow-card bill-stack cf-notpriced" aria-labelledby="cf-notpriced-title">
      <div className="fset__cardhead cf-head">
        <h2 id="cf-notpriced-title" className="flow-sec-title" ref={headingRef} tabIndex={-1}>
          Not priced
        </h2>
        <span className="fset__count bill-count--todo">{list.count}</span>
        {search}
      </div>
      <div className="fset__cardsub">
        These doctors have no consultation item for a visit type, so they have no fee to set here.
        Where the hospital default covers them, their visits are billed at the default fee
        meanwhile.
        {doctors.some((d) => !d.doctor_id)
          ? " The hospital default is the fee for any doctor without one of their own."
          : ""}
      </div>
      {!doctors.length ? (
        <div className="fset__cardsub">No doctor without a fee matches that search.</div>
      ) : (
        <div className="fset__scroll">
          <table className="flow-table" aria-label="Not priced">
            <thead>
              <tr>
                <th>Doctor</th>
                <th>Visit type</th>
                <th>Billed meanwhile</th>
                <th className="bill-items__actions-head">Action</th>
              </tr>
            </thead>
            <tbody>
              {doctors.map((d, index) => (
                <tr key={`${d.doctor_id}-${d.visit_type}`}>
                  <td data-label="Doctor">
                    {d.doctor_id ? d.doctor_name : "Hospital default"}
                    {d.doctor_active === false ? (
                      <span className="flow-muted"> (inactive)</span>
                    ) : null}
                  </td>
                  <td data-label="Visit type">{d.visit_type}</td>
                  <td data-label="Billed meanwhile">
                    {d.default_covers ? "Hospital default fee" : "Nothing — no fee"}
                  </td>
                  <td data-label="" className="bill-items__actions">
                    {d.status === "item_deactivated" ? <ActivateButton doctor={d} /> : null}
                    <button
                      type="button"
                      className="flow-btn flow-btn-primary flow-btn-mini"
                      aria-label={`Create item for ${d.doctor_id ? d.doctor_name : "Hospital default"} (${d.visit_type})`}
                      ref={(node) => {
                        const key = `${d.doctor_id}-${d.visit_type}`;
                        if (node) buttonRefs.current.set(key, node);
                        else buttonRefs.current.delete(key);
                      }}
                      onClick={() => onCreate({ doctor: d, index })}
                    >
                      Create item
                    </button>
                    {onRemove && d.doctor_id && d.doctor_active !== false ? (
                      <button
                        type="button"
                        className="flow-btn flow-btn-ghost flow-btn-mini cf-grid__remove"
                        aria-label={`Delete doctor ${d.doctor_name}`}
                        onClick={() => onRemove({ id: d.doctor_id, name: d.doctor_name })}
                      >
                        Delete doctor
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {paging}
    </section>
  );
}

export default function ConsultantFeesPage() {
  const { data: tree = [], isError: categoriesFailed } = useBillingCategories({ activeOnly: true });
  const { data: choices, isError: doctorsFailed } = useBillingItemChoices();
  const [doctorId, setDoctorId] = useState("");
  const [schemeCode, setSchemeCode] = useState("");
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(null);
  const [copying, setCopying] = useState(false);
  const [focusAfter, setFocusAfter] = useState(null);
  const [feeSearch, setFeeSearch] = useState("");
  const [removing, setRemoving] = useState(null);
  const isAdmin = useAuthStore((s) => s.currentDoctor?.role) === "admin";
  const queryClient = useQueryClient();
  const [feePage, setFeePage] = useState(1);
  const [feePageSize, setFeePageSize] = useState(CONSULTANT_FEES_PAGE_SIZE);
  const [npSearch, setNpSearch] = useState("");
  const [npPage, setNpPage] = useState(1);
  const [npPageSize, setNpPageSize] = useState(CONSULTANT_FEES_PAGE_SIZE);
  const feeQ = useDebounced(feeSearch.trim(), 300);
  const npQ = useDebounced(npSearch.trim(), 300);
  const {
    data: grid,
    isLoading,
    isError,
    isFetching,
  } = useBillingConsultantFees({
    doctorId,
    schemeCode,
    q: feeQ,
    page: feePage,
    page_size: feePageSize,
  });
  const { data: unpriced, isFetching: npFetching } = useBillingConsultantFeesNotPriced({
    doctorId,
    q: npQ,
    page: npPage,
    page_size: npPageSize,
  });
  const notPriced = [
    ...(unpriced?.missing_defaults ?? []).map((visit_type) => ({
      doctor_id: null,
      doctor_name: null,
      visit_type,
    })),
    ...(unpriced?.rows ?? []),
  ];
  const createRefs = useRef(new Map());
  const notPricedRef = useRef(null);
  const feesRef = useRef(null);

  useEffect(() => {
    if (focusAfter === null) return;
    setFocusAfter(null);
    const next = notPriced[Math.min(focusAfter, notPriced.length - 1)];
    const target = next
      ? createRefs.current.get(`${next.doctor_id}-${next.visit_type}`)
      : (notPricedRef.current ?? feesRef.current);
    target?.focus();
  }, [focusAfter, notPriced]);

  useEffect(() => {
    if (unpriced && !unpriced.rows.length && unpriced.total_doctors && npPage > 1) {
      setNpPage(Math.ceil(unpriced.total_doctors / unpriced.page_size));
    }
  }, [unpriced, npPage]);

  useEffect(() => {
    if (grid && grid.total && feePage > 1 && !grid.rows.some((r) => !r.is_default)) {
      setFeePage(Math.ceil(grid.total / grid.page_size));
    }
  }, [grid, feePage]);

  const missingDefaults = unpriced?.missing_defaults ?? [];
  const [params, setParams] = useSearchParams();
  const view = params.get("view") === "not-priced" && unpriced?.count ? "not-priced" : "fees";
  const showView = (next) =>
    setParams(
      (current) => {
        const copy = new URLSearchParams(current);
        if (next === "fees") copy.delete("view");
        else copy.set("view", next);
        return copy;
      },
      { replace: true },
    );

  const pickDoctor = (value) => {
    setDoctorId(value);
    setFeePage(1);
    setNpPage(1);
  };

  const categories = tree.filter((top) => top.code !== RESERVED);
  const labels = new Map(
    categories.flatMap((top) => [
      [top.code, top.label],
      ...top.sub_categories.map((sub) => [sub.code, sub.label]),
    ]),
  );
  const parentOf = (column) => labels.get(column.parent_code) ?? column.parent_code;
  const copyFrom = schemeCode && schemeCode !== RESERVED ? schemeCode : "";

  return (
    <div className="flow-root fset bill-ui cf-page">
      <div className="flow-card">
        <div className="fset__cardhead">
          <h2 className="flow-sec-title">Consultant fees</h2>
        </div>
        <div className="fset__cardsub">
          Each doctor's New and Follow Up fee for every category, and what the patient pays. Click a
          cell to change it. Greyed values are inherited — from the parent category, a wider rule or
          the base price — until the cell gets its own.
        </div>
        <div className="bill-form cf-filters">
          <Picker
            label="Doctor"
            value={doctorId}
            note={
              doctorsFailed
                ? "Could not load the doctors — the grid below still shows every doctor."
                : ""
            }
            onChange={(e) => pickDoctor(e.target.value)}
          >
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
            note={
              categoriesFailed
                ? "Could not load the categories — the grid below still shows every category."
                : ""
            }
            onChange={(e) => {
              setSchemeCode(e.target.value);
              setFeePage(1);
            }}
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

      {unpriced?.count ? (
        <div className="bill-views" role="group" aria-label="Consultant fees view">
          <button
            type="button"
            aria-pressed={view === "fees"}
            className={`bill-views__tab${view === "fees" ? " bill-views__tab--on" : ""}`}
            onClick={() => showView("fees")}
          >
            Fees
          </button>
          <button
            type="button"
            aria-pressed={view === "not-priced"}
            className={`bill-views__tab${view === "not-priced" ? " bill-views__tab--on" : ""}`}
            onClick={() => showView("not-priced")}
          >
            Not priced · {unpriced.count}
          </button>
        </div>
      ) : null}

      {view === "fees" && missingDefaults.length ? (
        <div className="flow-card cf-default-note" role="status">
          <span>
            The hospital default {missingDefaults.join(" and ")} fee is not set yet, so doctors
            without a fee of their own are billed nothing.
          </span>
          <button
            type="button"
            className="flow-btn flow-btn-primary flow-btn-mini"
            onClick={() => showView("not-priced")}
          >
            Set it now
          </button>
        </div>
      ) : null}

      {view === "not-priced" ? null : isError ? (
        <div className="flow-card fset__cardsub">Could not load the consultant fees.</div>
      ) : isLoading || !grid ? (
        <div className="flow-card fset__cardsub">Loading…</div>
      ) : (
        <div className="flow-card cf-fees">
          <div className="fset__cardhead">
            <h2 className="flow-sec-title" ref={feesRef} tabIndex={-1}>
              Fees
            </h2>
            <span className="fset__count">{grid.total}</span>
            <span className="flow-muted bill-rates__on">as of {grid.date}</span>
            <SearchBox
              label="Search doctor or item code"
              value={feeSearch}
              onChange={(value) => {
                setFeeSearch(value);
                setFeePage(1);
              }}
            />
          </div>
          {grid.rows.length ? (
            <div className="cf-legend" aria-hidden="true">
              <span className="cf-legend__item">
                <span className="cf-legend__swatch" /> Set for this category
              </span>
              <span className="cf-legend__item">
                <span className="cf-legend__swatch cf-legend__swatch--inherited" /> Inherited
              </span>
              <span className="cf-legend__item">Click a cell to change it</span>
            </div>
          ) : null}
          {!grid.rows.length ? (
            <div className="fset__cardsub">
              {feeQ
                ? "No doctor or item code matches that search."
                : doctorId
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
                        {isAdmin && !row.is_default && row.doctor_active !== false ? (
                          <button
                            type="button"
                            className="flow-btn flow-btn-ghost flow-btn-mini cf-grid__remove"
                            aria-label={`Delete doctor ${row.doctor_name}`}
                            onClick={() =>
                              setRemoving({ id: row.doctor_id, name: row.doctor_name })
                            }
                          >
                            Delete doctor
                          </button>
                        ) : null}
                      </th>
                      <td className="cf-grid__visit">
                        <span className="bill-tree__badge">{row.visit_type}</span>
                      </td>
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
          <Pagination
            page={feePage}
            pageSize={feePageSize}
            total={grid.total}
            onChange={setFeePage}
            onPageSizeChange={setFeePageSize}
            disabled={isFetching}
            unit="doctors"
          />
        </div>
      )}

      {view === "not-priced" ? (
        <NotPriced
          list={unpriced}
          doctors={notPriced}
          headingRef={notPricedRef}
          buttonRefs={createRefs}
          onCreate={setCreating}
          onRemove={isAdmin ? setRemoving : null}
          search={
            <SearchBox
              label="Search doctors without a fee"
              value={npSearch}
              onChange={(value) => {
                setNpSearch(value);
                setNpPage(1);
              }}
            />
          }
          paging={
            <Pagination
              page={npPage}
              pageSize={npPageSize}
              total={unpriced.total_doctors}
              onChange={setNpPage}
              onPageSizeChange={setNpPageSize}
              disabled={npFetching}
              unit="doctors"
            />
          }
        />
      ) : null}

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
          doctor={creating.doctor}
          onClose={() => setCreating(null)}
          onCreated={() => {
            setFocusAfter(creating.index);
            setCreating(null);
          }}
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
      {removing ? (
        <DeleteDoctorModal
          doctor={removing}
          onClose={() => setRemoving(null)}
          onDone={async () => {
            setRemoving(null);
            await queryClient.invalidateQueries();
          }}
        />
      ) : null}
    </div>
  );
}
