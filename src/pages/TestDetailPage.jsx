import { Fragment, useId, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import useAuthStore from "../stores/authStore";
import { CAPABILITIES, hasAnyCapability, hasCapability } from "../../shared/permissions.js";
import { ageBandText, fieldIssues, valueRangeText } from "../../shared/labCatalogRules.js";
import { formulaAsNames } from "../../shared/labFormula.js";
import { useLabCatalogHistory, useLabCatalogTest } from "../queries/hooks/useLabCatalog";
import "../styles/flow.css";
import "./flow/FlowSettings.css";
import "./billing/billingUi.css";
import "./TestCatalogPage.css";
import "./TestDetailPage.css";
import {
  AddField,
  FieldEditor,
  MoveButtons,
  RangesEditor,
  RemoveFieldButton,
  ReportBar,
  SetUpResults,
} from "./testDetail/ResultFieldsEditor";

const TABS = [
  { key: "details", label: "Details" },
  { key: "fields", label: "Result fields" },
  { key: "history", label: "History" },
];

const TYPE_LABEL = {
  numeric: "Number",
  text: "Text",
  select: "Pick list",
  calculated: "Calculated",
  group: "Heading",
};

const STATION_LABEL = { lab: "Lab", machine: "Machine" };

const ENTITY_LABEL = {
  link: "Result report link",
  report: "Report",
  field: "Field",
  ranges: "Ranges",
  order: "Field order",
};

const whenText = (at) =>
  new Date(at).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const TYPE_WORD = {
  numeric: "Number",
  text: "Text",
  select: "Pick list",
  group: "Heading",
};

const FIELD_WORD = {
  name: "Name",
  unit: "Unit",
  no_unit: "No unit",
  input_type: "Type",
  decimals: "Decimals",
  is_active: "Active",
  formula: "Formula",
  options: "Choices",
};

const nameOf = (names) => (id) => names?.[String(id)] || `field ${id}`;

function valueWord(key, value, names) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (key === "input_type") return TYPE_WORD[value] || value;
  if (key === "formula") return formulaAsNames(value, nameOf(names));
  if (Array.isArray(value)) return value.join(" / ");
  return String(value);
}

const rangeWords = (list) =>
  list?.length
    ? list
        .map(
          (r) =>
            `${r.gender} · ${ageBandText({
              minAgeDays: r.min_age_days,
              maxAgeDays: r.max_age_days,
            })} · ${valueRangeText({ min: r.min_value, max: r.max_value, text: r.text_range })}`,
        )
        .join("; ")
    : "none";

function movedWords(before, after, names) {
  const at = (list, id) => list.indexOf(id);
  const moved = after.find((id, i) => at(before, id) > i);
  return moved ? `Moved ${nameOf(names)(moved)} up` : "Changed the order";
}

function changeText(entry) {
  const before = entry.before || {};
  const after = entry.after || {};
  const subject = entry.subject || "a field";
  if (entry.entity === "link") {
    if (entry.action === "file_only") return "Marked: results come as a file";
    if (entry.action === "fields") return "Switched back to result fields";
    const how = entry.action === "backfill" ? " (automatic setup)" : "";
    return after.report
      ? `Linked to ${after.report}${how}`
      : `Unlinked from ${before.report || "its report"}`;
  }
  if (entry.entity === "report") return `Created report ${after.name || ""}`.trim();
  if (entry.entity === "order")
    return movedWords(before.order || [], after.order || [], entry.names);
  if (entry.entity === "ranges") {
    return `${subject}: ${rangeWords(before.ranges)} → ${rangeWords(after.ranges)}`;
  }
  if (entry.action === "create") {
    const type = after.formula ? "Calculated" : TYPE_WORD[after.input_type] || after.input_type;
    const unit = after.no_unit ? ", no unit" : after.unit ? `, ${after.unit}` : "";
    const formula = after.formula ? ` = ${formulaAsNames(after.formula, nameOf(entry.names))}` : "";
    return `Added ${after.name || subject} (${type}${unit})${formula}`;
  }
  if (entry.action === "remove") {
    const kept = after.kept_in_other_reports ? " — still used in other reports" : "";
    return `Removed ${subject} from ${before.report || "this report"}${kept}`;
  }
  if (entry.action === "required") {
    return `${subject}: Required ${valueWord("", before.is_required)} → ${valueWord("", after.is_required)}`;
  }
  const keys = Object.keys(FIELD_WORD).filter(
    (k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null),
  );
  if (!keys.length) return `${subject}: ${entry.action}`;
  return `${subject}: ${keys
    .map(
      (k) =>
        `${FIELD_WORD[k]} ${valueWord(k, before[k], entry.names)} → ${valueWord(k, after[k], entry.names)}`,
    )
    .join("; ")}`;
}

function RangeList({ ranges }) {
  const live = ranges.filter((r) => !r.pregnant);
  if (!live.length) return <span className="tdet__muted">No range</span>;
  return (
    <ul className="tdet__ranges">
      {live.map((r) => (
        <li key={r.id} className="tdet__range">
          <span className="tdet__sex">{r.gender}</span>
          <span className="tdet__band">{ageBandText(r)}</span>
          <strong className="tdet__value">{valueRangeText(r)}</strong>
          {r.minCritical != null || r.maxCritical != null ? (
            <span className="tdet__critical">
              critical{r.minCritical != null ? ` ≤ ${r.minCritical}` : ""}
              {r.maxCritical != null ? ` ≥ ${r.maxCritical}` : ""}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function FormulaCell({ formula }) {
  if (!formula) return <span className="tdet__muted">—</span>;
  const outside = formula.inputs.filter((i) => i.name && !i.inReport);
  return (
    <div>
      <code className="tdet__formula">{formula.text}</code>
      {outside.length ? (
        <div className="tdet__note">
          Uses {outside.map((i) => i.name).join(", ")} from another report — stays blank unless
          entered in the same save.
        </div>
      ) : null}
    </div>
  );
}

function FieldsTable({ report, canEdit }) {
  const [editing, setEditing] = useState(null);
  const toggle = (key) => setEditing((now) => (now === key ? null : key));
  const top = report.fields.filter((f) => f.depth === 0).map((f) => f.id);
  const columns = canEdit ? 9 : 8;
  const captionId = useId();
  return (
    <>
      <p className="tdet__caption" id={captionId}>
        Fields of {report.name}, in the order the lab enters and the report prints them
      </p>
      <div className="fset__scroll">
        <table className="flow-table tdet__table" aria-labelledby={captionId}>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Field</th>
              <th scope="col">Unit</th>
              <th scope="col">Type</th>
              <th scope="col">Decimals</th>
              <th scope="col">Reference ranges</th>
              <th scope="col">Formula</th>
              <th scope="col">Required</th>
              {canEdit ? <th scope="col">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {report.fields.map((f, i) => {
              const issues = fieldIssues(f);
              return (
                <Fragment key={f.id}>
                  <tr className={f.active ? "" : "tcat__retired"}>
                    <td data-label="#" className="tdet__num">
                      {i + 1}
                    </td>
                    <td data-label="Field">
                      <div className="tdet__name" style={{ paddingLeft: f.depth * 16 }}>
                        <strong>{f.name}</strong>
                        {f.active ? null : <span className="bill-tree__badge">Off</span>}
                      </div>
                      {f.alsoIn.length ? (
                        <div className="tdet__note">Also in: {f.alsoIn.join(", ")}</div>
                      ) : null}
                      {issues.map((issue) => (
                        <div key={issue.code} className="tdet__issue">
                          Needs attention: {issue.text}
                        </div>
                      ))}
                    </td>
                    <td data-label="Unit">
                      {["group", "text", "select"].includes(f.type) ? (
                        <span className="tdet__muted">—</span>
                      ) : f.unit ? (
                        f.unit
                      ) : f.noUnit ? (
                        <span className="tdet__muted">No unit</span>
                      ) : (
                        <span className="tdet__muted">Not set</span>
                      )}
                    </td>
                    <td data-label="Type">
                      {TYPE_LABEL[f.type] || f.type}
                      {f.type === "select" && f.options.length ? (
                        <div className="tdet__muted">{f.options.join(" / ")}</div>
                      ) : null}
                    </td>
                    <td data-label="Decimals" className="tdet__num">
                      {["numeric", "calculated"].includes(f.type) ? f.decimals : "—"}
                    </td>
                    <td data-label="Reference ranges">
                      {f.type === "group" ? (
                        <span className="tdet__muted">—</span>
                      ) : (
                        <RangeList ranges={f.ranges} />
                      )}
                    </td>
                    <td data-label="Formula">
                      <FormulaCell formula={f.formula} />
                    </td>
                    <td data-label="Required">
                      {f.required === null ? "—" : f.required ? "Yes" : "No"}
                    </td>
                    {canEdit ? (
                      <td data-label="Actions" className="tdet__rowactions">
                        {f.depth === 0 ? (
                          <MoveButtons
                            report={report}
                            field={f}
                            first={top[0] === f.id}
                            last={top[top.length - 1] === f.id}
                          />
                        ) : null}
                        <button
                          type="button"
                          className="flow-btn flow-btn-ghost flow-btn-mini"
                          aria-expanded={editing === `field:${f.id}`}
                          aria-label={`Edit ${f.name}`}
                          onClick={() => toggle(`field:${f.id}`)}
                        >
                          Edit
                        </button>
                        {f.type === "group" || f.type === "select" ? null : (
                          <button
                            type="button"
                            className="flow-btn flow-btn-ghost flow-btn-mini"
                            aria-expanded={editing === `ranges:${f.id}`}
                            aria-label={`Edit ranges of ${f.name}`}
                            onClick={() => toggle(`ranges:${f.id}`)}
                          >
                            Ranges
                          </button>
                        )}
                        <RemoveFieldButton report={report} field={f} />
                      </td>
                    ) : null}
                  </tr>
                  {editing === `field:${f.id}` ? (
                    <tr className="tdet__editrow">
                      <td colSpan={columns}>
                        <FieldEditor report={report} field={f} onDone={() => setEditing(null)} />
                      </td>
                    </tr>
                  ) : null}
                  {editing === `ranges:${f.id}` ? (
                    <tr className="tdet__editrow">
                      <td colSpan={columns}>
                        <RangesEditor field={f} onDone={() => setEditing(null)} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function FieldsTab({ test, canEdit }) {
  if (test.resultsAsFile || !test.report) return <SetUpResults test={test} canEdit={canEdit} />;
  if (!test.report.fields.length) {
    return (
      <>
        <ReportBar test={test} canEdit={canEdit} />
        <div className="tcat__empty">
          The linked report <strong>{test.report.name}</strong> has no fields yet.
          {canEdit ? " Add the first one below." : ""}
        </div>
        {canEdit ? <AddField report={test.report} /> : null}
      </>
    );
  }
  const attention = test.report.fields.filter((f) => fieldIssues(f).length).length;
  return (
    <>
      {attention ? (
        <div className="tcat__warn">
          <strong>
            {attention} field{attention === 1 ? " needs" : "s need"} attention.
          </strong>{" "}
          They are marked below{canEdit ? " — use Edit to fix them" : ""}.
        </div>
      ) : null}
      <ReportBar test={test} canEdit={canEdit} />
      <FieldsTable report={test.report} canEdit={canEdit} />
      {canEdit ? <AddField report={test.report} /> : null}
    </>
  );
}

function DetailsTab({ test, canSeeBilling }) {
  const results = test.resultsAsFile
    ? "Result is a file"
    : test.report
      ? `${test.report.fields.filter((f) => f.active).length} active fields in ${test.report.name}`
      : "Not set up";
  return (
    <dl className="tdet__facts">
      <dt>Name</dt>
      <dd>{test.name}</dd>
      <dt>Station</dt>
      <dd>{STATION_LABEL[test.station] || test.station}</dd>
      <dt>Status</dt>
      <dd>{test.active ? "Active" : "Retired"}</dd>
      <dt>What it is for</dt>
      <dd>{test.gloss || <span className="tdet__muted">Not written</span>}</dd>
      <dt>Billing item</dt>
      <dd>
        {test.serviceItemCode ? (
          canSeeBilling ? (
            <Link to={`/settings/services?q=${encodeURIComponent(test.serviceItemCode)}`}>
              {test.serviceItemCode}
            </Link>
          ) : (
            test.serviceItemCode
          )
        ) : (
          <span className="tdet__muted">None</span>
        )}
      </dd>
      <dt>Results</dt>
      <dd>{results}</dd>
      {test.report ? (
        <>
          <dt>Result report</dt>
          <dd>
            {test.report.name}
            {test.report.active ? null : <span className="bill-tree__badge">Off</span>}
            {test.report.aliases.length ? (
              <div className="tdet__muted">Also known as: {test.report.aliases.join(", ")}</div>
            ) : null}
          </dd>
        </>
      ) : null}
    </dl>
  );
}

function HistoryTab({ catalogId }) {
  const history = useLabCatalogHistory(catalogId);
  if (history.isLoading) return <div className="tcat__empty">Loading the history…</div>;
  if (history.isError) {
    return (
      <div className="tcat__empty" role="alert">
        Unable to load the history.{" "}
        <button type="button" className="tcat__warnlink" onClick={() => history.refetch()}>
          Try again
        </button>
      </div>
    );
  }
  if (!history.data.length) {
    return <div className="tcat__empty">No changes have been recorded for this test yet.</div>;
  }
  return (
    <div className="fset__scroll">
      <table className="flow-table tdet__table">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Who</th>
            <th scope="col">What</th>
            <th scope="col">Change</th>
          </tr>
        </thead>
        <tbody>
          {history.data.map((h) => (
            <tr key={h.id}>
              <td data-label="When">{whenText(h.at)}</td>
              <td data-label="Who">
                {h.actor || (h.action === "backfill" ? "System (setup)" : "—")}
              </td>
              <td data-label="What">{ENTITY_LABEL[h.entity] || h.entity}</td>
              <td data-label="Change">{changeText(h)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function TestDetailPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tabsId = useId();
  const doctor = useAuthStore((s) => s.currentDoctor);
  const canSeeBilling = hasCapability(doctor, CAPABILITIES.BILLING_MASTER);
  const canEdit = hasAnyCapability(doctor, [CAPABILITIES.ADMIN, CAPABILITIES.LAB_TEST_CATALOG]);
  const tab = TABS.some((t) => t.key === params.get("tab")) ? params.get("tab") : "fields";
  const { data: test, isLoading, isError, error, refetch } = useLabCatalogTest(id);

  const back = (
    <Link to="/settings/tests" className="tdet__back">
      <ChevronLeft size={14} aria-hidden="true" /> Test catalogue
    </Link>
  );

  if (isLoading) {
    return (
      <div className="flow-root fset bill-ui tcat">
        <div className="flow-card bill-stack">
          {back}
          <div className="tcat__empty">Loading the test…</div>
        </div>
      </div>
    );
  }

  if (isError) {
    const missing = error?.response?.status === 404;
    return (
      <div className="flow-root fset bill-ui tcat">
        <div className="flow-card bill-stack">
          {back}
          <div className="tcat__empty" role="alert">
            {missing ? (
              "This test is not in the catalogue. It may have been removed — go back to the list."
            ) : (
              <>
                Unable to load this test.{" "}
                <button type="button" className="tcat__warnlink" onClick={() => refetch()}>
                  Try again
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flow-root fset bill-ui tcat">
      <div className="flow-card bill-stack">
        {back}
        <div className="fset__cardhead">
          <h2 className="flow-sec-title">{test.name}</h2>
          <span className="fset__count">{STATION_LABEL[test.station] || test.station}</span>
          {test.active ? null : <span className="bill-tree__badge">Retired</span>}
        </div>
        <div className="fset__cardsub">
          What this test reports: its fields, units, reference ranges and formulas. Changes reach
          the lab's Enter results form the next time it opens; saved results never change.
        </div>
        <div className="set__tabs tdet__tabs" role="tablist" aria-label="Test sections">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`${tabsId}-${t.key}`}
              aria-selected={t.key === tab}
              aria-controls={`${tabsId}-panel`}
              className={`set__tab${t.key === tab ? " set__tab--on" : ""}`}
              onClick={() => setParams({ tab: t.key }, { replace: true })}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`}>
          {tab === "details" ? (
            <DetailsTab test={test} canSeeBilling={canSeeBilling} />
          ) : tab === "history" ? (
            <HistoryTab catalogId={test.id} />
          ) : (
            <FieldsTab test={test} canEdit={canEdit} />
          )}
        </div>
      </div>
    </div>
  );
}
