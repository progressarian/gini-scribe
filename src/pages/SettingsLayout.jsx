import { NavLink, Outlet, useLocation } from "react-router-dom";
import "./SettingsLayout.css";

// One place for the clinic's settings instead of a page per setting. The tabs
// are routes, not local state, so a tab is linkable, the back button works, and
// each panel keeps the lazyWithRetry chunking every other page has.
//
// Adding a section is two lines here and one route in router.jsx — the shell
// takes no interest in what a panel does.
export const SETTINGS_TABS = [
  {
    to: "/settings/flow",
    label: "Patient Flow",
    blurb: "Visit-time benchmarks and the journey steps · changes apply to new check-ins",
  },
  {
    to: "/settings/prescription",
    label: "Prescription",
    blurb:
      "Hospital identity, letterhead logo, and the strip printed at the foot of every prescription",
  },
  {
    to: "/settings/tests",
    label: "Test catalogue",
    blurb: "What the floor can order and what reception charges for it",
  },
  {
    to: "/settings/schemes",
    label: "Patient schemes",
    blurb: "CGHS, ECHS and the rest — their labels, their card requirement, and the daily cap",
  },
];

export default function SettingsLayout() {
  const { pathname } = useLocation();
  const active = SETTINGS_TABS.find((t) => pathname.startsWith(t.to));

  return (
    <div className="set">
      <header className="set__head">
        <h1 className="set__title">⚙️ Scribe Settings</h1>
        {active?.blurb ? <p className="set__blurb">{active.blurb}</p> : null}
      </header>

      <nav className="set__tabs" aria-label="Settings sections">
        {SETTINGS_TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            className={({ isActive }) => `set__tab${isActive ? " set__tab--on" : ""}`}
          >
            {t.label}
          </NavLink>
        ))}
      </nav>

      <div className="set__panel">
        <Outlet />
      </div>
    </div>
  );
}
