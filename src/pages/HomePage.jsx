import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { makeNavClick } from "../lib/navClick";
import useAuthStore from "../stores/authStore.js";
import usePatientStore from "../stores/patientStore.js";
import useVisitStore from "../stores/visitStore.js";
import useUiStore from "../stores/uiStore.js";
import useMessagingStore from "../stores/messagingStore.js";
import useAlertStore from "../stores/alertStore.js";
import useRefillStore from "../stores/refillStore.js";
import useDoseChangeStore from "../stores/doseChangeStore.js";
import Shimmer from "../components/Shimmer.jsx";
import "./HomePage.css";

export default function HomePage() {
  const navigate = useNavigate();
  const navClick = makeNavClick(navigate);
  const { currentDoctor } = useAuthStore();
  const { loadPatientDB, newPatient } = usePatientStore();
  const {
    appointments,
    todayAppointments,
    todayApptLoading,
    todayApptTotal,
    setShowBooking,
    setBookForm,
    setEditApptId,
    fetchTodayAppointments,
  } = useVisitStore();
  const { setShowSearch } = useUiStore();
  const { unreadCount, inbox, inboxLoading, setActiveThread, fetchInbox, fetchThread, markRead } =
    useMessagingStore();
  const { alerts, alertsLoading, fetchAlerts } = useAlertStore();
  const {
    requests: refills,
    loading: refillsLoading,
    fetchPending: fetchRefills,
    updateStatus: updateRefillStatus,
  } = useRefillStore();
  const {
    requests: doseRequests,
    loading: doseLoading,
    fetchPending: fetchDoseRequests,
  } = useDoseChangeStore();

  useEffect(() => {
    fetchTodayAppointments();
    fetchInbox();
    fetchAlerts();
    fetchRefills();
    fetchDoseRequests();
  }, [fetchTodayAppointments, fetchInbox, fetchAlerts, fetchRefills, fetchDoseRequests]);

  return (
    <div className="home">
      {/* Welcome bar */}
      <div className="home__welcome">
        <div>
          <div className="home__greeting">
            {(() => {
              const h = new Date().getHours();
              const greeting = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
              return `${greeting}${currentDoctor ? `, ${currentDoctor.short_name || currentDoctor.name}` : ""}`;
            })()}
          </div>
          <div className="home__date">
            {new Date().toLocaleDateString("en-IN", {
              weekday: "long",
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </div>
        </div>
        <button
          onClick={() => {
            fetchTodayAppointments();
            fetchInbox();
            fetchAlerts();
            fetchRefills();
            fetchDoseRequests();
          }}
          className="home__refresh-btn"
        >
          ↻ Refresh
        </button>
      </div>

      {/* Stats Strip */}
      <div className="home__stats">
        {[
          {
            label: "Seen Today",
            value: todayAppointments.filter((a) => a.status === "completed").length,
            icon: "\u2705",
            color: "#059669",
            bg: "#f0fdf4",
            border: "#bbf7d0",
          },
          {
            label: "Total Appointments",
            value: todayApptTotal,
            icon: "\ud83d\udcc5",
            color: "#2563eb",
            bg: "#eff6ff",
            border: "#bfdbfe",
          },
          {
            label: "Unread Messages",
            value: unreadCount,
            icon: "\ud83d\udcac",
            color: unreadCount > 0 ? "#dc2626" : "#64748b",
            bg: unreadCount > 0 ? "#fef2f2" : "#f8fafc",
            border: unreadCount > 0 ? "#fecaca" : "#e2e8f0",
          },
          {
            label: "Patient Alerts",
            value: alerts.length,
            icon: "\ud83d\udce2",
            color: alerts.length > 0 ? "#d97706" : "#64748b",
            bg: alerts.length > 0 ? "#fffbeb" : "#f8fafc",
            border: alerts.length > 0 ? "#fde68a" : "#e2e8f0",
          },
        ].map((s) => (
          <div
            key={s.label}
            className="home__stat"
            style={{ background: s.bg, border: `1.5px solid ${s.border}` }}
          >
            <div className="home__stat-icon">{s.icon}</div>
            <div className="home__stat-value" style={{ color: s.color }}>
              {s.value}
            </div>
            <div className="home__stat-label">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Quick Actions */}
      <div className="home__actions">
        {[
          {
            label: "Book Appointment",
            icon: "\ud83d\udcc5",
            color: "#1e293b",
            action: () => {
              setEditApptId(null);
              setBookForm({
                dt: new Date().toISOString().split("T")[0],
                tm: "",
                ty: "OPD",
                sp: "",
                doc: currentDoctor?.name || "",
                notes: "",
                labPickup: "hospital",
                labTests: [],
              });
              setShowBooking(true);
              setShowSearch(true);
            },
          },
          {
            label: "New Patient",
            icon: "\ud83d\udc64",
            color: "#059669",
            action: () => {
              newPatient();
              navigate("/patient");
            },
          },
          {
            label: "Search Patient",
            icon: "\ud83d\udd0d",
            color: "#2563eb",
            action: () => {
              navigate("/find");
            },
          },
        ].map((a) => (
          <button
            key={a.label}
            onClick={a.action}
            className="home__action-btn"
            style={{ border: `2px solid ${a.color}20` }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = `${a.color}08`;
              e.currentTarget.style.borderColor = `${a.color}50`;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "white";
              e.currentTarget.style.borderColor = `${a.color}20`;
            }}
          >
            <span className="home__action-icon">{a.icon}</span>
            <span className="home__action-label" style={{ color: a.color }}>
              {a.label}
            </span>
          </button>
        ))}
      </div>

      {/* Two-column panel: Appointments + Messages */}
      <div className="home__panels">
        {/* Today's Appointments */}
        <div
          className="home__panel"
          style={{ border: "1.5px solid #e2e8f0", boxShadow: "0 2px 8px rgba(0,0,0,.04)" }}
        >
          <div className="home__panel-header" style={{ background: "#1e293b" }}>
            <div className="home__panel-title">{"\ud83d\udcc5"} TODAY'S APPOINTMENTS</div>
            <div className="home__panel-count">{todayApptTotal} total</div>
          </div>
          {todayApptLoading ? (
            <div style={{ padding: 14 }}>
              <Shimmer type="list" count={4} />
            </div>
          ) : todayAppointments.length === 0 ? (
            <div className="home__panel-empty">
              <div className="home__panel-empty-icon">{"\ud83d\udced"}</div>
              <div className="home__panel-empty-text">No appointments today</div>
              <button
                onClick={() => {
                  setEditApptId(null);
                  setBookForm({
                    dt: new Date().toISOString().split("T")[0],
                    tm: "",
                    ty: "OPD",
                    sp: "",
                    doc: "",
                    notes: "",
                    labPickup: "hospital",
                    labTests: [],
                  });
                  setShowBooking(true);
                  setShowSearch(true);
                }}
                className="home__panel-empty-btn"
              >
                + Book First Appointment
              </button>
            </div>
          ) : (
            <div className="home__panel-scroll">
              {todayAppointments.map((a, i) => {
                const statusColor =
                  a.status === "completed"
                    ? "#059669"
                    : a.status === "cancelled"
                      ? "#dc2626"
                      : a.status === "in-progress"
                        ? "#d97706"
                        : a.status === "no_show"
                          ? "#6b7280"
                          : "#2563eb";
                const statusBg =
                  a.status === "completed"
                    ? "#f0fdf4"
                    : a.status === "cancelled"
                      ? "#fef2f2"
                      : a.status === "in-progress"
                        ? "#fffbeb"
                        : a.status === "no_show"
                          ? "#f3f4f6"
                          : "#eff6ff";
                return (
                  <div
                    key={a.id}
                    onClick={() => {
                      if (a.patient_id) {
                        loadPatientDB({
                          id: a.patient_id,
                          name: a.patient_name,
                          file_no: a.file_no,
                          phone: a.phone,
                          age: a.age,
                          sex: a.sex,
                        });
                      }
                    }}
                    className="home__appt-item"
                    style={{
                      borderBottom: i < todayAppointments.length - 1 ? "1px solid #f1f5f9" : "none",
                      cursor: a.patient_id ? "pointer" : "default",
                    }}
                    onMouseEnter={(e) => {
                      if (a.patient_id) e.currentTarget.style.background = "#f8fafc";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "white";
                    }}
                  >
                    <div className="home__appt-row">
                      <div className="home__appt-time">{a.time_slot || "\u2014"}</div>
                      <div className="home__appt-info">
                        <div className="home__appt-name">{a.patient_name || "\u2014"}</div>
                        <div className="home__appt-detail">
                          {a.visit_type || "OPD"}
                          {a.doctor_name ? ` \u00b7 ${a.doctor_name}` : ""}
                          {a.age ? ` \u00b7 ${a.age}Y/${(a.sex || "?").charAt(0)}` : ""}
                        </div>
                      </div>
                      <span
                        className="home__appt-status"
                        style={{ background: statusBg, color: statusColor }}
                      >
                        {a.status === "completed"
                          ? "\u2713 Done"
                          : a.status === "cancelled"
                            ? "\u2715 Canc"
                            : a.status === "in-progress"
                              ? "\u25b6 In Visit"
                              : a.status === "no_show"
                                ? "No Show"
                                : "\u25cf Sched"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Messages Panel */}
        <div
          className="home__panel"
          style={{
            border: `1.5px solid ${unreadCount > 0 ? "#fecaca" : "#e2e8f0"}`,
            boxShadow:
              unreadCount > 0 ? "0 2px 8px rgba(220,38,38,.08)" : "0 2px 8px rgba(0,0,0,.04)",
          }}
        >
          <div
            className="home__panel-header"
            style={{
              background: unreadCount > 0 ? "linear-gradient(135deg,#1e293b,#7c3aed)" : "#1e293b",
            }}
          >
            <div className="home__msg-header-title">
              <span className="home__panel-title">{"\ud83d\udcac"} PATIENT MESSAGES</span>
              {unreadCount > 0 && <span className="home__msg-badge">{unreadCount}</span>}
            </div>
            <button onClick={navClick("/messages")} className="home__msg-view-all-btn">
              View All →
            </button>
          </div>
          {inboxLoading ? (
            <div style={{ padding: 14 }}>
              <Shimmer type="list" count={4} />
            </div>
          ) : inbox.length === 0 ? (
            <div className="home__panel-empty">
              <div className="home__panel-empty-icon">{"\u2709\ufe0f"}</div>
              <div className="home__panel-empty-text">No messages yet</div>
              <div className="home__panel-empty-hint">Patient messages from MHG appear here</div>
            </div>
          ) : (
            <div className="home__panel-scroll">
              {inbox.map((m, i) => {
                const isUnread = !m.is_read;
                const ts = m.sent_at
                  ? (() => {
                      const d = new Date(m.sent_at);
                      const now = new Date();
                      const diff = (now - d) / 1000;
                      if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
                      if (diff < 86400)
                        return d.toLocaleTimeString("en-IN", {
                          hour: "2-digit",
                          minute: "2-digit",
                        });
                      return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
                    })()
                  : "";
                return (
                  <div
                    key={m.id}
                    onClick={() => {
                      setActiveThread(m);
                      fetchThread(m.patient_id);
                      markRead(m.id);
                      navigate("/messages");
                    }}
                    className="home__msg-item"
                    style={{
                      borderBottom: i < inbox.length - 1 ? "1px solid #f1f5f9" : "none",
                      background: isUnread ? "#fefce8" : "white",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = isUnread ? "#fef9c3" : "#f8fafc";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = isUnread ? "#fefce8" : "white";
                    }}
                  >
                    <div className="home__msg-row">
                      <div className="home__msg-avatar">
                        {(m.patient_name || "?").charAt(0).toUpperCase()}
                      </div>
                      <div className="home__msg-content">
                        <div className="home__msg-name-row">
                          <span
                            className="home__msg-name"
                            style={{ fontWeight: isUnread ? 800 : 700 }}
                          >
                            {m.patient_name || m.sender_name || "Patient"}
                          </span>
                          {isUnread && <span className="home__msg-unread-dot" />}
                        </div>
                        <div
                          className="home__msg-preview"
                          style={{ fontWeight: isUnread ? 600 : 400 }}
                        >
                          {m.message || ""}
                        </div>
                      </div>
                      <div className="home__msg-time">{ts}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Patient Alerts Panel */}
        <div
          className="home__panel"
          style={{
            border: `1.5px solid ${alerts.length > 0 ? "#fde68a" : "#e2e8f0"}`,
            boxShadow:
              alerts.length > 0 ? "0 2px 8px rgba(217,119,6,.08)" : "0 2px 8px rgba(0,0,0,.04)",
          }}
        >
          <div
            className="home__panel-header"
            style={{
              background: alerts.length > 0 ? "linear-gradient(135deg,#1e293b,#d97706)" : "#1e293b",
            }}
          >
            <div className="home__msg-header-title">
              <span className="home__panel-title">{"\ud83d\udce2"} PATIENT ALERTS</span>
              {alerts.length > 0 && (
                <span className="home__msg-badge" style={{ background: "#d97706" }}>
                  {alerts.length}
                </span>
              )}
            </div>
            <button onClick={fetchAlerts} className="home__msg-view-all-btn">
              Refresh
            </button>
          </div>
          {alertsLoading ? (
            <div style={{ padding: 14 }}>
              <Shimmer type="list" count={3} />
            </div>
          ) : alerts.length === 0 ? (
            <div className="home__panel-empty">
              <div className="home__panel-empty-icon">{"\u2705"}</div>
              <div className="home__panel-empty-text">No patient alerts</div>
              <div className="home__panel-empty-hint">
                Alerts from MyHealth Genie app appear here
              </div>
            </div>
          ) : (
            <div className="home__panel-scroll">
              {alerts.slice(0, 10).map((a, i) => {
                const ts = a.created_at
                  ? (() => {
                      const d = new Date(a.created_at);
                      const now = new Date();
                      const diff = (now - d) / 1000;
                      if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
                      if (diff < 86400)
                        return d.toLocaleTimeString("en-IN", {
                          hour: "2-digit",
                          minute: "2-digit",
                        });
                      return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
                    })()
                  : "";
                return (
                  <div
                    key={a.id}
                    className="home__msg-item"
                    style={{
                      borderBottom:
                        i < Math.min(alerts.length, 10) - 1 ? "1px solid #f1f5f9" : "none",
                      background: a.status === "unread" ? "#fffbeb" : "white",
                    }}
                  >
                    <div className="home__msg-row">
                      <div
                        className="home__msg-avatar"
                        style={{ background: "#d97706", color: "white" }}
                      >
                        {a.alert_type === "symptom" ? "!" : a.alert_type === "vital" ? "V" : "A"}
                      </div>
                      <div className="home__msg-content">
                        <div className="home__msg-name-row">
                          <span className="home__msg-name" style={{ fontWeight: 700 }}>
                            {a.title || a.alert_type || "Alert"}
                          </span>
                        </div>
                        <div className="home__msg-preview">{a.message || ""}</div>
                      </div>
                      <div className="home__msg-time">{ts}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Medicine Refill Requests */}
        <div
          className="home__panel"
          style={{
            border: `1.5px solid ${refills.length > 0 ? "#fde68a" : "#e2e8f0"}`,
            boxShadow:
              refills.length > 0 ? "0 2px 8px rgba(245,158,11,.10)" : "0 2px 8px rgba(0,0,0,.04)",
          }}
        >
          <div
            className="home__panel-header"
            style={{
              background:
                refills.length > 0 ? "linear-gradient(135deg,#1e293b,#f59e0b)" : "#1e293b",
            }}
          >
            <div className="home__msg-header-title">
              <span className="home__panel-title">{"💊"} MEDICINE REFILL REQUESTS</span>
              {refills.length > 0 && (
                <span className="home__msg-badge" style={{ background: "#f59e0b" }}>
                  {refills.length}
                </span>
              )}
            </div>
            <button onClick={fetchRefills} className="home__msg-view-all-btn">
              Refresh
            </button>
          </div>
          {refillsLoading ? (
            <div style={{ padding: 14 }}>
              <Shimmer type="list" count={3} />
            </div>
          ) : refills.length === 0 ? (
            <div className="home__panel-empty">
              <div className="home__panel-empty-icon">{"✅"}</div>
              <div className="home__panel-empty-text">No pending refill requests</div>
              <div className="home__panel-empty-hint">
                Refill orders from MyHealth Genie app appear here
              </div>
            </div>
          ) : (
            <div className="home__panel-scroll">
              {refills.map((r, i) => {
                const ts = r.requested_at
                  ? (() => {
                      const d = new Date(r.requested_at);
                      const now = new Date();
                      const diff = (now - d) / 1000;
                      if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
                      if (diff < 86400)
                        return d.toLocaleTimeString("en-IN", {
                          hour: "2-digit",
                          minute: "2-digit",
                        });
                      return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
                    })()
                  : "";
                const items = Array.isArray(r.items) ? r.items : [];
                return (
                  <div
                    key={r.id}
                    style={{
                      padding: "10px 14px",
                      borderBottom: i < refills.length - 1 ? "1px solid #f1f5f9" : "none",
                      background: "white",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                        marginBottom: 6,
                      }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>
                        Refill request
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 600,
                            color: "#92400e",
                            background: "#fef3c7",
                            padding: "2px 6px",
                            borderRadius: 4,
                            marginLeft: 8,
                          }}
                        >
                          {r.status?.toUpperCase() || "PENDING"}
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: "#6b7280" }}>{ts}</div>
                    </div>
                    <ul
                      style={{
                        margin: "4px 0 6px 18px",
                        padding: 0,
                        fontSize: 12,
                        color: "#374151",
                      }}
                    >
                      {items.map((it, j) => (
                        <li key={j}>
                          <strong>{it.quantity}×</strong> {it.medication_name}
                          {it.dose ? ` (${it.dose})` : ""}
                        </li>
                      ))}
                    </ul>
                    {!!r.notes && (
                      <div
                        style={{
                          fontSize: 11,
                          color: "#6b7280",
                          fontStyle: "italic",
                          marginBottom: 6,
                        }}
                      >
                        Note: {r.notes}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                      <button
                        onClick={async () => {
                          await updateRefillStatus(r.id, "approved");
                          fetchRefills();
                        }}
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          padding: "4px 10px",
                          borderRadius: 6,
                          border: "1px solid #10b981",
                          background: "#ecfdf5",
                          color: "#047857",
                          cursor: "pointer",
                        }}
                      >
                        Approve
                      </button>
                      <button
                        onClick={async () => {
                          await updateRefillStatus(r.id, "fulfilled");
                          fetchRefills();
                        }}
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          padding: "4px 10px",
                          borderRadius: 6,
                          border: "1px solid #2563eb",
                          background: "#eff6ff",
                          color: "#1d4ed8",
                          cursor: "pointer",
                        }}
                      >
                        Mark fulfilled
                      </button>
                      <button
                        onClick={async () => {
                          await updateRefillStatus(r.id, "rejected");
                          fetchRefills();
                        }}
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          padding: "4px 10px",
                          borderRadius: 6,
                          border: "1px solid #ef4444",
                          background: "#fef2f2",
                          color: "#b91c1c",
                          cursor: "pointer",
                        }}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Dose Change Requests */}
        <div
          className="home__panel"
          style={{
            border: `1.5px solid ${doseRequests.length > 0 ? "#fde68a" : "#e2e8f0"}`,
            boxShadow:
              doseRequests.length > 0
                ? "0 2px 8px rgba(124,92,255,.10)"
                : "0 2px 8px rgba(0,0,0,.04)",
          }}
        >
          <div
            className="home__panel-header"
            style={{
              background:
                doseRequests.length > 0 ? "linear-gradient(135deg,#1e293b,#7c3aed)" : "#1e293b",
            }}
          >
            <div className="home__msg-header-title">
              <span className="home__panel-title">⚕️ DOSE CHANGE REQUESTS</span>
              {doseRequests.length > 0 && (
                <span className="home__msg-badge" style={{ background: "#7c3aed" }}>
                  {doseRequests.length}
                </span>
              )}
            </div>
            <button
              onClick={() => navigate("/dose-change-requests")}
              className="home__msg-view-all-btn"
            >
              View all
            </button>
          </div>
          {doseLoading ? (
            <div style={{ padding: 14 }}>
              <Shimmer type="list" count={3} />
            </div>
          ) : doseRequests.length === 0 ? (
            <div className="home__panel-empty">
              <div className="home__panel-empty-icon">✅</div>
              <div className="home__panel-empty-text">No pending dose-change requests</div>
              <div className="home__panel-empty-hint">
                Patient-initiated dose adjustments appear here
              </div>
            </div>
          ) : (
            <div className="home__panel-scroll">
              {doseRequests.slice(0, 5).map((r, i) => {
                const ts = r.requested_at
                  ? (() => {
                      const d = new Date(r.requested_at);
                      const now = new Date();
                      const diff = (now - d) / 1000;
                      if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
                      if (diff < 86400)
                        return d.toLocaleTimeString("en-IN", {
                          hour: "2-digit",
                          minute: "2-digit",
                        });
                      return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
                    })()
                  : "";
                return (
                  <div
                    key={r.id}
                    onClick={() => navigate("/dose-change-requests")}
                    style={{
                      padding: "10px 14px",
                      borderBottom:
                        i < Math.min(doseRequests.length, 5) - 1 ? "1px solid #f1f5f9" : "none",
                      background: "white",
                      cursor: "pointer",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                        marginBottom: 4,
                      }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>
                        {r.patient_name || `Patient #${r.patient_id}`}
                      </div>
                      <div style={{ fontSize: 11, color: "#6b7280" }}>{ts}</div>
                    </div>
                    <div style={{ fontSize: 12, color: "#374151" }}>
                      <strong>{r.medication_name}</strong>: {r.current_dose} →{" "}
                      <span style={{ color: "#7c3aed", fontWeight: 700 }}>{r.requested_dose}</span>
                      {r.dose_unit ? ` ${r.dose_unit}` : ""}
                    </div>
                    {r.patient_reason && (
                      <div
                        style={{
                          fontSize: 11,
                          color: "#6b7280",
                          fontStyle: "italic",
                          marginTop: 4,
                        }}
                      >
                        “{r.patient_reason}”
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
