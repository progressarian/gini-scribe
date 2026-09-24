import { useEffect, useRef } from "react";
import { Navigate, NavLink, Outlet, useLocation } from "react-router-dom";
import useAuthStore from "../stores/authStore";
import { PAGE_CAPABILITIES } from "../config/routes";
import { hasAnyCapability } from "../../shared/permissions";
import DeskRequestsBadge from "../components/billing/DeskRequestsBadge";
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
  },
  {
    to: "/settings/prescription",
    label: "Prescription",
  },
  {
    to: "/settings/tests",
    label: "Test catalogue",
  },
  {
    to: "/settings/schemes",
    label: "Categories",
  },
  {
    to: "/settings/services",
    label: "Services",
  },
  {
    to: "/settings/category-rates",
    label: "Category rates",
  },
  {
    to: "/settings/consultant-fees",
    label: "Consultant fees",
  },
  {
    to: "/settings/discounts",
    label: "Discounts",
  },
  {
    to: "/settings/desk-requests",
    label: "Desk requests",
    Badge: DeskRequestsBadge,
  },
  {
    to: "/settings/bulk-import",
    label: "Bulk import",
  },
  {
    to: "/settings/billing",
    label: "Billing settings",
  },
];

export const visibleSettingsTabs = (role) =>
  SETTINGS_TABS.filter((t) => hasAnyCapability(role, PAGE_CAPABILITIES[t.to]));

export default function SettingsLayout() {
  const { pathname } = useLocation();
  const role = useAuthStore((s) => s.currentDoctor?.role);
  const tabs = visibleSettingsTabs(role);
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
      <nav className="set__tabs" aria-label="Settings sections" ref={tabsRef}>
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            className={({ isActive }) => `set__tab${isActive ? " set__tab--on" : ""}`}
          >
            {t.label}
            {t.Badge ? <t.Badge /> : null}
          </NavLink>
        ))}
      </nav>

      <div className="set__panel">
        <Outlet />
      </div>
    </div>
  );
}
