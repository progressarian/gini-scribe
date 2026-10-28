import express from "express";
import { searchReferringDoctors } from "../crm/registration.js";
import {
  IMPORT_FIELDS,
  parseSheet,
  suggestMapping,
  createBatch,
  previewBatch,
} from "../crm/importDoctors.js";
import { crmContext } from "../crm/db.js";
import {
  ImportAssignError,
  assertCanAssign,
  batchSummary,
  commitChunk,
  listAssignees,
  pagedPreview,
  pickAssignee,
  resolveBatch,
  retryRows,
} from "../crm/importAssign.js";
import { failedWorkbook, templateWorkbook } from "../crm/importWorkbooks.js";
import { ASSIGNING_ROLES } from "../crm/assignees.js";
import {
  AssignmentError,
  assignDoctors,
  assignmentsWorkbook,
  listAssignments,
} from "../crm/assignments.js";
import { createReferral, advanceReferral, referralDetail, serviceLines } from "../crm/referrals.js";
import {
  logVisit,
  fillDoctorGap,
  repHome,
  suggestedNextVisit,
  doctor360,
  editVisit,
  undoVisit,
  loggedVisitDays,
  setPriority,
} from "../crm/visits.js";
import {
  DoctorError,
  addDoctor,
  checkMobile,
  doctorForEdit,
  doctorFormOptions,
  doctorHistory,
  updateDoctor,
} from "../crm/doctors.js";
import {
  cancelRemoval,
  decideRemoval,
  listRemovals,
  removalImpact,
  requestRemoval,
  restoreDoctor,
} from "../crm/removals.js";
import { handleError } from "../utils/errorHandler.js";
import { listDueDoctors, listMyDoctors, listReferrals } from "../crm/homeLists.js";
import {
  cancelTask,
  completeTask,
  createTask,
  listTasks,
  reopenTask,
  todayView,
} from "../crm/tasks.js";
import {
  VisitSheetError,
  assertDoctorBatch,
  commitVisitChunk,
  createVisitBatch,
  failedVisitWorkbook,
  myVisitBatches,
  pickableDoctors,
  retryVisitRows,
  undoVisitBatch,
  visitBatchRows,
  visitBatchSummary,
  visitSheetWorkbook,
} from "../crm/visitSheet.js";
import {
  ProgressError,
  progressDoctors,
  progressReport,
  progressWorkbook,
} from "../crm/progress.js";

const router = express.Router();

// The doctor picker behind "who referred you?" on the registration forms.
// Search-as-you-type, so it must stay cheap and must never make the front desk
// wait: the query is capped, the result set is capped, and a short query
// returns nothing rather than scanning the universe.
router.get("/crm/registration/referring-doctors", async (req, res) => {
  try {
    const rows = await searchReferringDoctors(req.query.q, Number(req.query.limit) || 8);
    res.json(rows);
  } catch (e) {
    handleError(res, e, "Referring doctor search");
  }
});

// ---- Doctor import wizard (brief §10) ----------------------------------
// Everything below is a CRM operation, so it runs as a CRM user through
// withCrmContext. crmContext() refuses a caller with no crm.users row.
const crm = crmContext();
const importer = (req, res, next) =>
  ASSIGNING_ROLES.includes(req.crmUser?.role)
    ? next()
    : res.status(403).json({ error: "Only an admin or the head of growth can import doctors" });

// ---- Rep home and visit logging (brief §5, §13) -------------------------
router.get("/crm/home", crm, async (req, res) => {
  try {
    res.json(await repHome(req.crmUser, { lists: req.query.lists !== "0" }));
  } catch (e) {
    handleError(res, e, "Rep home");
  }
});

const homeList = (path, list, label) =>
  router.get(path, crm, async (req, res) => {
    try {
      res.json(await list(req.crmUser, req.query));
    } catch (e) {
      console.error(`${label} error:`, e?.message);
      res.status(500).json({ error: `Unable to load ${label.toLowerCase()}. Please try again.` });
    }
  });

homeList("/crm/home/due", listDueDoctors, "Doctors to visit");
homeList("/crm/home/doctors", listMyDoctors, "My doctors");

// ---- Referral capture and the patient journey (brief §6, §7) ------------
router.get("/crm/service-lines", crm, async (req, res) => {
  try {
    res.json(await serviceLines(req.crmUser));
  } catch (e) {
    handleError(res, e, "Service lines");
  }
});

router.get("/crm/referrals", crm, async (req, res) => {
  try {
    res.json(await listReferrals(req.crmUser, req.query));
  } catch (e) {
    console.error("Open referrals error:", e?.message);
    res.status(500).json({ error: "Unable to load referrals. Please try again." });
  }
});

router.post("/crm/referrals", crm, express.json(), async (req, res) => {
  try {
    res.json(await createReferral(req.crmUser, req.body));
  } catch (e) {
    if (e?.status === 400) return res.status(400).json({ error: e.message, fields: e.fields });
    console.error("Log referral error:", e?.message);
    res.status(500).json({ error: "Unable to log the referral. Please try again." });
  }
});

router.get("/crm/referrals/:id", crm, async (req, res) => {
  try {
    res.json(await referralDetail(req.crmUser, req.params.id));
  } catch (e) {
    handleError(res, e, "Referral");
  }
});

// The journey control. `lost` without a reason is refused by the database, not
// just by this handler.
router.post("/crm/referrals/:id/status", crm, express.json(), async (req, res) => {
  try {
    res.json(await advanceReferral(req.crmUser, req.params.id, req.body));
  } catch (e) {
    handleError(res, e, "Advance referral");
  }
});

function doctorError(res, e, context) {
  if (e instanceof DoctorError) {
    const { status, message, code, fields, doctor_id, doctor_name, similar } = e;
    return res
      .status(status)
      .json({ error: message, code, fields, doctor_id, doctor_name, similar });
  }
  console.error(`${context} error:`, e?.message, e?.detail || "", e?.stack || "");
  if (e?.code === "23505") {
    return res.status(409).json({ error: "This mobile is already in the CRM." });
  }
  res.status(500).json({
    error: `${context} failed. Please try again; if it keeps failing, contact an administrator.`,
  });
}

const doctorRoute = (method, path, context, handler) =>
  router[method](path, crm, express.json(), async (req, res) => {
    try {
      res.json(await handler(req));
    } catch (e) {
      doctorError(res, e, context);
    }
  });

doctorRoute("get", "/crm/doctors/form-options", "Doctor form", (req) =>
  doctorFormOptions(req.crmUser),
);
doctorRoute("get", "/crm/doctors/check-mobile", "Mobile check", (req) =>
  checkMobile(req.crmUser, req.query),
);
doctorRoute("post", "/crm/doctors", "Add doctor", (req) => addDoctor(req.crmUser, req.body));
doctorRoute("get", "/crm/doctors/:id/edit", "Doctor details", (req) =>
  doctorForEdit(req.crmUser, req.params.id),
);
doctorRoute("put", "/crm/doctors/:id", "Update doctor", (req) =>
  updateDoctor(req.crmUser, req.params.id, req.body),
);
doctorRoute("get", "/crm/doctors/:id/history", "Doctor history", (req) =>
  doctorHistory(req.crmUser, req.params.id),
);
doctorRoute("get", "/crm/doctors/:id/removal-impact", "Removal check", (req) =>
  removalImpact(req.crmUser, req.params.id),
);
doctorRoute("post", "/crm/doctors/:id/removal", "Remove doctor", (req) =>
  requestRemoval(req.crmUser, req.params.id, req.body),
);
doctorRoute("post", "/crm/doctors/:id/restore", "Restore doctor", (req) =>
  restoreDoctor(req.crmUser, req.params.id),
);
doctorRoute("get", "/crm/doctors/:id/visit-days", "Visit dates", (req) =>
  loggedVisitDays(req.crmUser, req.params.id),
);
doctorRoute("get", "/crm/removal-requests", "Removal requests", (req) =>
  listRemovals(req.crmUser, req.query),
);
doctorRoute("post", "/crm/removal-requests/:id/cancel", "Cancel request", (req) =>
  cancelRemoval(req.crmUser, req.params.id),
);
doctorRoute("post", "/crm/removal-requests/:id/approve", "Approve removal", (req) =>
  decideRemoval(req.crmUser, req.params.id, { approve: true, note: req.body?.note }),
);
doctorRoute("post", "/crm/removal-requests/:id/reject", "Reject removal", (req) =>
  decideRemoval(req.crmUser, req.params.id, { approve: false, note: req.body?.note }),
);
doctorRoute("get", "/crm/today", "Today", (req) => todayView(req.crmUser, req.query));
doctorRoute("get", "/crm/tasks", "Tasks", (req) => listTasks(req.crmUser, req.query));
doctorRoute("post", "/crm/tasks", "Add task", (req) => createTask(req.crmUser, req.body));
doctorRoute("post", "/crm/tasks/:id/done", "Complete task", (req) =>
  completeTask(req.crmUser, req.params.id),
);
doctorRoute("post", "/crm/tasks/:id/cancel", "Cancel task", (req) =>
  cancelTask(req.crmUser, req.params.id, req.body),
);
doctorRoute("post", "/crm/tasks/:id/reopen", "Reopen task", (req) =>
  reopenTask(req.crmUser, req.params.id),
);
doctorRoute("put", "/crm/visits/:id", "Change visit", (req) =>
  editVisit(req.crmUser, req.params.id, req.body),
);
doctorRoute("post", "/crm/visits/:id/undo", "Undo visit", (req) =>
  undoVisit(req.crmUser, req.params.id, req.body),
);

router.get("/crm/doctors/:id", crm, async (req, res) => {
  try {
    res.json(await doctor360(req.crmUser, req.params.id));
  } catch (e) {
    doctorError(res, e, "Doctor 360");
  }
});

router.get("/crm/doctors/:id/next-visit", crm, async (req, res) => {
  try {
    res.json((await suggestedNextVisit(req.crmUser, req.params.id)) || {});
  } catch (e) {
    handleError(res, e, "Cadence lookup");
  }
});

// Idempotent on the client-generated id, which is what lets the offline queue
// retry without thinking. A replay returns 200 with duplicate:true rather than
// a conflict, so a queue draining after a flaky send does not see an error and
// keep the item forever.
router.post("/crm/visits", crm, express.json({ limit: "1mb" }), async (req, res) => {
  try {
    res.json(await logVisit(req.crmUser, req.body));
  } catch (e) {
    handleError(res, e, "Log visit");
  }
});

// Bulk A/B/C. Separate from PATCH /crm/doctors/:id because it is a different
// action with a different blast radius — one doctor versus a whole territory.
router.post("/crm/doctors/priority", crm, express.json(), async (req, res) => {
  try {
    res.json(await setPriority(req.crmUser, req.body));
  } catch (e) {
    handleError(res, e, "Set priority");
  }
});

router.patch("/crm/doctors/:id", crm, express.json(), async (req, res) => {
  try {
    res.json(await fillDoctorGap(req.crmUser, req.params.id, req.body));
  } catch (e) {
    handleError(res, e, "Update doctor");
  }
});

router.get("/crm/assignments", crm, importer, async (req, res) => {
  try {
    const { owner, territory, q, page } = req.query;
    res.json(await listAssignments(req.crmUser, { owner, territory, q, page }));
  } catch (e) {
    importError(res, e, "Assignments");
  }
});

router.post("/crm/assignments", crm, importer, express.json(), async (req, res) => {
  try {
    const { doctor_ids, executive_id } = req.body || {};
    res.json(
      await assignDoctors(req.crmUser, { doctorIds: doctor_ids, executiveId: executive_id }),
    );
  } catch (e) {
    importError(res, e, "Assign doctors");
  }
});

router.get("/crm/assignments/export.xlsx", crm, importer, async (req, res) => {
  try {
    const { owner, territory, q } = req.query;
    const { buffer } = await assignmentsWorkbook(req.crmUser, { owner, territory, q });
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", XLSX_TYPE);
    res.setHeader("Content-Disposition", `attachment; filename="crm-assignments-${day}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (e) {
    importError(res, e, "Assignments export");
  }
});

router.get("/crm/import/fields", crm, importer, (_req, res) => res.json(IMPORT_FIELDS));

router.use("/crm/import/batches/:id", crm, importer, async (req, res, next) => {
  try {
    await assertDoctorBatch(req.crmUser, req.params.id);
    next();
  } catch (e) {
    visitError(res, e, "Import");
  }
});

// Step 1 — read the file and guess the mapping. Nothing is stored yet.
router.post(
  "/crm/import/parse",
  crm,
  importer,
  express.raw({ type: "*/*", limit: "8mb" }),
  (req, res) => {
    try {
      const { headers, rows } = parseSheet(req.body, req.query.name || "upload");
      res.json({
        headers,
        suggested_mapping: suggestMapping(headers),
        total_rows: rows.length,
        sample: rows.slice(0, 5),
        // The mapping step only needs a sample; the preview step needs the lot.
        rows: req.query.full ? rows : undefined,
      });
    } catch (e) {
      handleError(res, e, "Import parse");
    }
  },
);

// Step 2 — store the rows with the operator's mapping.
router.post(
  "/crm/import/batches",
  crm,
  importer,
  express.json({ limit: "16mb" }),
  async (req, res) => {
    try {
      const { file_name, headers, rows, mapping } = req.body;
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: "No rows to import" });
      }
      const mapped = Object.values(mapping || {});
      if (mapped.includes("assigned_to") || mapped.includes("doctor_id")) {
        assertCanAssign(req.crmUser);
      }
      res.json(await createBatch(req.crmUser, { fileName: file_name, headers, rows, mapping }));
    } catch (e) {
      handleError(res, e, "Import batch");
    }
  },
);

// Step 3 — resolve, dedup and flag. Still writes nothing to crm.doctors.
router.get("/crm/import/batches/:id/preview", crm, importer, async (req, res) => {
  try {
    res.json(await previewBatch(req.crmUser, req.params.id));
  } catch (e) {
    handleError(res, e, "Import preview");
  }
});

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function importError(res, e, context) {
  if (e instanceof ImportAssignError || e instanceof AssignmentError) {
    return res.status(e.status).json({ error: e.message });
  }
  console.error(`${context} error:`, e?.message, e?.detail || "", e?.stack || "");
  const message =
    e?.code === "23505"
      ? "A doctor in this file already exists in the CRM. Build the preview again and retry."
      : `${context} failed. Try again; if it keeps failing, contact an administrator.`;
  res.status(e?.code === "23505" ? 409 : 500).json({ error: message });
}

router.get("/crm/import/assignees", crm, importer, async (req, res) => {
  try {
    assertCanAssign(req.crmUser);
    res.json(await listAssignees(req.crmUser));
  } catch (e) {
    importError(res, e, "Staff list");
  }
});

router.get("/crm/import/template.xlsx", crm, importer, async (req, res) => {
  try {
    assertCanAssign(req.crmUser);
    const { buffer } = await templateWorkbook(req.crmUser);
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", XLSX_TYPE);
    res.setHeader("Content-Disposition", `attachment; filename="crm-doctors-template-${day}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (e) {
    importError(res, e, "Doctors template");
  }
});

router.post("/crm/import/batches/:id/resolve", crm, importer, async (req, res) => {
  try {
    res.json(await resolveBatch(req.crmUser, req.params.id));
  } catch (e) {
    importError(res, e, "Import preview");
  }
});

router.get("/crm/import/batches/:id/summary", crm, importer, async (req, res) => {
  try {
    res.json(await batchSummary(req.crmUser, req.params.id));
  } catch (e) {
    importError(res, e, "Import summary");
  }
});

router.get("/crm/import/batches/:id/rows", crm, importer, async (req, res) => {
  try {
    const { status, q, page } = req.query;
    res.json(await pagedPreview(req.crmUser, req.params.id, { status, q, page }));
  } catch (e) {
    importError(res, e, "Import rows");
  }
});

router.post("/crm/import/batches/:id/commit", crm, importer, express.json(), async (req, res) => {
  try {
    const skipRows = Array.isArray(req.body?.skip_rows) ? req.body.skip_rows : [];
    res.json(await commitChunk(req.crmUser, req.params.id, { skipRows }));
  } catch (e) {
    importError(res, e, "Import");
  }
});

router.post("/crm/import/batches/:id/pick", crm, importer, express.json(), async (req, res) => {
  try {
    assertCanAssign(req.crmUser);
    res.json(await pickAssignee(req.crmUser, req.params.id, req.body || {}));
  } catch (e) {
    importError(res, e, "Choose staff");
  }
});

router.post("/crm/import/batches/:id/retry", crm, importer, express.json(), async (req, res) => {
  try {
    assertCanAssign(req.crmUser);
    res.json(await retryRows(req.crmUser, req.params.id, req.body?.rows));
  } catch (e) {
    importError(res, e, "Retry");
  }
});

router.get("/crm/import/batches/:id/failed.xlsx", crm, importer, async (req, res) => {
  try {
    const { buffer, fileName } = await failedWorkbook(req.crmUser, req.params.id);
    res.setHeader("Content-Type", XLSX_TYPE);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName.replace(/"/g, "")}"`);
    res.send(Buffer.from(buffer));
  } catch (e) {
    importError(res, e, "Failed rows export");
  }
});

function visitError(res, e, context) {
  if (e instanceof VisitSheetError) return res.status(e.status).json({ error: e.message });
  console.error(`${context} error:`, e?.message, e?.detail || "");
  res.status(500).json({
    error: `${context} failed. Please try again. If the problem continues, contact an administrator.`,
  });
}

const sendXlsx = (res, buffer, fileName) => {
  const safe =
    String(fileName)
      .replace(/[^\w.\- ]+/g, "_")
      .slice(0, 150) || "visits.xlsx";
  res.setHeader("Content-Type", XLSX_TYPE);
  res.setHeader("Content-Disposition", `attachment; filename="${safe}"`);
  res.send(Buffer.from(buffer));
};

router.get("/crm/visits/sheet.xlsx", crm, async (req, res) => {
  try {
    const { buffer, fileName } = await visitSheetWorkbook(req.crmUser);
    sendXlsx(res, buffer, fileName);
  } catch (e) {
    visitError(res, e, "Visit sheet download");
  }
});

router.get("/crm/visits/doctors", crm, async (req, res) => {
  try {
    res.json(await pickableDoctors(req.crmUser, req.query.q));
  } catch (e) {
    visitError(res, e, "Doctor list");
  }
});

router.get("/crm/visits/import/batches", crm, async (req, res) => {
  try {
    res.json(await myVisitBatches(req.crmUser));
  } catch (e) {
    visitError(res, e, "Uploads");
  }
});

router.post(
  "/crm/visits/import/batches",
  crm,
  express.raw({ type: "*/*", limit: "5mb" }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ error: "Choose an Excel file to upload." });
      }
      res.json(
        await createVisitBatch(req.crmUser, {
          fileName: String(req.query.name || "visits.xlsx"),
          buffer: req.body,
        }),
      );
    } catch (e) {
      visitError(res, e, "Visit upload");
    }
  },
);

router.get("/crm/visits/import/batches/:id/summary", crm, async (req, res) => {
  try {
    res.json(await visitBatchSummary(req.crmUser, req.params.id));
  } catch (e) {
    visitError(res, e, "Upload summary");
  }
});

router.get("/crm/visits/import/batches/:id/rows", crm, async (req, res) => {
  try {
    const { state, q, page } = req.query;
    res.json(await visitBatchRows(req.crmUser, req.params.id, { state, q, page }));
  } catch (e) {
    visitError(res, e, "Upload rows");
  }
});

router.post("/crm/visits/import/batches/:id/commit", crm, async (req, res) => {
  try {
    res.json(await commitVisitChunk(req.crmUser, req.params.id));
  } catch (e) {
    visitError(res, e, "Visit import");
  }
});

router.post("/crm/visits/import/batches/:id/retry", crm, express.json(), async (req, res) => {
  try {
    res.json(await retryVisitRows(req.crmUser, req.params.id, req.body?.rows));
  } catch (e) {
    visitError(res, e, "Retry");
  }
});

router.post("/crm/visits/import/batches/:id/undo", crm, async (req, res) => {
  try {
    res.json(await undoVisitBatch(req.crmUser, req.params.id));
  } catch (e) {
    visitError(res, e, "Undo upload");
  }
});

router.get("/crm/visits/import/batches/:id/failed.xlsx", crm, async (req, res) => {
  try {
    const { buffer, fileName } = await failedVisitWorkbook(req.crmUser, req.params.id);
    sendXlsx(res, buffer, fileName);
  } catch (e) {
    visitError(res, e, "Failed rows export");
  }
});

function progressError(res, e, context) {
  if (e instanceof ProgressError) return res.status(e.status).json({ error: e.message });
  console.error(`${context} error:`, e?.message, e?.detail || "");
  res.status(500).json({ error: `Unable to load ${context.toLowerCase()}. Please try again.` });
}

router.get("/crm/progress", crm, async (req, res) => {
  try {
    res.json(await progressReport(req.crmUser, req.query));
  } catch (e) {
    progressError(res, e, "Progress");
  }
});

router.get("/crm/progress/doctors", crm, async (req, res) => {
  try {
    res.json(await progressDoctors(req.crmUser, req.query));
  } catch (e) {
    progressError(res, e, "Doctor list");
  }
});

router.get("/crm/progress/export.xlsx", crm, async (req, res) => {
  try {
    const { buffer, fileName } = await progressWorkbook(req.crmUser, req.query);
    sendXlsx(res, buffer, fileName);
  } catch (e) {
    progressError(res, e, "Progress report");
  }
});

export default router;
