import api from "../../services/api";
import { saveBlob } from "../../components/billing/importText";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const upload = { headers: { "Content-Type": XLSX } };

export function decisionParams(decisions) {
  const groups = {};
  for (const [row, decision] of Object.entries(decisions)) {
    (groups[decision] ??= []).push(Number(row));
  }
  const common = Object.entries(groups).sort((a, b) => b[1].length - a[1].length)[0]?.[0];
  const params = { default: common ?? "sheet" };
  for (const [decision, rows] of Object.entries(groups)) {
    if (decision !== common) params[decision] = rows.join(",");
  }
  return params;
}

async function blobError(err) {
  const body = err?.response?.data;
  if (body instanceof Blob) {
    try {
      const parsed = JSON.parse(await body.text());
      err.response.data = parsed;
    } catch {
      err.response.data = {};
    }
  }
  return err;
}

export function fileSheetSource(base, params = () => ({})) {
  return {
    check: async (file) => (await api.post(`${base}/import/preview`, file, upload)).data,
    apply: async (file, decisions) =>
      (
        await api.post(`${base}/import`, file, {
          ...upload,
          params: { ...params(), ...decisionParams(decisions) },
        })
      ).data,
    problems: async (file, fileName) => {
      try {
        const res = await api.post(`${base}/import/problems.xlsx`, file, {
          ...upload,
          responseType: "blob",
        });
        saveBlob({ blob: res.data, fileName });
      } catch (err) {
        throw await blobError(err);
      }
    },
  };
}
