import usePagedList from "./usePagedList.js";
import ListPager from "../ListPager.jsx";
import ReferralStatusControl from "../ReferralStatusControl.jsx";
import { SearchField, FilterSelect, ListStatus, ListBody } from "./ListToolbar.jsx";
import { hasFilters } from "./options.js";
import {
  REFERRAL_STATUSES,
  URGENCIES,
  urgencyLabel,
  referralStatusLabel,
} from "../../../../shared/crmVocab.js";

const FILTER_KEYS = ["q", "status", "urgency"];
const URGENCY_OPTIONS = URGENCIES.map((u) => ({ value: u.value, label: u.label }));

export default function ReferralsList({ filters, onChange, refreshKey, onChanged }) {
  const list = usePagedList("/api/crm/referrals", filters, refreshKey, "Unable to load referrals.");
  const { data, loading } = list;
  const update = (patch) => onChange({ ...filters, ...patch, page: 1 });
  const clear = () => update({ q: "", status: "", urgency: "" });
  const active = hasFilters(filters, FILTER_KEYS);
  const byStatus = data?.counts?.by_status || {};
  const statusOptions = REFERRAL_STATUSES.filter(
    (s) => byStatus[s.value] || s.value === filters.status,
  ).map((s) => ({ value: s.value, label: `${s.label} (${byStatus[s.value] || 0})` }));

  return (
    <section className="home__panel" aria-label="Open referrals">
      <div className="asg__filters">
        <SearchField
          value={filters.q}
          onSearch={(q) => update({ q })}
          label="Search referrals"
          placeholder="Search by patient name, phone, referral code or doctor"
        />
        <FilterSelect
          label="Status"
          value={filters.status}
          onChange={(status) => update({ status })}
          allLabel="All open statuses"
          options={statusOptions}
        />
        <FilterSelect
          label="Urgency"
          value={filters.urgency}
          onChange={(urgency) => update({ urgency })}
          allLabel="Any urgency"
          options={URGENCY_OPTIONS}
        />
      </div>
      <ListStatus {...list} noun="referral" active={active} onClear={clear} />
      <ListBody
        data={data}
        loading={loading}
        active={active}
        onClear={clear}
        empty="No open referrals. Log one from a doctor's page."
        filteredEmpty="No open referrals match these filters."
      >
        {data?.rows.map((r) => (
          <li key={r.id} className="rep__row rep__row--stack">
            <div className="rep__row-main">
              <strong>{r.patient_name_raw || r.patient_phone_raw || "Unnamed patient"}</strong>
              <span className="rep__row-sub">
                {r.referral_code} · from {r.doctor_name || "—"}
                {r.service_line_name ? ` · ${r.service_line_name}` : ""}
              </span>
              <span className="rep__row-flags">
                {r.urgency !== "routine" && (
                  <span className="rep__due rep__due--red">{urgencyLabel(r.urgency)}</span>
                )}
                <span className="rep__flag">{referralStatusLabel(r.status)}</span>
              </span>
            </div>
            <ReferralStatusControl referral={r} onChanged={onChanged} />
          </li>
        ))}
      </ListBody>
      <ListPager
        page={data?.page}
        pages={data?.pages}
        loading={loading}
        onPage={(page) => onChange({ ...filters, page })}
      />
    </section>
  );
}
