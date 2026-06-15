import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { API_URL } from "../services/api";
import "../styles/flow.css";

// Quick functional-aging self-check (spec §8). 3-point scale per item.
const AGING_QUESTIONS = [
  { k: "stairs", q: "Can you climb one flight of stairs without resting?" },
  { k: "walk", q: "Can you walk ~400 m (5 min) without stopping?" },
  { k: "chair", q: "Can you rise from a chair without using your arms?" },
  { k: "carry", q: "Can you carry a 5 kg bag comfortably?" },
  { k: "energy", q: "How are your energy levels most days?" },
];
const SCALE = [
  { v: "good", label: "Easily / Good" },
  { v: "some", label: "With difficulty" },
  { v: "poor", label: "Not really / Low" },
];

// Public, login-free patient tracking page (gini.health/visit/:token). Reads the
// sanitized /api/flow/track/:token endpoint (first name + step status only) and
// polls so the patient sees their journey advance live. Bare fetch (not the
// authenticated axios instance) so it works for logged-out visitors.
async function fetchTrack(token) {
  const res = await fetch(`${API_URL}/api/flow/track/${encodeURIComponent(token)}`);
  if (res.status === 404) throw new Error("not_found");
  if (!res.ok) throw new Error("failed");
  return res.json();
}

const STATUS_ICON = { completed: "✓", in_progress: "🔸", ready: "•", pending: "•", skipped: "–" };

export default function PatientJourneyPage() {
  const { token } = useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ["flow", "track", token],
    queryFn: () => fetchTrack(token),
    enabled: !!token,
    refetchInterval: 20_000,
    retry: (n, e) => e?.message !== "not_found" && n < 2,
  });

  return (
    <div className="flow-root" style={{ minHeight: "100vh" }}>
      <div style={{ maxWidth: 480, margin: "0 auto" }}>
        <div style={{ textAlign: "center", padding: "18px 0 8px" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "var(--fnv)" }}>
            🏥 Gini Advanced Care
          </div>
          <div className="flow-muted">Sector 69, Mohali · Live visit tracker</div>
        </div>

        {isLoading && <div className="flow-card flow-empty">Loading your visit…</div>}

        {error && (
          <div className="flow-card flow-empty">
            {error.message === "not_found"
              ? "We couldn't find this visit. Please check the link from your WhatsApp message."
              : "Couldn't load your visit right now. Please try again shortly."}
          </div>
        )}

        {data && (
          <>
            <div className="flow-card" style={{ textAlign: "center", marginBottom: 12 }}>
              <div style={{ fontSize: 13, color: "var(--fink3)" }}>Namaste</div>
              <div style={{ fontSize: 22, fontWeight: 700, margin: "2px 0 10px" }}>
                {data.first_name || "there"} ji 🙏
              </div>
              {data.status === "completed" ? (
                <div className="flow-badge fb-grn" style={{ fontSize: 13, padding: "6px 14px" }}>
                  ✓ Visit complete — thank you!
                </div>
              ) : (
                <>
                  <div className="flow-muted">Currently at</div>
                  <div
                    style={{ fontSize: 18, fontWeight: 700, color: "var(--fsk)", margin: "2px 0" }}
                  >
                    {data.current_step || "Getting started"}
                  </div>
                  <div
                    style={{ display: "flex", justifyContent: "center", gap: 16, marginTop: 10 }}
                  >
                    <div>
                      <div style={{ fontSize: 24, fontWeight: 600 }}>
                        {data.step_index}/{data.total_steps}
                      </div>
                      <div className="flow-stat-lbl">Step</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 24, fontWeight: 600, color: "var(--ftl)" }}>
                        ~{data.remaining_min}
                      </div>
                      <div className="flow-stat-lbl">Min left (est.)</div>
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="flow-card">
              <div className="flow-sec-title">Your journey</div>
              {data.timeline?.map((s, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 4px",
                    borderBottom: i < data.timeline.length - 1 ? "1px solid var(--fbd)" : "none",
                    opacity: s.status === "skipped" ? 0.4 : 1,
                  }}
                >
                  <span
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: "50%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                      fontSize: 12,
                      fontWeight: 700,
                      background:
                        s.status === "completed"
                          ? "var(--fgnl)"
                          : s.status === "in_progress"
                            ? "var(--fskl)"
                            : "var(--fbg)",
                      color:
                        s.status === "completed"
                          ? "var(--fgn)"
                          : s.status === "in_progress"
                            ? "var(--fsk)"
                            : "var(--fink3)",
                    }}
                  >
                    {STATUS_ICON[s.status] || "•"}
                  </span>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: s.status === "in_progress" ? 700 : 500,
                      textDecoration: s.status === "skipped" ? "line-through" : "none",
                    }}
                  >
                    {s.name}
                  </span>
                  {s.status === "in_progress" && (
                    <span className="flow-badge fb-blu" style={{ marginLeft: "auto" }}>
                      now
                    </span>
                  )}
                </div>
              ))}
            </div>

            <PreConsult token={token} />

            <div className="flow-muted" style={{ textAlign: "center", padding: "12px 0" }}>
              This page updates automatically. Estimated times may vary on busy days.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// File-number-gated pre-consultation: verify the file number against this visit,
// then collect a functional-aging mini-assessment. Bare fetch (public endpoints).
function PreConsult({ token }) {
  const [fileNo, setFileNo] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState({});
  const [done, setDone] = useState(false);

  const verify = async () => {
    setErr("");
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/flow/track/${encodeURIComponent(token)}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_no: fileNo }),
      });
      const data = await res.json();
      if (data.ok) setUnlocked(true);
      else setErr("That file number doesn't match this visit.");
    } catch {
      setErr("Couldn't verify right now. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/flow/track/${encodeURIComponent(token)}/assessment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_no: fileNo, responses: answers }),
      });
      if (res.ok) setDone(true);
      else setErr("Couldn't save your answers.");
    } catch {
      setErr("Couldn't save your answers.");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="flow-card" style={{ marginTop: 12, textAlign: "center" }}>
        <div className="flow-badge fb-grn" style={{ fontSize: 13, padding: "6px 14px" }}>
          ✓ Thank you — your answers will help your doctor
        </div>
      </div>
    );
  }

  if (!unlocked) {
    return (
      <div className="flow-card" style={{ marginTop: 12 }}>
        <div className="flow-sec-title">Before your consultation</div>
        <div className="flow-muted" style={{ marginBottom: 8 }}>
          Enter your file number to answer a few quick questions for your doctor.
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <div className="flow-field" style={{ flex: 1 }}>
            <input
              value={fileNo}
              onChange={(e) => setFileNo(e.target.value)}
              placeholder="File number (e.g. P_14207)"
            />
          </div>
          <button
            className="flow-btn flow-btn-primary"
            disabled={busy || !fileNo.trim()}
            onClick={verify}
          >
            Unlock
          </button>
        </div>
        {err && <div style={{ color: "var(--fre)", fontSize: 11, marginTop: 6 }}>{err}</div>}
      </div>
    );
  }

  const allAnswered = AGING_QUESTIONS.every((q) => answers[q.k]);
  return (
    <div className="flow-card" style={{ marginTop: 12 }}>
      <div className="flow-sec-title">Quick health check</div>
      {AGING_QUESTIONS.map((q) => (
        <div key={q.k} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{q.q}</div>
          <div style={{ display: "flex", gap: 6 }}>
            {SCALE.map((o) => (
              <button
                key={o.v}
                className={`flow-toggle${answers[q.k] === o.v ? " on" : ""}`}
                style={{ textAlign: "center" }}
                onClick={() => setAnswers((a) => ({ ...a, [q.k]: o.v }))}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      ))}
      {err && <div style={{ color: "var(--fre)", fontSize: 11, marginBottom: 6 }}>{err}</div>}
      <button
        className="flow-btn flow-btn-primary"
        style={{ width: "100%", padding: 10 }}
        disabled={busy || !allAnswered}
        onClick={submit}
      >
        Submit answers
      </button>
    </div>
  );
}
