import { Link } from "react-router-dom";
import { reportHref } from "./dashboardText";

export default function ReportLink({ report, title, filters }) {
  return (
    <Link className="brep-open bdash-report-link" to={reportHref(report, filters)}>
      Open {title} report →
    </Link>
  );
}
