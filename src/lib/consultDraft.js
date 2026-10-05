const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const keyFor = (visitId) => `gf-consult-draft:${visitId}`;

const empty = () => ({ fields: {}, nav: null, at: Date.now() });

export function readDraft(visitId) {
  if (!visitId) return empty();
  try {
    const raw = JSON.parse(localStorage.getItem(keyFor(visitId)) || "null");
    if (!raw || Date.now() - (raw.at || 0) > MAX_AGE_MS) return empty();
    return { fields: raw.fields || {}, nav: raw.nav || null, at: raw.at };
  } catch {
    return empty();
  }
}

function update(visitId, change) {
  if (!visitId) return;
  try {
    const next = change(readDraft(visitId));
    if (!Object.keys(next.fields).length && !next.nav) {
      localStorage.removeItem(keyFor(visitId));
      return;
    }
    localStorage.setItem(keyFor(visitId), JSON.stringify({ ...next, at: Date.now() }));
  } catch {
    return;
  }
}

export const writeDraftField = (visitId, field, value) =>
  update(visitId, (d) => ({ ...d, fields: { ...d.fields, [field]: value } }));

export const clearDraftField = (visitId, field) =>
  update(visitId, (d) => {
    const fields = { ...d.fields };
    delete fields[field];
    return { ...d, fields };
  });

export const clearDraftFields = (visitId) => update(visitId, (d) => ({ ...d, fields: {} }));

export const writeDraftNav = (visitId, nav) => update(visitId, (d) => ({ ...d, nav }));
