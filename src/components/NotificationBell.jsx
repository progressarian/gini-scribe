import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell } from "lucide-react";
import AnchoredPopover from "./ui/AnchoredPopover";
import { useMarkNotificationsRead, useNotifications } from "../queries/hooks/useNotifications";
import "./NotificationBell.css";

const SEVERITY_LABEL = { critical: "Urgent", warning: "Attention", info: "Info" };

const ago = (value) => {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
};

export default function NotificationBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);
  const query = useNotifications();
  const markRead = useMarkNotificationsRead();
  const rows = query.data?.rows ?? [];
  const unread = query.data?.unread ?? 0;

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onDown = (e) => {
      if (!panelRef.current?.contains(e.target) && !buttonRef.current?.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const openItem = (n) => {
    if (!n.read) markRead.mutate({ ids: [Number(n.id)] });
    setOpen(false);
    if (n.link) navigate(n.link);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="notif-bell"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        onClick={() => setOpen((was) => !was)}
      >
        <Bell size={16} aria-hidden="true" />
        {unread ? (
          <span className="notif-bell__count" aria-hidden="true">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <AnchoredPopover anchorRef={buttonRef} popoverRef={panelRef} align="right" width={360}>
          <div className="notif-panel" role="dialog" aria-label="Notifications">
            <div className="notif-panel__head">
              <h2 className="notif-panel__title">Notifications</h2>
              <button
                type="button"
                className="notif-panel__all"
                disabled={!unread || markRead.isPending}
                onClick={() => markRead.mutate({ all: true })}
              >
                Mark all read
              </button>
            </div>
            {query.isError ? (
              <p className="notif-panel__empty" role="alert">
                Could not load notifications.{" "}
                <button type="button" className="notif-panel__all" onClick={() => query.refetch()}>
                  Try again
                </button>
              </p>
            ) : query.isLoading ? (
              <p className="notif-panel__empty" role="status">
                Loading…
              </p>
            ) : !rows.length ? (
              <p className="notif-panel__empty">Nothing needs your attention.</p>
            ) : (
              <ul className="notif-panel__list">
                {rows.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      className={`notif-item notif-item--${n.severity}${n.read ? "" : " is-unread"}`}
                      onClick={() => openItem(n)}
                    >
                      <span className="notif-item__meta">
                        <span className={`notif-item__sev notif-item__sev--${n.severity}`}>
                          {SEVERITY_LABEL[n.severity]}
                        </span>
                        <span>{ago(n.updated_at)}</span>
                        {n.read ? null : <span className="notif-item__new">New</span>}
                      </span>
                      <span className="notif-item__title">{n.title}</span>
                      {n.body ? <span className="notif-item__body">{n.body}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </AnchoredPopover>
      ) : null}
    </>
  );
}
