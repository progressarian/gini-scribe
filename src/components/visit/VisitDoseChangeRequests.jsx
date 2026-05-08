import { useCallback, useEffect, useState } from "react";
import api from "../../services/api";
import useAuthStore from "../../stores/authStore";
import DoseChangeRequestCard from "../doseChange/DoseChangeRequestCard.jsx";

// Pending dose-change requests for the patient currently in this visit.
// Mirrors VisitPreVisitSymptoms: silent when there is nothing to show.
export default function VisitDoseChangeRequests({ patientId }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const currentDoctor = useAuthStore((s) => s.currentDoctor);
  const doctorId = currentDoctor?.id || currentDoctor?.email || "";

  const load = useCallback(async () => {
    if (!patientId) {
      setRows([]);
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.get(`/api/patients/${patientId}/dose-change-requests`);
      setRows(Array.isArray(data) ? data : []);
    } catch {
      setRows([]);
    }
    setLoading(false);
  }, [patientId]);

  useEffect(() => {
    load();
  }, [load]);

  const decide = async (id, payload) => {
    try {
      await api.patch(`/api/dose-change-requests/${id}`, { ...payload, doctor_id: doctorId });
      await load();
    } catch {
      /* surfaced by the row not changing */
    }
  };

  if (!patientId || loading) return null;
  const pending = rows.filter((r) => r.status === "pending");
  if (pending.length === 0) return null;

  return (
    <section
      className="card"
      style={{
        margin: "10px 0",
        padding: 14,
        background: "#fffbeb",
        border: "1px solid #fde68a",
        borderRadius: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#92400e" }}>
          ⚕️ Dose change requests ({pending.length})
        </div>
        <span style={{ fontSize: 11, color: "#a16207" }}>Awaiting your approval</span>
      </div>
      {pending.map((r) => (
        <DoseChangeRequestCard
          key={r.id}
          request={r}
          compact
          onDecide={(payload) => decide(r.id, payload)}
        />
      ))}
    </section>
  );
}
