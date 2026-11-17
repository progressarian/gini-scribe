import { useState } from "react";
import useAuthStore from "../../stores/authStore";
import { CAPABILITIES, hasAnyCapability } from "../../../shared/permissions";
import MasterListPage from "../../components/pharmacy/MasterListPage";
import LocationDialog from "../../components/pharmacy/LocationDialog";
import LevelsDialog from "../../components/pharmacy/LevelsDialog";
import { useLocationList, useSetLocationActive } from "../../queries/hooks/usePharmacyLocations";

const hooks = { useList: useLocationList, useSetActive: useSetLocationActive };

const COLUMNS = [
  {
    header: "Department",
    render: (l) => (
      <>
        <span className="phs-item">{l.name}</span>
        {l.notes ? <span className="phs-meta">{l.notes}</span> : null}
      </>
    ),
  },
  { header: "Code", className: "phv-mono", render: (l) => l.code },
  {
    header: "Type",
    render: (l) => (l.kind === "main" ? "Main pharmacy" : "Department store"),
  },
  {
    header: "Stock levels",
    className: "phs-num",
    render: (l) =>
      l.kind === "main" ? (
        <span className="phs-meta">Set on each medicine</span>
      ) : (
        `${l.level_count} medicine${l.level_count === 1 ? "" : "s"}`
      ),
  },
];

export default function PharmacyDepartmentsPage() {
  const role = useAuthStore((s) => s.currentDoctor?.role);
  const [levelsFor, setLevelsFor] = useState(null);

  return (
    <>
      <MasterListPage
        title="Departments"
        subtitle="Department stores such as IPD and OT keep their own stock, set aside from the main pharmacy."
        noun="department"
        plural="departments"
        searchPlaceholder="Search by department name or code"
        columns={COLUMNS}
        hooks={hooks}
        canManage={hasAnyCapability(role, [
          CAPABILITIES.PHARMACY_MASTER,
          CAPABILITIES.PHARMACY_DEPT_MANAGE,
        ])}
        Dialog={LocationDialog}
        canToggle={(l) => l.kind !== "main"}
        rowActions={(l) =>
          l.kind === "department" && l.is_active ? (
            <button
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini"
              onClick={() => setLevelsFor(l)}
              aria-label={`Stock levels for ${l.name}`}
            >
              Stock levels
            </button>
          ) : null
        }
        statusMessages={{
          deactivate:
            "Stock can no longer be transferred to this department. Stock it already holds stays recorded. You can activate it again at any time.",
          activate: "Stock can be transferred to this department again.",
        }}
      />
      {levelsFor ? <LevelsDialog location={levelsFor} onClose={() => setLevelsFor(null)} /> : null}
    </>
  );
}
