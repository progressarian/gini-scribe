import { useBillingNotPriced, useSetBillingItemActive } from "../../queries/hooks/useBillingMaster";
import { toast } from "../../stores/uiStore";
import { errorOf, rupees } from "./format";

const REPORT_STATUS = {
  not_in_catalogue: "Not in the test catalogue",
  retired_in_catalogue: "Retired in the test catalogue",
};

function RowAction({ row, label, onCreate }) {
  const activate = useSetBillingItemActive();
  if (row.status === "item_deactivated") {
    return (
      <button
        type="button"
        className="flow-btn flow-btn-ghost flow-btn-mini"
        aria-label={`Activate item ${row.item_code} for ${label}`}
        disabled={activate.isPending}
        onClick={async () => {
          try {
            await activate.mutateAsync({ id: row.item_id, is_active: true });
            toast(`Activated ${row.item_code}`, "success");
          } catch (e) {
            toast(errorOf(e), "error");
          }
        }}
      >
        Activate {row.item_code}
      </button>
    );
  }
  return (
    <button
      type="button"
      className="flow-btn flow-btn-primary flow-btn-mini"
      aria-label={`Create item for ${label}`}
      onClick={onCreate}
    >
      Create item
    </button>
  );
}

export default function NotPricedPanel({ onCreate }) {
  const { data, isLoading, isError } = useBillingNotPriced();

  if (isLoading) return <div className="flow-card fset__cardsub">Loading…</div>;
  if (isError) return <div className="flow-card fset__cardsub">Could not load the list.</div>;

  const { tests, consultants, reportsNotInCatalogue } = data;

  return (
    <div className="bill-notpriced">
      <section className="flow-card" aria-label="Tests without an item">
        <div className="fset__cardhead">
          <h2 className="flow-sec-title">Tests without an item</h2>
          <span className="fset__count">{tests.length}</span>
        </div>
        <div className="fset__cardsub">
          Catalogue tests the floor can order but billing has no item for yet.
        </div>
        {!tests.length ? (
          <div className="fset__cardsub">Every catalogue test has an item.</div>
        ) : (
          <div className="fset__scroll">
            <table className="flow-table" aria-label="Tests without an item">
              <thead>
                <tr>
                  <th>Test</th>
                  <th>Category</th>
                  <th>Catalogue price</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tests.map((t) => (
                  <tr key={t.test_catalog_id}>
                    <td>{t.test_name}</td>
                    <td>{t.category}</td>
                    <td>{t.catalogue_price === null ? "—" : rupees(t.catalogue_price)}</td>
                    <td>{t.status === "no_item" ? "No item" : `${t.item_code} is off`}</td>
                    <td>
                      <RowAction
                        row={t}
                        label={t.test_name}
                        onCreate={() =>
                          onCreate({
                            name: t.test_name,
                            kind: "test",
                            test_catalog_id: t.test_catalog_id,
                            base_price: t.catalogue_price,
                          })
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flow-card" aria-label="Consultants without a fee">
        <div className="fset__cardhead">
          <h2 className="flow-sec-title">Consultants without a fee</h2>
          <span className="fset__count">{consultants.length}</span>
        </div>
        <div className="fset__cardsub">
          Consultants with no consultation item of their own for a visit type. Where the hospital
          default covers them, their visits are billed at the default fee meanwhile.
        </div>
        {!consultants.length ? (
          <div className="fset__cardsub">Every consultant has a fee for each visit type.</div>
        ) : (
          <div className="fset__scroll">
            <table className="flow-table" aria-label="Consultants without a fee">
              <thead>
                <tr>
                  <th>Consultant</th>
                  <th>Visit type</th>
                  <th>Billed meanwhile</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {consultants.map((c) => {
                  const label = `${c.name} (${c.visit_type})`;
                  return (
                    <tr key={`${c.doctor_id}-${c.visit_type}`}>
                      <td>{c.name}</td>
                      <td>{c.visit_type}</td>
                      <td>{c.default_covers ? "Hospital default fee" : "Nothing — no fee"}</td>
                      <td>{c.status === "no_item" ? "No item" : `${c.item_code} is off`}</td>
                      <td>
                        <RowAction
                          row={c}
                          label={label}
                          onCreate={() =>
                            onCreate({
                              name: `Consultation — ${c.name} (${c.visit_type})`,
                              kind: "consultation",
                              doctor_id: c.doctor_id,
                              visit_type: c.visit_type,
                            })
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flow-card" aria-label="Lab reports not in the catalogue">
        <div className="fset__cardhead">
          <h2 className="flow-sec-title">Lab reports not in the catalogue</h2>
          <span className="fset__count">{reportsNotInCatalogue.length}</span>
        </div>
        <div className="fset__cardsub">
          These can't be priced until the test is in the test catalogue. Where one looks like a test
          already there, add the name as an alias of that test instead of a second test that could
          be billed twice.
        </div>
        {!reportsNotInCatalogue.length ? (
          <div className="fset__cardsub">Every lab report is in the catalogue.</div>
        ) : (
          <div className="fset__scroll">
            <table className="flow-table" aria-label="Lab reports not in the catalogue">
              <thead>
                <tr>
                  <th>Report</th>
                  <th>Possibly the same as</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {reportsNotInCatalogue.map((r) => (
                  <tr key={r.name}>
                    <td>{r.name}</td>
                    <td>{r.possibly_same_as.length ? r.possibly_same_as.join(", ") : "—"}</td>
                    <td>{REPORT_STATUS[r.status] ?? r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
