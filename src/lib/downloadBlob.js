import api from "../services/api.js";

export async function downloadFile(url, fileName) {
  try {
    const res = await api.get(url, { responseType: "blob" });
    const href = URL.createObjectURL(res.data);
    const a = document.createElement("a");
    a.href = href;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
  } catch (e) {
    const body = e?.response?.data;
    if (body instanceof Blob) {
      const text = await body.text().catch(() => "");
      let message = "";
      try {
        message = JSON.parse(text).error;
      } catch {
        message = "";
      }
      throw new Error(message || "The download failed. Try again.");
    }
    throw e;
  }
}
