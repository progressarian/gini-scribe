import { useEffect, useRef } from "react";
import { Navigate, NavLink, Outlet, useLocation } from "react-router-dom";
import useAuthStore from "../stores/authStore";
import { PAGE_CAPABILITIES } from "../config/routes";
import { hasAnyCapability } from "../../shared/permissions";
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
    label: "Categories",
    blurb:
      "CGHS, ECHS and the rest — sub-categories, payer, referral and card needs, the daily cap and who belongs",
  },
  {
    to: "/settings/services",
    label: "Services",
    blurb: "Groups, subgroups and the items the hospital bills for, with their prices",
  },
  {
    to: "/settings/category-rates",
    label: "Category rates",
    blurb: "What each category pays for each service, and the code printed on its bill",
  },
  {
    to: "/settings/bulk-import",
    label: "Bulk import",
    blurb: "Upload the Excel template to add or update services, categories and rates in one go",
  },
  {
    to: "/settings/billing",
    label: "Billing settings",
    blurb: "Discount stacking, pay later, GST and the bill number series",
  },
];

export const visibleSettingsTabs = (role) =>
  SETTINGS_TABS.filter((t) => hasAnyCapability(role, PAGE_CAPABILITIES[t.to]));

export default function SettingsLayout() {
  const { pathname } = useLocation();
  const role = useAuthStore((s) => s.currentDoctor?.role);
  const tabs = visibleSettingsTabs(role);
  const active = tabs.find((t) => pathname.startsWith(t.to));
  const tabsRef = useRef(null);

  useEffect(() => {
    tabsRef.current
      ?.querySelector(".set__tab--on")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  if (pathname.replace(/\/$/, "") === "/settings") {
    return tabs.length ? <Navigate to={tabs[0].to} replace /> : <Navigate to="/" replace />;
  }

  return (
    <div className="set">
      <header className="set__head">
        <h1 className="set__title">⚙️ Scribe Settings</h1>
        {active?.blurb ? <p className="set__blurb">{active.blurb}</p> : null}
      </header>

      <nav className="set__tabs" aria-label="Settings sections" ref={tabsRef}>
        {tabs.map((t) => (
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
