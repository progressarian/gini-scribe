import { Router } from "express";
import pool, { cronPool } from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../../shared/permissions.js";
import { buildFullReport } from "../services/analytics/index.js";
import { describeTargetBands } from "../services/analytics/biomarkerTargets.js";
import {
  latestSnapshotMeta,
  readSnapshot,
  rebuildSnapshot,
} from "../services/analytics/snapshot.js";
import { buildWorkbook } from "../services/analytics/render/xlsx.js";
import { renderHtmlReport } from "../services/analytics/render/html.js";
import { SECTION_KEYS } from "../services/analytics/snapshot.js";

const router = Router();

const SECTION_ALIASES = {
  overview: ["meta", "s1_registry", "s3_retention"],
  registry: ["meta", "s1_registry"],
  conditions: ["meta", "s2_conditions"],
  retention: ["meta", "s3_retention"],
  biomarkers: ["meta", "s4_biomarkers"],
  treatment: ["meta", "s5_treatment"],
  "drug-outcomes": ["meta", "s6_drug_outcomes"],
  "data-quality": ["meta", "s7_data_quality"],
  worklists: ["meta", "s8_worklists"],
};

// A full build scans 540k lab rows and takes ~90s. Before the first nightly
// snapshot exists every section request would trigger its own build, so the
// seven requests one page load makes would each pay that cost. Collapse them:
// concurrent callers await the same in-flight promise, and the result is held
// briefly so the rest of the page load is served from memory. This is a
// stopgap for the cold-start case only — the snapshot is the real mechanism.
const LIVE_CACHE_MS = 10 * 60 * 1000;
let liveCache = { at: 0, report: null };
let liveInFlight = null;

async function buildLive(asOf) {
  if (liveCache.report && Date.now() - liveCache.at < LIVE_CACHE_MS) return liveCache.report;
  if (liveInFlight) return liveInFlight;
  liveInFlight = buildFullReport(pool, { asOf })
    .then((report) => {
      liveCache = { at: Date.now(), report };
      return report;
    })
    .finally(() => {
      liveInFlight = null;
    });
  return liveInFlight;
}

// The band thresholds are static config, not measured data, so they are
// attached on read rather than baked into the snapshot — a snapshot built
// before a threshold changed still renders the current bands, and no rebuild
// is needed to publish an edit to BIO_TARGET.
function withBandLabels(report) {
  const section = report?.s4_biomarkers;
  if (!section?.control) return report;
  return {
    ...report,
    s4_biomarkers: {
      ...section,
      control: section.control.map((row) => ({
        ...row,
        bands: describeTargetBands(row.marker, row.unit),
      })),
    },
  };
}

// Applies the patient-cohort filter server-side: the selected variant is merged
// over its section and every variant is then dropped from the payload, so the
// client receives one cohort's figures plus the list of options — never the
// other cohorts' data. An unknown or absent key returns the unfiltered section.
function withCohort(report, cohortKey) {
  const out = { ...report };
  for (const [key, section] of Object.entries(report)) {
    if (!section || !Array.isArray(section.cohorts)) continue;
    const active = cohortKey ? section.cohorts.find((c) => c.key === cohortKey) : null;
    const { cohorts, ...rest } = section;
    out[key] = {
      ...rest,
      ...(active || {}),
      cohort_options: cohorts.map((c) => ({
        key: c.key,
        label: c.label,
        note: c.note,
        patients: c.patients,
      })),
      cohort: active ? active.key : "all",
    };
  }
  return out;
}

// Resolves the cohort for an export: applies the same server-side merge the
// section endpoints use, and returns the label so the rendered report can say
// which population it covers rather than silently showing a subset.
function exportView(report, cohortKey) {
  const merged = withBandLabels(withCohort(report, cohortKey));
  const applied = merged.s4_biomarkers?.cohort;
  const option = (merged.s4_biomarkers?.cohort_options || []).find((c) => c.key === applied);
  return {
    report: merged,
    slug: option ? `-${option.key.replace(/_/g, "-")}` : "",
    cohort: option || null,
  };
}

async function loadReport({ sections, refresh, asOf }) {
  if (refresh) {
    liveCache = { at: 0, report: null };
    return { report: withBandLabels(await buildLive(asOf)), source: "live" };
  }
  const snapshot = await readSnapshot(pool, { sectionIds: sections });
  if (snapshot) return { report: withBandLabels(snapshot), source: "snapshot" };
  return { report: withBandLabels(await buildLive(asOf)), source: "live-fallback" };
}

router.get("/analytics/meta", async (req, res) => {
  try {
    const meta = await latestSnapshotMeta(pool);
    res.json({
      snapshot: meta,
      stale: !meta || (Date.now() - new Date(meta.generated_at).getTime()) / 3600000 > 36,
      sections: Object.keys(SECTION_ALIASES),
      section_keys: SECTION_KEYS,
    });
  } catch (e) {
    handleError(res, e, "Analytics meta");
  }
});

router.get("/analytics/report", async (req, res) => {
  try {
    const refresh = req.query.refresh === "1";
    const asOf = req.query.as_of || undefined;
    const { report, source } = await loadReport({ refresh, asOf });
    res.json({ source, ...report });
  } catch (e) {
    handleError(res, e, "Analytics report");
  }
});

router.get("/analytics/sections/:id", async (req, res) => {
  try {
    const sections = SECTION_ALIASES[req.params.id];
    if (!sections) return res.status(404).json({ error: "Unknown analytics section" });
    const refresh = req.query.refresh === "1";
    const loaded = await loadReport({ sections, refresh, asOf: req.query.as_of });
    const { source } = loaded;
    // Bands are re-applied after the cohort merge: the merge swaps in the
    // cohort's own control rows, which have not been through withBandLabels.
    const report = withBandLabels(withCohort(loaded.report, req.query.cohort));
    const payload = { source, meta: report.meta, snapshot: report.snapshot };
    for (const key of sections) {
      if (key !== "meta") payload[key] = report[key];
    }
    res.json(payload);
  } catch (e) {
    handleError(res, e, "Analytics section");
  }
});

router.get("/analytics/export.xlsx", async (req, res) => {
  try {
    const loaded = await loadReport({
      refresh: req.query.refresh === "1",
      asOf: req.query.as_of,
    });
    const { report, slug, cohort } = exportView(loaded.report, req.query.cohort);
    const buffer = await buildWorkbook(report, { cohort });
    const stamp = report.meta?.as_of || new Date().toISOString().slice(0, 10);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="gini-outcomes-data-${stamp}${slug}.xlsx"`,
    );
    res.send(buffer);
  } catch (e) {
    handleError(res, e, "Analytics export");
  }
});

router.get("/analytics/export.html", async (req, res) => {
  try {
    const loaded = await loadReport({
      refresh: req.query.refresh === "1",
      asOf: req.query.as_of,
    });
    const { report, slug, cohort } = exportView(loaded.report, req.query.cohort);
    const stamp = report.meta?.as_of || new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="gini-outcomes-report-${stamp}${slug}.html"`,
    );
    res.send(
      `<!doctype html><html><head><meta charset="utf-8">${renderHtmlReport(report, { cohort })}</head></html>`,
    );
  } catch (e) {
    handleError(res, e, "Analytics html export");
  }
});

router.post(
  "/analytics/snapshot/refresh",
  requireCapability(CAPABILITIES.ADMIN),
  async (req, res) => {
    try {
      res.status(202).json({ started: true });
      rebuildSnapshot(cronPool, { asOf: req.body?.as_of })
        .then((r) => console.log(`[Analytics] snapshot ${r.id} rebuilt on demand`))
        .catch((e) => console.error("[Analytics] on-demand rebuild failed:", e.message));
    } catch (e) {
      handleError(res, e, "Analytics refresh");
    }
  },
);

export default router;
