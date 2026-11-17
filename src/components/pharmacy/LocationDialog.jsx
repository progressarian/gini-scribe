import FormField from "../ui/FormField";
import MasterFormDialog from "./MasterFormDialog";
import useMasterForm from "./useMasterForm";
import { useCreateLocation, useUpdateLocation } from "../../queries/hooks/usePharmacyLocations";

const text = (v) => (v === null || v === undefined ? "" : String(v));

const formOf = (l) => ({ code: text(l?.code), name: text(l?.name), notes: text(l?.notes) });

const validate = (form) => {
  const errors = {};
  if (!/^[A-Z0-9-]{2,20}$/.test(form.code)) errors.code = "Use 2 to 20 letters, digits or hyphens.";
  if (form.name.trim().length < 2) errors.name = "Enter the department name.";
  return errors;
};

const payload = (form) => ({
  code: form.code,
  name: form.name.trim(),
  notes: form.notes.trim() || null,
});

const mutations = { useCreate: useCreateLocation, useUpdate: useUpdateLocation };
const code = (v) => v.toUpperCase().replace(/[^A-Z0-9-]/g, "");

export default function LocationDialog({ record: location, onClose }) {
  const main = location?.kind === "main";
  const f = useMasterForm({
    record: location,
    initial: formOf(location),
    validate,
    payload,
    mutations,
    noun: "department",
    onClose,
  });

  return (
    <MasterFormDialog
      title={f.editing ? `Edit ${location.name}` : "Add department"}
      intro={
        f.editing ? null : (
          <p className="flow-muted">
            A department keeps its own stock, set aside from the main pharmacy. Stock reaches it by
            transfer from the main pharmacy.
          </p>
        )
      }
      dirty={f.dirty}
      busy={f.busy}
      error={f.error}
      submitLabel={f.editing ? "Save department" : "Add department"}
      onSubmit={f.submit}
      onClose={onClose}
      wide={false}
    >
      <div className="bill-form">
        {f.input(
          "code",
          "Code",
          { maxLength: 20, placeholder: "e.g. IPD", readOnly: main },
          {
            required: true,
            clean: code,
            hint: main ? "The main pharmacy's code cannot change" : "Short code used on transfers",
          },
        )}
        {f.input(
          "name",
          "Department name",
          { maxLength: 120, placeholder: "e.g. Operation theatre" },
          { required: true, className: "phv-span2" },
        )}
        <FormField label="Notes" className="phv-span-all">
          <textarea
            className="jb-assign"
            rows={2}
            maxLength={500}
            value={f.form.notes}
            onChange={f.setField("notes")}
          />
        </FormField>
      </div>
    </MasterFormDialog>
  );
}
