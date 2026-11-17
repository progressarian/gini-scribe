import { useState } from "react";
import { requestErrorOf } from "../billing/format";
import { toast } from "../../stores/uiStore";
import FormField from "../ui/FormField";
import { DateInput, SelectInput } from "./Fields";

export default function useMasterForm({
  record,
  initial,
  validate,
  payload,
  mutations,
  noun,
  onClose,
  successText,
}) {
  const editing = Boolean(record?.id);
  const [form, setForm] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const create = mutations.useCreate();
  const update = mutations.useUpdate();
  const busy = create.isPending || update.isPending;
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const fieldErrors = touched ? validate(form, editing) : {};

  const setValue = (field) => (value) => setForm((f) => ({ ...f, [field]: value }));

  const setField = (field, clean) => (e) => {
    const raw = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [field]: clean ? clean(raw) : raw }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    setError("");
    if (Object.keys(validate(form, editing)).length) {
      setError("Fix the highlighted fields, then save again.");
      return;
    }
    try {
      const saved = editing
        ? await update.mutateAsync({
            id: record.id,
            version: record.version,
            ...payload(form, true),
          })
        : await create.mutateAsync(payload(form, false));
      toast(
        successText?.(saved, editing) ??
          (editing ? `${saved.name} updated.` : `${saved.name} added.`),
      );
      onClose(saved);
    } catch (err) {
      setError(
        requestErrorOf(err, editing ? `Could not save the ${noun}` : `Could not add the ${noun}`),
      );
    }
  };

  const input = (name, label, props = {}, extra = {}) => (
    <FormField
      label={label}
      hint={extra.hint}
      required={extra.required}
      error={fieldErrors[name]}
      className={extra.className}
    >
      <input
        className="jb-assign"
        value={form[name]}
        onChange={setField(name, extra.clean)}
        {...props}
      />
    </FormField>
  );

  const select = (name, label, options, extra = {}) => (
    <FormField
      label={label}
      required={extra.required}
      error={fieldErrors[name]}
      className={extra.className}
    >
      <SelectInput value={form[name]} options={options} onChange={setValue(name)} />
    </FormField>
  );

  const date = (name, label, extra = {}) => (
    <FormField
      label={label}
      hint={extra.hint}
      required={extra.required}
      error={fieldErrors[name]}
      className={extra.className}
    >
      <DateInput
        value={form[name]}
        onChange={setValue(name)}
        clearable={!extra.required}
        minDate={extra.minDate}
        maxDate={extra.maxDate}
      />
    </FormField>
  );

  return { editing, form, setField, fieldErrors, error, busy, dirty, submit, input, select, date };
}
