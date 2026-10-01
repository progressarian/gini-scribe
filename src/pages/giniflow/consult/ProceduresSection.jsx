import OrderedServicesPanel from "../../../components/billing/OrderedServicesPanel";

export default function ProceduresSection({ visitId, readOnly, onToast }) {
  return (
    <section className="csec" id="s-procedures">
      <div className="cs-head">
        <h2>🩹 Procedures</h2>
        <span className="cs-sub">priced for this patient · goes straight on the bill</span>
      </div>
      <OrderedServicesPanel
        station="doctor"
        visitId={visitId}
        readOnly={readOnly}
        onToast={onToast}
      />
    </section>
  );
}
