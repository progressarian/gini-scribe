import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { API_URL } from "../services/api";
import "./CorporateBookingPage.css";

async function fetchCompany(slug) {
  const res = await fetch(`${API_URL}/api/corporate/${encodeURIComponent(slug)}`);
  if (res.status === 404) throw new Error("not_found");
  if (!res.ok) throw new Error("failed");
  return res.json();
}

const PHONE_RE = /^[6-9]\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STEPS = [
  { id: "package", label: "Your package" },
  { id: "details", label: "Your details" },
  { id: "slot", label: "Date & time" },
];

export default function CorporateBookingPage() {
  const { slug } = useParams();
  const [step, setStep] = useState("package");
  const [packageId, setPackageId] = useState(null);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["corporate", slug],
    queryFn: () => fetchCompany(slug),
    enabled: !!slug,
    retry: (n, e) => e?.message !== "not_found" && n < 2,
  });

  const packages = data?.packages || [];
  const selected = packages.find((p) => p.id === packageId) || null;
  const phoneOk = PHONE_RE.test(phone.trim());
  const emailOk = EMAIL_RE.test(email.trim());

  if (isLoading) {
    return (
      <main className="cb-root">
        <div className="cb-card cb-empty">Loading…</div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="cb-root">
        <div className="cb-card cb-empty">
          <h1 className="cb-empty-title">This link isn’t valid</h1>
          <p>
            Please check the link in your email, or contact your HR team for the correct booking
            link.
          </p>
        </div>
      </main>
    );
  }

  const stepIndex = STEPS.findIndex((s) => s.id === step);

  return (
    <main className="cb-root">
      <header className="cb-header">
        <p className="cb-brand">Gini Health · Mohali</p>
        <h1 className="cb-title">{data.company.name} Health Checkup</h1>
        <p className="cb-sub">Book your annual health checkup appointment</p>
      </header>

      <ol className="cb-steps">
        {STEPS.map((s, i) => (
          <li
            key={s.id}
            className={`cb-step ${i === stepIndex ? "cb-step--on" : ""} ${
              i < stepIndex ? "cb-step--done" : ""
            }`}
          >
            <span className="cb-step-num">{i < stepIndex ? "✓" : i + 1}</span>
            <span className="cb-step-label">{s.label}</span>
          </li>
        ))}
      </ol>

      {step === "package" && (
        <section className="cb-card">
          <h2 className="cb-h2">Select your health package</h2>
          {packages.length === 0 && (
            <p className="cb-muted">No packages are available yet. Please contact your HR team.</p>
          )}
          <ul className="cb-pkg-list">
            {packages.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className={`cb-pkg ${packageId === p.id ? "cb-pkg--on" : ""}`}
                  aria-pressed={packageId === p.id}
                  onClick={() => setPackageId(p.id)}
                >
                  <span className="cb-pkg-head">
                    <span className="cb-pkg-name">{p.name}</span>
                    <span className="cb-pkg-check" aria-hidden="true">
                      {packageId === p.id ? "✓" : ""}
                    </span>
                  </span>
                  {p.description && <span className="cb-pkg-desc">{p.description}</span>}
                  {p.tests.length > 0 && (
                    <span className="cb-pkg-tests">
                      <span className="cb-pkg-tests-label">Tests included</span>
                      <span className="cb-chips">
                        {p.tests.map((t) => (
                          <span key={t.id} className="cb-chip">
                            {t.name}
                          </span>
                        ))}
                      </span>
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="cb-primary"
            disabled={!packageId}
            onClick={() => setStep("details")}
          >
            Continue
          </button>
        </section>
      )}

      {step === "details" && (
        <section className="cb-card">
          <h2 className="cb-h2">Your contact details</h2>
          <p className="cb-selected">
            {selected?.name}
            <button type="button" className="cb-link" onClick={() => setStep("package")}>
              Change
            </button>
          </p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              setTouched(true);
              if (phoneOk && emailOk) setStep("slot");
            }}
            noValidate
          >
            <div className="cb-field">
              <label htmlFor="cb-phone">Mobile number</label>
              <input
                id="cb-phone"
                name="phone"
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                maxLength={10}
                placeholder="10-digit mobile number"
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
              />
              {touched && !phoneOk && (
                <p className="cb-error">Enter a valid 10-digit mobile number</p>
              )}
            </div>

            <div className="cb-field">
              <label htmlFor="cb-email">Email address</label>
              <input
                id="cb-email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              {touched && !emailOk && <p className="cb-error">Enter a valid email address</p>}
            </div>

            <div className="cb-actions">
              <button type="button" className="cb-secondary" onClick={() => setStep("package")}>
                Back
              </button>
              <button type="submit" className="cb-primary">
                Continue
              </button>
            </div>
          </form>
        </section>
      )}

      {step === "slot" && (
        <section className="cb-card">
          <h2 className="cb-h2">Choose a date and time</h2>
          <div className="cb-pending">
            <p className="cb-pending-title">Slot selection is not built yet</p>
            <p>
              This step needs the checkup capacity settings — how many people can be seen per slot,
              and on which days and hours.
            </p>
          </div>
          <div className="cb-summary">
            <dl>
              <div>
                <dt>Package</dt>
                <dd>{selected?.name}</dd>
              </div>
              <div>
                <dt>Mobile</dt>
                <dd>{phone}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{email}</dd>
              </div>
            </dl>
          </div>
          <button type="button" className="cb-secondary" onClick={() => setStep("details")}>
            Back
          </button>
        </section>
      )}

      <footer className="cb-footer">
        Questions? Call 0172-4120100 · Gini Health, Sector 69, Mohali
      </footer>
    </main>
  );
}
