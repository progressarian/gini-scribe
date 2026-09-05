import { useQuery } from "@tanstack/react-query";
import api from "../../services/api";
import "../../styles/giniflow-station.css";

// Every station a person can open, with what is waiting at each. The summary is
// filtered server-side by capability and always returns a value for a station
// the role may open, so a missing key means "not yours" and the tile is left out
// entirely — a nurse sees vitals and the board, a coordinator holding every desk
// sees all of them from one screen.
//
// Stations not built yet still appear, greyed with "Coming soon": the floor
// should be able to see what is coming.
const STATIONS = [
  {
    key: "triage",
    icon: "🗂",
    name: "Triage",
    desc: "Tomorrow's list · reports in · categorise · assign",
    href: "/giniflow/triage",
  },
  {
    key: "manager",
    icon: "🗺",
    name: "Flow Coordinator",
    desc: "Real-time floor view · patient tracking · bottleneck alerts",
    href: "/giniflow/manager",
  },
  {
    key: "vitals",
    icon: "⚖️",
    name: "Vitals Station",
    desc: "Weight · BP · pulse · SpO2 · voice entry",
    href: "/giniflow/station/vitals",
  },
  {
    key: "reception",
    icon: "🏥",
    name: "Reception",
    desc: "Test orders from MO · payment collection · trigger lab sample",
    href: "/giniflow/station/reception",
  },
  {
    key: "lab",
    icon: "🧪",
    name: "Lab Station",
    desc: "Sample queue · processing · upload results",
    href: "/giniflow/station/lab",
  },
  {
    key: "mo_sd",
    icon: "👨‍⚕️",
    name: "MO / SD",
    desc: "Workup · plan · order tests · ready for doctor",
    href: "/giniflow/station/mo",
  },
  {
    key: "doctor",
    icon: "🧑‍⚕️",
    name: "Consultant",
    desc: "Brief · labs · prescription · plan",
    href: "/giniflow/station/doctor",
  },
  {
    key: "rx",
    icon: "🗒️",
    name: "Prescription Explain",
    desc: "Explain the prescription · print for the patient · send to pharmacy",
    href: "/giniflow/station/rx",
  },
  {
    key: "pharmacy",
    icon: "💊",
    name: "Pharmacy",
    desc: "Dispense · patient counselling · exit confirmation",
    href: "/giniflow/station/pharmacy",
  },
  {
    key: "referrals",
    icon: "↗",
    name: "Referrals",
    desc: "Today's external referrals · generate referral letters · track specialist follow-up",
    href: "/giniflow/station/referrals",
  },
];

const TONE = {
  red: { background: "rgba(220,38,38,.2)", color: "#fca5a5" },
  blue: { background: "rgba(37,99,235,.2)", color: "#93c5fd" },
  teal: { background: "rgba(13,148,136,.2)", color: "#5dd6ca" },
};

export default function StationsLauncherPage() {
  const { data, isPending } = useQuery({
    queryKey: ["giniflow", "stations", "summary"],
    queryFn: async () => (await api.get("/api/giniflow/stations/summary")).data,
    refetchInterval: 20_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });

  const stations = data?.stations || {};
  const visible = STATIONS.filter((s) => stations[s.key] || !s.href);
  const today = new Date().toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return (
    <div className="gf gf-land">
      <div className="land-logo">Gini Flow</div>
      <div className="land-sub">Choose your station · {today}</div>

      {data?.bottleneck && (
        <div className="land-alert">
          🚨 Bottleneck right now: <strong>{data.bottleneck.label}</strong>
        </div>
      )}

      {isPending ? (
        <div className="land-sub">Loading your stations…</div>
      ) : visible.length === 0 ? (
        <div className="land-sub">
          No stations are assigned to your role yet — ask an admin for access.
        </div>
      ) : (
        <div className="role-grid">
          {visible.map((s) => {
            const live = stations[s.key];
            const body = (
              <>
                <div className="rc-ico">{s.icon}</div>
                <div className="rc-name">{s.name}</div>
                <div className="rc-desc">{s.desc}</div>
                {s.href ? (
                  <div className="rc-count" style={TONE[live.tone] || TONE.teal}>
                    {live.label}
                  </div>
                ) : (
                  <div className="rc-count rc-soon">Coming soon</div>
                )}
              </>
            );
            return s.href ? (
              <a className="role-card" key={s.key} href={s.href}>
                {body}
              </a>
            ) : (
              <div className="role-card is-disabled" key={s.key} aria-disabled="true">
                {body}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
