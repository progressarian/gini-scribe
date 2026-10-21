import { useId, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import DeskRequestsPage from "../../pages/billing/DeskRequestsPage";
import TestCancellationsPage from "../../pages/billing/TestCancellationsPage";
import useDeskRequestsLive from "../../queries/hooks/useDeskRequestsLive";
import { useApprovalsWaiting } from "../../queries/hooks/useApprovals";
import { useRequestFilters } from "./RequestFilters";
import "../../pages/SettingsLayout.css";
import "./deskRequestsInbox.css";

export const INBOX_TABS = {
  desk: { key: "desk", label: "Billing requests" },
  tests: { key: "tests", label: "Test cancellations" },
};

export default function DeskRequestsInbox({ param = "tab", live = true, defaultStatus }) {
  useDeskRequestsLive(live);
  const [params, setParams] = useSearchParams();
  const waiting = useApprovalsWaiting();
  const baseId = useId();
  const tabsRef = useRef(null);
  const filters = useRequestFilters({ status: defaultStatus });
  const tabs = [
    waiting.desk && { ...INBOX_TABS.desk, count: waiting.deskCount },
    waiting.tests && { ...INBOX_TABS.tests, count: waiting.testsCount },
  ].filter(Boolean);
  if (!tabs.length) return null;
  const requested = params.get(param);
  const current = tabs.find((t) => t.key === requested) ?? tabs[0];
  const tabId = (key) => `${baseId}-${key}`;
  const panelId = `${baseId}-panel`;

  const choose = (key) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set(param, key);
        return next;
      },
      { replace: true },
    );

  const onKeyDown = (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const index = tabs.findIndex((t) => t.key === current.key);
    const next = tabs[(index + step + tabs.length) % tabs.length];
    choose(next.key);
    tabsRef.current?.querySelector(`#${CSS.escape(tabId(next.key))}`)?.focus();
  };

  const page =
    current.key === INBOX_TABS.tests.key ? (
      <TestCancellationsPage live={false} filters={filters} />
    ) : (
      <DeskRequestsPage live={false} filters={filters} />
    );

  return (
    <div className="dri">
      {tabs.length > 1 ? (
        <div
          className="set__tabs dri__tabs"
          role="tablist"
          aria-label="Desk requests"
          ref={tabsRef}
          onKeyDown={onKeyDown}
        >
          {tabs.map((t) => {
            const on = t.key === current.key;
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                id={tabId(t.key)}
                aria-selected={on}
                aria-controls={panelId}
                tabIndex={on ? 0 : -1}
                className={`set__tab dri__tab${on ? " set__tab--on" : ""}`}
                onClick={() => choose(t.key)}
              >
                {t.label}
                <span
                  className={`set__tab-badge${t.count ? "" : " dri__zero"}`}
                  aria-label={`${t.count} waiting`}
                >
                  {t.count}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div
        id={panelId}
        role={tabs.length > 1 ? "tabpanel" : undefined}
        aria-labelledby={tabs.length > 1 ? tabId(current.key) : undefined}
        className="dri__panel"
      >
        {page}
      </div>
    </div>
  );
}
