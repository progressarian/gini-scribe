import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";

const MENU_WIDTH = 230;
const CLOSE_DELAY_MS = 200;

const canHover = () => window.matchMedia?.("(hover: hover) and (pointer: fine)").matches;
const EDGE = 8;

export const isOnPath = (item, pathname) =>
  item.match
    ? item.match(pathname)
    : item.path === "/"
      ? pathname === "/"
      : pathname === item.path || pathname.startsWith(`${item.path}/`);

function Count({ value, alert, label }) {
  if (!value) return null;
  return (
    <span className={`tab-count${alert ? " tab-count--alert" : ""}`} aria-label={label}>
      {value > 99 ? "99+" : value}
    </span>
  );
}

const tabButtonClass = (active) =>
  `tab-btn tab-menu-btn ${active ? "tab-btn--active" : "tab-btn--inactive"}`;

export default function NavMenu({
  label,
  items,
  navState = {},
  pathname,
  buttonClass = tabButtonClass,
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const focusOnOpen = useRef(false);
  const hoverOpened = useRef(false);
  const closeTimer = useRef(null);
  const menuId = useId();
  const active = items.some((item) => isOnPath(item, pathname));
  const counts = items.map((item) => (item.count ? item.count(navState) : 0));
  const total = counts.reduce((sum, value) => sum + value, 0);
  const alert = items.some((item, index) => item.countLabel && counts[index] > 0);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) hoverOpened.current = false;
  }, [open]);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  const hoverIn = () => {
    if (!canHover()) return;
    clearTimeout(closeTimer.current);
    if (!open) {
      hoverOpened.current = true;
      setOpen(true);
    }
  };

  const hoverOut = () => {
    if (!canHover()) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const left = Math.max(EDGE, Math.min(rect.left, window.innerWidth - MENU_WIDTH - EDGE));
    setPlace({ top: rect.bottom + 4, left });
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const outside = (e) => {
      if (!menuRef.current?.contains(e.target) && !buttonRef.current?.contains(e.target)) {
        setOpen(false);
      }
    };
    const key = (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const close = () => setOpen(false);
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  const focusItem = (step) => {
    const links = [...(menuRef.current?.querySelectorAll("a") ?? [])];
    if (!links.length) return;
    const at = links.indexOf(document.activeElement);
    const next = at < 0 ? (step < 0 ? links.length - 1 : 0) : at + step;
    links[(next + links.length) % links.length].focus();
  };

  useEffect(() => {
    if (!open || !place || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    focusItem(1);
  }, [open, place]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={buttonClass(active)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          if (hoverOpened.current) {
            hoverOpened.current = false;
            setOpen(true);
            return;
          }
          setOpen((was) => !was);
        }}
        onMouseEnter={hoverIn}
        onMouseLeave={hoverOut}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            focusOnOpen.current = true;
            setOpen(true);
          }
        }}
      >
        {label}
        <Count value={total} alert={alert} label={alert ? `${total} waiting` : undefined} />
        <span className="tab-menu-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && place ? (
        <div
          ref={menuRef}
          id={menuId}
          className="tab-menu"
          role="menu"
          aria-label={label}
          style={{ top: place.top, left: place.left, width: MENU_WIDTH }}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              focusItem(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              focusItem(-1);
            }
          }}
        >
          {items.map((item, index) => (
            <NavLink
              key={item.path}
              to={item.path}
              role="menuitem"
              className={`tab-menu-item${isOnPath(item, pathname) ? " tab-menu-item--active" : ""}`}
              aria-current={isOnPath(item, pathname) ? "page" : undefined}
              onClick={() => setOpen(false)}
            >
              <span>{item.label}</span>
              <Count
                value={counts[index]}
                alert={Boolean(item.countLabel)}
                label={item.countLabel?.(counts[index])}
              />
            </NavLink>
          ))}
        </div>
      ) : null}
    </>
  );
}
