import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "../services/api.js";
import { toast } from "../stores/uiStore.js";
import "./PrescriptionFooterPage.css";

// The fixed strip at the foot of every prescription. HealthRay has the same
// setting; without it here, renaming the patient app meant a code deploy.
// Renders as the Prescription panel of /settings, which prints the heading.

const BLANK = {
  serviceLines: ["", ""],
  appLine: "",
  storeLine: "",
  hospital: { name: "", address: "", phone: "" },
};

const useFooter = () =>
  useQuery({
    queryKey: ["admin", "prescription-footer"],
    queryFn: async () => (await api.get("/api/admin/prescription-footer")).data,
  });

const useLogo = () =>
  useQuery({
    queryKey: ["admin", "prescription-logo"],
    queryFn: async () => (await api.get("/api/admin/prescription-logo")).data,
  });

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

const readAsDataUri = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Could not read that file"));
    r.readAsDataURL(file);
  });

// The letterhead band is navy, so a logo on a white tile prints as a white
// sticker over it. The preview below is the real header colour for exactly this
// reason — it is cheaper to see the problem here than in a printed prescription.
function LogoSection({ hospital }) {
  const queryClient = useQueryClient();
  const { data: logo } = useLogo();
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["admin", "prescription-logo"] });
  };

  const upload = async (file) => {
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) return toast("Pick an image under 4MB", "error");
    setBusy(true);
    try {
      const dataUri = await readAsDataUri(file);
      const saved = (await api.put("/api/admin/prescription-logo", { dataUri })).data;
      refresh();
      toast(`Logo updated — trimmed and resized to ${saved.width}×${saved.height}`, "success");
      if (saved.warning) toast(saved.warning, "warn");
    } catch (e) {
      toast(e?.response?.data?.error || e.message || "Could not save the logo", "error");
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      await api.delete("/api/admin/prescription-logo");
      refresh();
      toast("Reverted to the built-in logo", "success");
    } catch (e) {
      toast(e?.response?.data?.error || "Could not reset the logo", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="rxf__group">
      <legend className="rxf__legend">Letterhead logo</legend>
      <p className="rxf__hint">
        Printed at the centre of the letterhead and beside the app line below. Upload artwork with a
        transparent or light-coloured mark — the band behind it is dark navy. The file is trimmed
        and resized automatically.
      </p>

      <div className="rxf__logoRow">
        <div className="rxf__logoWell">
          {logo?.dataUri ? (
            <img src={logo.dataUri} alt="Current letterhead logo" className="rxf__logoImg" />
          ) : (
            <span className="rxf__logoNone">No logo</span>
          )}
        </div>
        <div className="rxf__logoMeta">
          <div className="rxf__logoState">
            {logo?.isDefault ? "Built-in logo" : "Custom logo"}
            {logo?.width ? ` · ${logo.width}×${logo.height}` : ""}
            {logo?.bytes ? ` · ${Math.round(logo.bytes / 1024)} KB` : ""}
          </div>
          <div className="rxf__logoBtns">
            <label className={`rxf__upload${busy ? " rxf__upload--busy" : ""}`}>
              {busy ? "Working…" : "Choose image…"}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                disabled={busy}
                onChange={(e) => {
                  upload(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
            {!logo?.isDefault && (
              <button type="button" className="rxf__reset" disabled={busy} onClick={reset}>
                Reset to built-in
              </button>
            )}
          </div>
        </div>
      </div>

      {logo?.warning ? <p className="rxf__warn">⚠️ {logo.warning}</p> : null}

      <div className="rxf__headPreview">
        <div className="rxf__headTop">
          <div className="rxf__headName">{hospital.name}</div>
          {logo?.dataUri && <img src={logo.dataUri} alt="" className="rxf__headLogo" />}
          <div className="rxf__headDoc">
            <div className="rxf__headDocName">Dr. —</div>
            <div className="rxf__headDocCred">Specialty</div>
          </div>
        </div>
        <div className="rxf__headAddr">
          {hospital.address} · {hospital.phone}
        </div>
      </div>
      <p className="rxf__hint">
        The doctor block is filled in when a prescription is printed — the consultant on the
        appointment, with the specialty and registration number from their entry in Doctors. It is
        not set here.
      </p>
    </fieldset>
  );
}

export default function PrescriptionFooterPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useFooter();
  const { data: logo } = useLogo();
  const [form, setForm] = useState(BLANK);

  useEffect(() => {
    if (!data) return;
    const lines = data.serviceLines?.length ? data.serviceLines : [""];
    setForm({
      serviceLines: lines.length < 2 ? [...lines, ""] : lines,
      appLine: data.appLine || "",
      storeLine: data.storeLine || "",
      hospital: {
        name: data.hospital?.name || "",
        address: data.hospital?.address || "",
        phone: data.hospital?.phone || "",
      },
    });
  }, [data]);

  const save = useMutation({
    mutationFn: async (body) => (await api.put("/api/admin/prescription-footer", body)).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "prescription-footer"] });
      toast("Saved — applies to the next prescription printed", "success");
    },
    onError: (e) => toast(e?.response?.data?.error || "Could not save", "error"),
  });

  const setLine = (i, value) =>
    setForm((f) => ({ ...f, serviceLines: f.serviceLines.map((l, n) => (n === i ? value : l)) }));

  const setHospital = (key, value) =>
    setForm((f) => ({ ...f, hospital: { ...f.hospital, [key]: value } }));

  const payload = {
    serviceLines: form.serviceLines.map((l) => l.trim()).filter(Boolean),
    appLine: form.appLine.trim(),
    storeLine: form.storeLine.trim(),
    hospital: {
      name: form.hospital.name.trim(),
      address: form.hospital.address.trim(),
      phone: form.hospital.phone.trim(),
    },
  };

  const dirty =
    !!data &&
    JSON.stringify(payload) !==
      JSON.stringify({
        serviceLines: data.serviceLines || [],
        appLine: data.appLine || "",
        storeLine: data.storeLine || "",
        hospital: {
          name: data.hospital?.name || "",
          address: data.hospital?.address || "",
          phone: data.hospital?.phone || "",
        },
      });

  const previewHospital = {
    name: form.hospital.name.trim() || data?.hospital?.name || "",
    address: form.hospital.address.trim() || data?.hospital?.address || "",
    phone: form.hospital.phone.trim() || data?.hospital?.phone || "",
  };

  const preview = {
    lines: form.serviceLines.map((l) => l.trim()).filter(Boolean),
    appLine: form.appLine.trim(),
    storeLine: form.storeLine.trim(),
  };

  return (
    <div className="rxf">
      <p className="rxf__sub">Leave a field blank to drop that line from the printed page.</p>

      {isLoading ? (
        <p className="rxf__loading">Loading…</p>
      ) : (
        <>
          <form
            className="rxf__form"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(payload);
            }}
          >
            <fieldset className="rxf__group">
              <legend className="rxf__legend">Hospital identity</legend>
              <p className="rxf__hint">
                Printed across the top of every prescription and referral letter. Leave a field
                blank to keep the current value.
              </p>
              <label className="rxf__field">
                <span className="rxf__label">Hospital name</span>
                <input
                  className="rxf__input"
                  value={form.hospital.name}
                  maxLength={120}
                  placeholder={data?.hospital?.name || "Gini Advanced Care Hospital"}
                  onChange={(e) => setHospital("name", e.target.value)}
                />
              </label>
              <label className="rxf__field">
                <span className="rxf__label">Address</span>
                <input
                  className="rxf__input"
                  value={form.hospital.address}
                  maxLength={200}
                  placeholder={data?.hospital?.address || ""}
                  onChange={(e) => setHospital("address", e.target.value)}
                />
              </label>
              <label className="rxf__field">
                <span className="rxf__label">Phone</span>
                <input
                  className="rxf__input"
                  type="tel"
                  value={form.hospital.phone}
                  maxLength={120}
                  placeholder={data?.hospital?.phone || ""}
                  onChange={(e) => setHospital("phone", e.target.value)}
                />
              </label>
            </fieldset>

            <LogoSection hospital={previewHospital} />

            <fieldset className="rxf__group">
              <legend className="rxf__legend">Clinic services</legend>
              {form.serviceLines.map((line, i) => (
                <label className="rxf__field" key={i}>
                  <span className="rxf__label">Service line {i + 1}</span>
                  <input
                    className="rxf__input"
                    value={line}
                    maxLength={120}
                    placeholder="e.g. Online consultation available"
                    onChange={(e) => setLine(i, e.target.value)}
                  />
                </label>
              ))}
              {form.serviceLines.length < 4 && (
                <button
                  type="button"
                  className="rxf__add"
                  onClick={() => setForm((f) => ({ ...f, serviceLines: [...f.serviceLines, ""] }))}
                >
                  + Add a line
                </button>
              )}
            </fieldset>

            <fieldset className="rxf__group">
              <legend className="rxf__legend">Patient app</legend>
              <label className="rxf__field">
                <span className="rxf__label">App line</span>
                <input
                  className="rxf__input"
                  value={form.appLine}
                  maxLength={120}
                  placeholder="e.g. Track this prescription on My Gini"
                  onChange={(e) => setForm((f) => ({ ...f, appLine: e.target.value }))}
                />
              </label>
              <label className="rxf__field">
                <span className="rxf__label">Store line</span>
                <input
                  className="rxf__input"
                  value={form.storeLine}
                  maxLength={120}
                  placeholder="e.g. Free on Google Play and the App Store"
                  onChange={(e) => setForm((f) => ({ ...f, storeLine: e.target.value }))}
                />
              </label>
            </fieldset>

            <div className="rxf__actions">
              <button className="rxf__save" type="submit" disabled={!dirty || save.isPending}>
                {save.isPending ? "Saving…" : "Save"}
              </button>
              <span className="rxf__note">Applies to the next prescription printed.</span>
            </div>
          </form>

          <section className="rxf__previewWrap">
            <h2 className="rxf__legend">Preview</h2>
            <div className="rxf__preview">
              <div className="rxf__previewSvc">
                {preview.lines.map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
              </div>
              {(preview.appLine || preview.storeLine) && (
                <div className="rxf__previewApp">
                  {logo?.dataUri && <img src={logo.dataUri} alt="" className="rxf__previewLogo" />}
                  <div className="rxf__previewTxt">
                    {preview.appLine && <div className="rxf__previewTtl">{preview.appLine}</div>}
                    {preview.storeLine && (
                      <div className="rxf__previewSub">{preview.storeLine}</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
