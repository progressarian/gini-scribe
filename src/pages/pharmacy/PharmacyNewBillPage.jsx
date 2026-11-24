import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import NewBillForm from "../../components/pharmacy/NewBillForm";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../billing/billing.css";
import "../billing/billingUi.css";
import "./pharmacyStock.css";
import "./pharmacyVendors.css";
import "./pharmacyBills.css";

export default function PharmacyNewBillPage() {
  const navigate = useNavigate();
  return (
    <div className="flow-root fset bill-ui phs phb">
      <Link className="phb-back" to="/pharmacy/billing">
        <ArrowLeft size={14} aria-hidden="true" />
        Pharmacy bills
      </Link>
      <header className="phs-head">
        <div>
          <h1 className="phs-title">New pharmacy bill</h1>
          <p className="phs-sub">
            Choose the patient and sale type. The medicines are added on the next screen.
          </p>
        </div>
      </header>
      <NewBillForm
        onCancel={() => navigate("/pharmacy/billing")}
        onCreated={(bill) => navigate(`/pharmacy/billing/${bill.id}`, { replace: true })}
      />
    </div>
  );
}
