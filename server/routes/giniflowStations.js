import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { requireCapability } from "../middleware/auth.js";
import {
  getRxQueue,
  getRxPatient,
  startRxExplain,
  markRxExplained,
} from "../services/giniflow/rxStation.js";
import { fetchRxFile, regenerateRx } from "../services/giniflow/printRx.js";
import { validate, validateQuery } from "../middleware/validate.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import { blockActor, blockedResponse } from "../services/patientBlockGuard.js";
import {
  giniflowRxItemSchema,
  giniflowRxItemPatchSchema,
  giniflowRxDecisionSchema,
  giniflowAllergySchema,
  giniflowRxPauseSchema,
  giniflowRxStopSchema,
  giniflowMedSearchQuerySchema,
  giniflowExternalMedSchema,
  giniflowFinalizeSchema,
  giniflowDoctorQueueQuerySchema,
  giniflowCarePlanSchema,
  giniflowProposalDecisionSchema,
  giniflowDateQuerySchema,
  giniflowStationQuerySchema,
  giniflowMoQueueQuerySchema,
  giniflowPaymentSchema,
  giniflowLabCaseActionSchema,
  giniflowReportSchema,
  giniflowOrderTestsSchema,
  giniflowCatalogTestSchema,
  giniflowCatalogTestPatchSchema,
  giniflowPlanSchema,
  giniflowPlanExtractSchema,
  giniflowProposalSchema,
  giniflowSampleSchema,
  giniflowVitalsSchema,
  giniflowDispenseSchema,
  giniflowDispenseAllSchema,
  giniflowArrivalsQuerySchema,
  giniflowCancelSchema,
  giniflowWalkInSchema,
  giniflowSearchQuerySchema,
  giniflowReferralQuerySchema,
  giniflowReferralSchema,
  giniflowReferralResponseSchema,
  giniflowReferralChipSchema,
  giniflowReferralLetterSchema,
  giniflowReferralSendSchema,
  giniflowReferralAppointmentSchema,
  giniflowReferralCompleteSchema,
  giniflowInteractionAckSchema,
} from "../schemas/index.js";
import {
  getVitalsQueue,
  getVitalsPatient,
  saveVitals,
  saveAllergy,
  startVitals,
  releaseVitals,
} from "../services/giniflow/vitalsStation.js";
import {
  getPaymentQueue,
  clearPayment,
  getTestCatalog,
  getArrivals,
  markArrived,
  markNoShow,
  markCancelled,
  undoArrival,
  searchWalkInPatients,
  checkInWalkIn,
} from "../services/giniflow/receptionStation.js";
import {
  getLabQueue,
  advanceSample,
  markLabCaseAction,
  uploadLabCaseReport,
  uploadReport,
  fetchStoredReport,
} from "../services/giniflow/labStation.js";
import {
  getReferrals,
  searchReferralPatients,
  createReferral,
  removeReferral,
  renderLetter,
  fetchStoredLetter,
  loadReferralHeader,
  generateLetter,
  sendLetter,
  bookAppointment,
  completeReferral,
  recordResponse,
  referralsForVisit,
} from "../services/giniflow/referralsStation.js";
import { extractPlan } from "../services/giniflow/planExtract.js";
import {
  getMoQueue,
  getMoPatient,
  startWorkup,
  savePlan,
  addProposal,
  withdrawProposal,
  getTestPanels,
  orderTests,
  readyForDoctor,
  releaseWorkup,
  takeOver,
  closeWithoutDoctor,
} from "../services/giniflow/moStation.js";
import {
  addCatalogTest,
  listCatalog,
  updateCatalogTest,
} from "../services/giniflow/testCatalog.js";
import {
  getDoctorQueue,
  getConsult,
  getTrend,
  startConsult,
  releaseConsult,
  saveCarePlan,
  decideProposal,
  visitOwnership,
  rowOwnership,
} from "../services/giniflow/doctorStation.js";
import {
  getDraft,
  seedDraftFromRegimen,
  addItem,
  updateItem,
  decideItem,
  removeItem,
  pauseItem,
  stopItem,
  searchMedicines,
  alternativesFor,
  addExternal,
} from "../services/giniflow/prescription.js";
import { checkVisit, acknowledge } from "../services/giniflow/interactions.js";
import { buildCard } from "../services/giniflow/medicineCard.js";
import {
  finalizeConsult,
  finalizePreview,
  fastPathFinalize,
} from "../services/giniflow/finalize.js";
import {
  getPharmacyQueue,
  getPharmacyPatient,
  dispenseItem,
  dispenseAll,
  sendCardToPatient,
} from "../services/giniflow/pharmacyStation.js";
import { generateMedicineCardPdf } from "../services/giniflow/medicineCardPdf.js";
import { getStationSummary } from "../services/giniflow/stationSummary.js";
import { hasCapability } from "../../shared/permissions.js";

const router = Router();

const istToday = async () =>
  (await pool.query(`SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).rows[0].d;

const resolveDate = async (raw) => raw || (await istToday());

const vitalsGate = requireCapability(CAP.GINIFLOW_STATION_VITALS);

// "Someone is already at your station" is a refusal the nurse can act on, so it
// reaches them as a 409 with the reason — not a 500 the toast cannot explain.
const vitalsError = (res, e, label) =>
  e?.status && e.status < 500
    ? res.status(e.status).json({ error: e.message })
    : handleError(res, e, label);

router.get(
  "/giniflow/stations/vitals/queue",
  vitalsGate,
  validateQuery(giniflowDateQuerySchema),
  async (req, res) => {
    try {
      const date = await resolveDate(req.query.date);
      const data = await getVitalsQueue(date);
      res.json({ date, ...data, serverTime: new Date().toISOString() });
    } catch (e) {
      handleError(res, e, "Gini Flow vitals queue");
    }
  },
);

router.get("/giniflow/stations/vitals/:visitId", vitalsGate, async (req, res) => {
  try {
    const patient = await getVitalsPatient(req.params.visitId);
    if (!patient) return res.status(404).json({ error: "Visit not found" });
    res.json(patient);
  } catch (e) {
    handleError(res, e, "Gini Flow vitals patient");
  }
});

// The allergy question, asked where the patient is already sitting down
// (24-ADDENDUM-V11-PLAN.md §5.1). Recorded against the patient, so every station
// reads the same answer.
router.post(
  "/giniflow/stations/vitals/:visitId/allergy",
  vitalsGate,
  validate(giniflowAllergySchema),
  async (req, res) => {
    try {
      res.json(
        await saveAllergy(req.params.visitId, {
          ...req.body,
          actorId: req.doctor?.doctor_id ?? null,
        }),
      );
    } catch (e) {
      handleError(res, e, "Gini Flow allergy");
    }
  },
);

router.post("/giniflow/stations/vitals/:visitId/start", vitalsGate, async (req, res) => {
  try {
    res.json(await startVitals(req.params.visitId, req.doctor?.doctor_id ?? null));
  } catch (e) {
    vitalsError(res, e, "Gini Flow vitals start");
  }
});

router.post("/giniflow/stations/vitals/:visitId/release", vitalsGate, async (req, res) => {
  try {
    res.json(await releaseVitals(req.params.visitId, req.doctor?.doctor_id ?? null));
  } catch (e) {
    vitalsError(res, e, "Gini Flow vitals release");
  }
});

router.post(
  "/giniflow/stations/vitals/:visitId",
  vitalsGate,
  validate(giniflowVitalsSchema),
  async (req, res) => {
    try {
      const saved = await saveVitals(req.params.visitId, {
        ...req.body,
        actorId: req.doctor?.doctor_id ?? null,
      });
      res.json(saved);
    } catch (e) {
      handleError(res, e, "Gini Flow vitals save");
    }
  },
);

// ── Consultant station ──────────────────────────────────────────────────────
// docs/gini-flow/13-CONSULTANT-STATION-PLAN.md §11. The queue, the consult, and
// the two things the consultant writes before Finalize: the care plan and a
// decision on each of the MO's medicine proposals.

const doctorGate = requireCapability(CAP.GINIFLOW_STATION_DOCTOR);

// A consultant may OPEN another consultant's patient — the queue's second column
// exists so the floor can be seen whole — but may not write to them. Read-only
// in the UI is not enough on its own: the page is one URL, and anything that can
// be opened can be POSTed to. So every write below the visit is gated here.
//
// Unassigned patients are deliberately still writable. Nobody has claimed them,
// so opening one IS the claim, which is how the queue's "Mine" column already
// counts them.
// Admin overrides the whole rule. An admin holds every capability by definition
// (ROLES.ADMIN => ALL), and the point of the account is that nothing on the
// floor is closed to it — so ownership never makes an admin read-only.
const overridesOwnership = (req) => hasCapability(req.doctor?.role, CAP.ADMIN);

const requireOwnVisit = async (req, res, next) => {
  if (overridesOwnership(req)) return next();
  try {
    const { found, readOnly, ownerName } = await visitOwnership(
      req.params.visitId,
      req.doctor?.doctor_id ?? null,
    );
    if (!found) return res.status(404).json({ error: "Visit not found" });
    if (readOnly)
      return res.status(403).json({
        error: `${ownerName || "Another consultant"} is assigned to this patient — you have read-only access`,
        readOnly: true,
      });
    next();
  } catch (e) {
    handleError(res, e, "Gini Flow visit ownership");
  }
};

// Same rule for the row-keyed endpoints, which carry no :visitId of their own.
const requireOwnRow = (table, param) => async (req, res, next) => {
  if (overridesOwnership(req)) return next();
  try {
    const { found, readOnly, ownerName } = await rowOwnership(
      table,
      req.params[param],
      req.doctor?.doctor_id ?? null,
    );
    if (!found) return res.status(404).json({ error: "Not found" });
    if (readOnly)
      return res.status(403).json({
        error: `${ownerName || "Another consultant"} is assigned to this patient — you have read-only access`,
        readOnly: true,
      });
    next();
  } catch (e) {
    handleError(res, e, "Gini Flow row ownership");
  }
};
const requireOwnRxItem = requireOwnRow("giniflow_rx_items", "itemId");
const requireOwnProposal = requireOwnRow("giniflow_rx_proposals", "id");

// A clinical refusal the consultant can act on ("someone is already in the
// room", "rejecting needs a reason") is a 409 with the reason, never a 500.
const doctorError = (res, e, label) =>
  e?.status && e.status < 500
    ? res.status(e.status).json({ error: e.message })
    : handleError(res, e, label);

router.get(
  "/giniflow/stations/doctor/queue",
  doctorGate,
  validateQuery(giniflowDoctorQueueQuerySchema),
  async (req, res) => {
    try {
      const date = await resolveDate(req.query.date);
      const data = await getDoctorQueue(date, {
        doctorId: req.doctor?.doctor_id ?? null,
        scope: req.query.scope || "mine",
        q: req.query.q,
      });
      res.json({ date, ...data, serverTime: new Date().toISOString() });
    } catch (e) {
      doctorError(res, e, "Gini Flow doctor queue");
    }
  },
);

// The same panels and catalog the MO station orders from — one source, so the
// two stations cannot offer different tests. Gated on the consultant's own
// capability rather than borrowing the MO's.
router.get("/giniflow/stations/doctor/test-panels", doctorGate, async (req, res) => {
  try {
    res.json(await getTestPanels());
  } catch (e) {
    doctorError(res, e, "Gini Flow doctor test panels");
  }
});

// The catalogue itself — the clinic's price list. Admin only, and the ONLY way
// a test becomes visible to every patient: what a consultant types during a
// consultation rides on that patient's order instead (see orderTests).
router.post(
  "/giniflow/test-catalog",
  requireCapability(CAP.ADMIN),
  validate(giniflowCatalogTestSchema),
  async (req, res) => {
    try {
      res.status(201).json(await addCatalogTest(req.body.name, { gloss: req.body.gloss ?? null }));
    } catch (e) {
      handleError(res, e, "Gini Flow add test to catalogue");
    }
  },
);

router.get("/giniflow/test-catalog", requireCapability(CAP.ADMIN), async (req, res) => {
  try {
    res.json({ tests: await listCatalog() });
  } catch (e) {
    handleError(res, e, "Gini Flow test catalogue");
  }
});

router.patch(
  "/giniflow/test-catalog/:id",
  requireCapability(CAP.ADMIN),
  validate(giniflowCatalogTestPatchSchema),
  async (req, res) => {
    try {
      res.json(await updateCatalogTest(req.params.id, req.body));
    } catch (e) {
      handleError(res, e, "Gini Flow test catalogue update");
    }
  },
);

// These two are declared BEFORE /doctor/:visitId on purpose: Express matches in
// order, so "/doctor/medicines" would otherwise be read as a visit id called
// "medicines" and fail inside a uuid comparison.
router.get(
  "/giniflow/stations/doctor/medicines",
  doctorGate,
  validateQuery(giniflowMedSearchQuerySchema),
  async (req, res) => {
    try {
      res.json({ results: await searchMedicines(req.query.q) });
    } catch (e) {
      doctorError(res, e, "Gini Flow medicine search");
    }
  },
);

// Same-class substitutes that are in stock. `known: false` means the inventory
// has never heard of this medicine — which the screen must say, rather than
// showing an empty list that reads as "no alternatives exist".
router.get("/giniflow/stations/doctor/medicines/alternatives", doctorGate, async (req, res) => {
  try {
    res.json(await alternativesFor(String(req.query.name || "")));
  } catch (e) {
    doctorError(res, e, "Gini Flow alternatives");
  }
});

router.get("/giniflow/stations/doctor/:visitId", doctorGate, async (req, res) => {
  try {
    const consult = await getConsult(req.params.visitId);
    if (!consult) return res.status(404).json({ error: "Visit not found" });
    // Decided here rather than in the browser so the page and the gate that
    // refuses its writes can never disagree about who owns this patient.
    const owned = await visitOwnership(req.params.visitId, req.doctor?.doctor_id ?? null);
    const readOnly = owned.readOnly && !overridesOwnership(req);
    res.json({
      ...consult,
      readOnly,
      readOnlyOwner: readOnly ? owned.ownerName : null,
      serverTime: new Date().toISOString(),
    });
  } catch (e) {
    doctorError(res, e, "Gini Flow consult");
  }
});

router.get("/giniflow/stations/doctor/:visitId/trend/:marker", doctorGate, async (req, res) => {
  try {
    const consult = await getConsult(req.params.visitId);
    if (!consult) return res.status(404).json({ error: "Visit not found" });
    res.json(await getTrend(consult.patientId, req.params.marker));
  } catch (e) {
    doctorError(res, e, "Gini Flow consult trend");
  }
});

router.post(
  "/giniflow/stations/doctor/:visitId/start",
  doctorGate,
  requireOwnVisit,
  async (req, res) => {
    try {
      res.json(await startConsult(req.params.visitId, req.doctor?.doctor_id ?? null));
    } catch (e) {
      doctorError(res, e, "Gini Flow start consult");
    }
  },
);

router.post(
  "/giniflow/stations/doctor/:visitId/release",
  doctorGate,
  requireOwnVisit,
  async (req, res) => {
    try {
      res.json(await releaseConsult(req.params.visitId, req.doctor?.doctor_id ?? null));
    } catch (e) {
      doctorError(res, e, "Gini Flow release consult");
    }
  },
);

router.put(
  "/giniflow/stations/doctor/:visitId/care-plan",
  doctorGate,
  requireOwnVisit,
  validate(giniflowCarePlanSchema),
  async (req, res) => {
    try {
      res.json(await saveCarePlan(req.params.visitId, req.body, req.doctor?.doctor_id ?? null));
    } catch (e) {
      doctorError(res, e, "Gini Flow care plan");
    }
  },
);

router.patch(
  "/giniflow/stations/doctor/proposals/:id",
  doctorGate,
  requireOwnProposal,
  validate(giniflowProposalDecisionSchema),
  async (req, res) => {
    try {
      res.json(await decideProposal(req.params.id, req.body, req.doctor?.doctor_id ?? null));
    } catch (e) {
      doctorError(res, e, "Gini Flow proposal decision");
    }
  },
);

// ── Consultant · prescription, card, finalize ───────────────────────────────
// docs/gini-flow/14-CONSULTANT-PRESCRIPTION-PLAN.md §9.

router.get("/giniflow/stations/doctor/:visitId/prescription", doctorGate, async (req, res) => {
  try {
    res.json(await getDraft(req.params.visitId));
  } catch (e) {
    doctorError(res, e, "Gini Flow prescription draft");
  }
});

// The interaction check over the combined list — this prescription plus the
// medicines another hospital started (24-ADDENDUM-V11-PLAN.md §5.2). Read on
// demand rather than folded into the draft: the draft is fetched on every
// keystroke of a medicine search, and this is not free.
router.get("/giniflow/stations/doctor/:visitId/interactions", doctorGate, async (req, res) => {
  try {
    res.json(await checkVisit(req.params.visitId));
  } catch (e) {
    doctorError(res, e, "Gini Flow interaction check");
  }
});

// Prescribing a severe interaction deliberately, with the reason on the record.
router.post(
  "/giniflow/stations/doctor/:visitId/interactions/ack",
  doctorGate,
  requireOwnVisit,
  validate(giniflowInteractionAckSchema),
  async (req, res) => {
    try {
      res.json(await acknowledge(req.params.visitId, req.body, req.user?.id ?? null));
    } catch (e) {
      doctorError(res, e, "Gini Flow interaction acknowledgement");
    }
  },
);

// Seeds the draft from what the patient is already taking. Not automatic: the
// consultant decides when the consultation starts writing.
router.post(
  "/giniflow/stations/doctor/:visitId/prescription/seed",
  doctorGate,
  requireOwnVisit,
  async (req, res) => {
    try {
      res.json(await seedDraftFromRegimen(req.params.visitId));
    } catch (e) {
      doctorError(res, e, "Gini Flow prescription seed");
    }
  },
);

router.post(
  "/giniflow/stations/doctor/:visitId/prescription/items",
  doctorGate,
  requireOwnVisit,
  validate(giniflowRxItemSchema),
  async (req, res) => {
    try {
      res.json(await addItem(req.params.visitId, req.body));
    } catch (e) {
      doctorError(res, e, "Gini Flow add medicine");
    }
  },
);

// Approve · Adjust · Reject on a proposed row (addendum v1.1 §3). Adjust is
// recorded by the PATCH below — editing a pending row is the decision — so this
// carries the two explicit ones.
router.post(
  "/giniflow/stations/doctor/prescription/items/:itemId/decide",
  doctorGate,
  requireOwnRxItem,
  validate(giniflowRxDecisionSchema),
  async (req, res) => {
    try {
      res.json(await decideItem(req.params.itemId, req.body, req.doctor?.doctor_id ?? null));
    } catch (e) {
      doctorError(res, e, "Gini Flow decide proposal");
    }
  },
);

router.patch(
  "/giniflow/stations/doctor/prescription/items/:itemId",
  doctorGate,
  requireOwnRxItem,
  validate(giniflowRxItemPatchSchema),
  async (req, res) => {
    try {
      res.json(
        await updateItem(req.params.itemId, {
          ...req.body,
          actorId: req.doctor?.doctor_id ?? null,
        }),
      );
    } catch (e) {
      doctorError(res, e, "Gini Flow edit medicine");
    }
  },
);

router.delete(
  "/giniflow/stations/doctor/prescription/items/:itemId",
  doctorGate,
  requireOwnRxItem,
  async (req, res) => {
    try {
      res.json(await removeItem(req.params.itemId));
    } catch (e) {
      doctorError(res, e, "Gini Flow remove medicine");
    }
  },
);

router.post(
  "/giniflow/stations/doctor/prescription/items/:itemId/pause",
  doctorGate,
  requireOwnRxItem,
  validate(giniflowRxPauseSchema),
  async (req, res) => {
    try {
      res.json(await pauseItem(req.params.itemId, req.body.weeks));
    } catch (e) {
      doctorError(res, e, "Gini Flow pause medicine");
    }
  },
);

router.post(
  "/giniflow/stations/doctor/prescription/items/:itemId/stop",
  doctorGate,
  requireOwnRxItem,
  validate(giniflowRxStopSchema),
  async (req, res) => {
    try {
      res.json(await stopItem(req.params.itemId, req.body.reason));
    } catch (e) {
      doctorError(res, e, "Gini Flow stop medicine");
    }
  },
);

router.post(
  "/giniflow/stations/doctor/:visitId/external",
  doctorGate,
  requireOwnVisit,
  validate(giniflowExternalMedSchema),
  async (req, res) => {
    try {
      const draft = await getDraft(req.params.visitId);
      res.json(await addExternal(draft.patientId, req.body));
    } catch (e) {
      doctorError(res, e, "Gini Flow add external medicine");
    }
  },
);

router.post(
  "/giniflow/stations/doctor/:visitId/tests",
  doctorGate,
  requireOwnVisit,
  validate(giniflowOrderTestsSchema),
  async (req, res) => {
    try {
      res.json(
        await orderTests(req.params.visitId, {
          urgency: req.body.urgency,
          tests: req.body.tests,
          customTests: req.body.customTests,
          actorId: req.doctor?.doctor_id ?? null,
        }),
      );
    } catch (e) {
      doctorError(res, e, "Gini Flow doctor order tests");
    }
  },
);

// The card, printed. Server-side because window.print() prints the whole
// consultation screen, and what the patient carries home is the schedule alone.
router.get("/giniflow/stations/doctor/:visitId/medicine-card.pdf", doctorGate, async (req, res) => {
  try {
    const { pdf, fileName } = await generateMedicineCardPdf(req.params.visitId);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
    res.send(Buffer.from(pdf));
  } catch (e) {
    handleError(res, e, "Gini Flow medicine card PDF");
  }
});

router.get("/giniflow/stations/doctor/:visitId/medicine-card", doctorGate, async (req, res) => {
  try {
    const draft = await getDraft(req.params.visitId);
    res.json(await buildCard(draft.patientId));
  } catch (e) {
    doctorError(res, e, "Gini Flow medicine card");
  }
});

router.get("/giniflow/stations/doctor/:visitId/finalize", doctorGate, async (req, res) => {
  try {
    res.json(await finalizePreview(req.params.visitId));
  } catch (e) {
    doctorError(res, e, "Gini Flow finalize preview");
  }
});

// The 30-second visit (addendum v1.1 §2). One endpoint, because a network drop
// between "order tests" and "finalize" must not leave a patient billed for a
// panel and still sitting in the room.
router.post(
  "/giniflow/stations/doctor/:visitId/fast-finalize",
  doctorGate,
  requireOwnVisit,
  async (req, res) => {
    try {
      res.json(await fastPathFinalize(req.params.visitId, req.doctor?.doctor_id ?? null));
    } catch (e) {
      doctorError(res, e, "Gini Flow fast path");
    }
  },
);

router.post(
  "/giniflow/stations/doctor/:visitId/finalize",
  doctorGate,
  requireOwnVisit,
  validate(giniflowFinalizeSchema),
  async (req, res) => {
    try {
      res.json(await finalizeConsult(req.params.visitId, req.doctor?.doctor_id ?? null));
    } catch (e) {
      doctorError(res, e, "Gini Flow finalize");
    }
  },
);

// ── Launcher ────────────────────────────────────────────────────────────────
// Every station's count in one call, filtered to the stations this role may
// open. A tile that appears and then 403s is worse than no tile.
const STATION_CAPS = {
  manager: CAP.GINIFLOW_VIEW,
  vitals: CAP.GINIFLOW_STATION_VITALS,
  reception: CAP.GINIFLOW_STATION_RECEPTION,
  lab: CAP.GINIFLOW_STATION_LAB,
  mo_sd: CAP.GINIFLOW_STATION_MO,
  doctor: CAP.GINIFLOW_STATION_DOCTOR,
  rx: CAP.GINIFLOW_STATION_RX,
  pharmacy: CAP.GINIFLOW_STATION_PHARMACY,
  triage: CAP.GINIFLOW_TRIAGE,
  referrals: CAP.GINIFLOW_REFERRALS,
};

router.get(
  "/giniflow/stations/summary",
  validateQuery(giniflowDateQuerySchema),
  async (req, res) => {
    try {
      const date = await resolveDate(req.query.date);
      const summary = await getStationSummary(date);
      const role = req.doctor?.role;
      const allowed = Object.fromEntries(
        Object.entries(STATION_CAPS).filter(([, cap]) => hasCapability(role, cap)),
      );
      res.json({
        date,
        stations: Object.fromEntries(Object.keys(allowed).map((k) => [k, summary[k]])),
        bottleneck: summary.bottleneck,
        serverTime: new Date().toISOString(),
      });
    } catch (e) {
      handleError(res, e, "Gini Flow station summary");
    }
  },
);

// ── Reception ───────────────────────────────────────────────────────────────
const receptionGate = requireCapability(CAP.GINIFLOW_STATION_RECEPTION);

router.get(
  "/giniflow/stations/reception/queue",
  receptionGate,
  validateQuery(giniflowDateQuerySchema),
  async (req, res) => {
    try {
      const date = await resolveDate(req.query.date);
      const data = await getPaymentQueue(date);
      res.json({ date, ...data, serverTime: new Date().toISOString() });
    } catch (e) {
      handleError(res, e, "Gini Flow reception queue");
    }
  },
);

router.get("/giniflow/stations/reception/catalog", receptionGate, async (req, res) => {
  try {
    res.json({ tests: await getTestCatalog() });
  } catch (e) {
    handleError(res, e, "Gini Flow test catalog");
  }
});

// ⚠️ Route order: every literal path below must be registered BEFORE the
// parameterised ones — `/reception/:orderId/clear` already lives on this prefix,
// and the consultant station shipped this exact bug once (`GET /doctor/medicines`
// swallowed by `/doctor/:visitId`).
router.get(
  "/giniflow/stations/reception/arrivals",
  receptionGate,
  validateQuery(giniflowArrivalsQuerySchema),
  async (req, res) => {
    try {
      const date = await resolveDate(req.query.date);
      const data = await getArrivals(date, req.query.q || "");
      res.json({ date, ...data, serverTime: new Date().toISOString() });
    } catch (e) {
      handleError(res, e, "Gini Flow arrivals");
    }
  },
);

// Who the desk can put on the floor by hand. Scoped to a search and capped, so
// it cannot become a back-door patient directory.
router.get(
  "/giniflow/stations/reception/walk-in/search",
  receptionGate,
  validateQuery(giniflowSearchQuerySchema),
  async (req, res) => {
    try {
      const date = await resolveDate(req.query.date);
      res.json({
        date,
        results: await searchWalkInPatients(date, req.query.q, req.doctor?.role),
      });
    } catch (e) {
      handleError(res, e, "Gini Flow walk-in search");
    }
  },
);

router.post(
  "/giniflow/stations/reception/walk-in",
  receptionGate,
  validate(giniflowWalkInSchema),
  async (req, res) => {
    try {
      res.json(
        await checkInWalkIn(
          {
            patientId: req.body.patientId,
            appointmentId: req.body.appointmentId ?? null,
            force: req.body.force,
            role: req.doctor?.role,
            actor: blockActor(req),
          },
          req.doctor?.doctor_id ?? null,
        ),
      );
    } catch (e) {
      if (e.blocked) return res.status(409).json(blockedResponse(e.blocked));
      handleError(res, e, "Gini Flow walk-in check-in");
    }
  },
);

router.post("/giniflow/stations/reception/:visitId/arrived", receptionGate, async (req, res) => {
  try {
    res.json(await markArrived(req.params.visitId, req.doctor?.doctor_id ?? null));
  } catch (e) {
    handleError(res, e, "Gini Flow mark arrived");
  }
});

router.post("/giniflow/stations/reception/:visitId/no-show", receptionGate, async (req, res) => {
  try {
    res.json(await markNoShow(req.params.visitId, req.doctor?.doctor_id ?? null));
  } catch (e) {
    handleError(res, e, "Gini Flow mark no-show");
  }
});

router.post(
  "/giniflow/stations/reception/:visitId/cancel",
  receptionGate,
  validate(giniflowCancelSchema),
  async (req, res) => {
    try {
      res.json(
        await markCancelled(req.params.visitId, req.body.reason, req.doctor?.doctor_id ?? null),
      );
    } catch (e) {
      handleError(res, e, "Gini Flow cancel visit");
    }
  },
);

router.post("/giniflow/stations/reception/:visitId/undo", receptionGate, async (req, res) => {
  try {
    res.json(await undoArrival(req.params.visitId, req.doctor?.doctor_id ?? null));
  } catch (e) {
    handleError(res, e, "Gini Flow undo arrival");
  }
});

router.post(
  "/giniflow/stations/reception/:orderId/clear",
  receptionGate,
  validate(giniflowPaymentSchema),
  async (req, res) => {
    try {
      res.json(
        await clearPayment(req.params.orderId, {
          method: req.body.method,
          actorId: req.doctor?.doctor_id ?? null,
        }),
      );
    } catch (e) {
      handleError(res, e, "Gini Flow clear payment");
    }
  },
);

// ── Lab ─────────────────────────────────────────────────────────────────────
const labGate = requireCapability(CAP.GINIFLOW_STATION_LAB);

router.get(
  "/giniflow/stations/lab/queue",
  labGate,
  validateQuery(giniflowStationQuerySchema),
  async (req, res) => {
    try {
      const date = await resolveDate(req.query.date);
      const data = await getLabQueue(date, req.query.q ?? null);
      res.json({ date, ...data, serverTime: new Date().toISOString() });
    } catch (e) {
      handleError(res, e, "Gini Flow lab queue");
    }
  },
);

// Literal path BEFORE the parameterised ones on this prefix — `/lab/:orderId/...`
// would otherwise swallow it, which is the bug this file already warns about.
router.post(
  "/giniflow/stations/lab/case/:caseNo/action",
  labGate,
  validate(giniflowLabCaseActionSchema),
  async (req, res) => {
    try {
      res.json(
        await markLabCaseAction(req.params.caseNo, {
          action: req.body.action,
          note: req.body.note ?? null,
          undo: req.body.undo === true,
          actorId: req.doctor?.doctor_id ?? null,
          actorRole: req.doctor?.role || "lab",
        }),
      );
    } catch (e) {
      handleError(res, e, "Gini Flow lab case action");
    }
  },
);

// Attaching a report to a HealthRay-run case. Admin-gated rather than lab-gated:
// the sync normally fetches the file, so a human doing it by hand is an override
// of the automatic path, not part of the technician's routine.
router.post(
  "/giniflow/stations/lab/case/:caseNo/report",
  requireCapability(CAP.GINIFLOW_STATION_LAB),
  validate(giniflowReportSchema),
  async (req, res) => {
    if (req.doctor?.role !== "admin") {
      return res.status(403).json({ error: "Only an admin may attach a report to a lab case" });
    }
    try {
      res.json(
        await uploadLabCaseReport(req.params.caseNo, {
          base64: req.body.base64,
          fileName: req.body.fileName,
          mediaType: req.body.mediaType || "application/pdf",
          actorId: req.doctor?.doctor_id ?? null,
          confirmAdditional: req.body.confirmAdditional === true,
        }),
      );
    } catch (e) {
      if (e.needsConfirmation) {
        return res.status(409).json({
          error: e.message,
          needsConfirmation: e.needsConfirmation,
          existingSource: e.existingSource ?? null,
        });
      }
      handleError(res, e, "Gini Flow lab case report");
    }
  },
);

router.post(
  "/giniflow/stations/lab/:orderId/advance",
  labGate,
  validate(giniflowSampleSchema),
  async (req, res) => {
    try {
      res.json(
        await advanceSample(req.params.orderId, {
          to: req.body.to,
          reportUrl: req.body.reportUrl ?? null,
          actorId: req.doctor?.doctor_id ?? null,
        }),
      );
    } catch (e) {
      handleError(res, e, "Gini Flow lab advance");
    }
  },
);

// Uploading the report is what notifies the MO, so it is one call: store the
// file, then advance. A file in storage with the order still "results ready"
// would be a report nobody is told about.
router.post(
  "/giniflow/stations/lab/:orderId/report",
  labGate,
  validate(giniflowReportSchema),
  async (req, res) => {
    try {
      res.json(
        await uploadReport(req.params.orderId, {
          base64: req.body.base64,
          fileName: req.body.fileName,
          mediaType: req.body.mediaType,
          actorId: req.doctor?.doctor_id ?? null,
          confirmAdditional: req.body.confirmAdditional === true,
        }),
      );
    } catch (e) {
      if (e.needsConfirmation) {
        return res.status(409).json({
          error: e.message,
          needsConfirmation: e.needsConfirmation,
          existingUploadedAt: e.existingUploadedAt ?? null,
        });
      }
      handleError(res, e, "Gini Flow lab report upload");
    }
  },
);

// The uploaded report, inline.
//
// Proxied, never redirected: `patient-files` is a PRIVATE bucket, so the public
// URL Supabase composes 404s with "Bucket not found" — which is exactly what
// "View uploaded report" used to do. The bucket cannot be made public; it holds
// every patient's prescriptions and lab reports.
//
// Readable by anyone who can see the patient's labs, not just the lab: the MO
// and the consultant are the whole reason the upload notifies anybody.
router.get(
  "/giniflow/stations/lab/:orderId/report.file",
  requireCapability(CAP.GINIFLOW_VIEW),
  async (req, res) => {
    try {
      const { bytes, contentType, fileName } = await fetchStoredReport(req.params.orderId);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
      res.send(bytes);
    } catch (e) {
      handleError(res, e, "Gini Flow lab report");
    }
  },
);

// ── MO / SD ─────────────────────────────────────────────────────────────────
const moGate = requireCapability(CAP.GINIFLOW_STATION_MO);

// ── The MO pre-drafts ───────────────────────────────────────────────────────
// The same draft, the same service — but reached through the MO's own gate, so
// "this is a proposal" is a property of which station wrote it rather than a
// flag the browser sends. A consultant's row and an MO's row must not be
// distinguishable only by something the client can set.
router.get("/giniflow/stations/mo/:visitId/prescription", moGate, async (req, res) => {
  try {
    res.json(await getDraft(req.params.visitId));
  } catch (e) {
    handleError(res, e, "Gini Flow MO prescription");
  }
});

// The MO reads the same check — they are the one assembling the list, so they
// are the one who can still fix it before the consultant sees it. Only the
// consultant may override, which is why there is no MO ack route.
router.get("/giniflow/stations/mo/:visitId/interactions", moGate, async (req, res) => {
  try {
    res.json(await checkVisit(req.params.visitId));
  } catch (e) {
    handleError(res, e, "Gini Flow MO interaction check");
  }
});

router.post(
  "/giniflow/stations/mo/:visitId/external-medicines",
  moGate,
  validate(giniflowExternalMedSchema),
  async (req, res) => {
    try {
      // The consultant's own service — one implementation of "a medicine
      // another hospital prescribed", reached from both stations.
      const draft = await getDraft(req.params.visitId);
      res.json(await addExternal(draft.patientId, req.body));
    } catch (e) {
      handleError(res, e, "Gini Flow external medicine");
    }
  },
);

router.post(
  "/giniflow/stations/mo/:visitId/prescription/items",
  moGate,
  validate(giniflowRxItemSchema),
  async (req, res) => {
    try {
      res.json(
        await addItem(req.params.visitId, {
          ...req.body,
          proposedBy: req.doctor?.doctor_id ?? null,
        }),
      );
    } catch (e) {
      handleError(res, e, "Gini Flow MO propose medicine");
    }
  },
);

router.get(
  "/giniflow/stations/mo/queue",
  moGate,
  validateQuery(giniflowMoQueueQuerySchema),
  async (req, res) => {
    try {
      const date = await resolveDate(req.query.date);
      const data = await getMoQueue(date, req.doctor?.doctor_id ?? null, req.query.q ?? null);
      res.json({ date, ...data, serverTime: new Date().toISOString() });
    } catch (e) {
      handleError(res, e, "Gini Flow MO queue");
    }
  },
);

router.get("/giniflow/stations/mo/test-panels", moGate, async (req, res) => {
  try {
    res.json(await getTestPanels());
  } catch (e) {
    handleError(res, e, "Gini Flow test panels");
  }
});

router.get("/giniflow/stations/mo/:visitId", moGate, async (req, res) => {
  try {
    const patient = await getMoPatient(req.params.visitId);
    if (!patient) return res.status(404).json({ error: "Visit not found" });
    res.json(patient);
  } catch (e) {
    handleError(res, e, "Gini Flow MO patient");
  }
});

router.post("/giniflow/stations/mo/:visitId/start", moGate, async (req, res) => {
  try {
    res.json(await startWorkup(req.params.visitId, req.doctor?.doctor_id ?? null));
  } catch (e) {
    handleError(res, e, "Gini Flow MO start");
  }
});

// Reads the plan back and points at the controls below it: the test chips, the
// urgency, and the suggestion form. Writes NOTHING — the MO confirms what
// lights up, and that is what makes an AI read safe on this screen.
router.post(
  "/giniflow/stations/mo/:visitId/extract-plan",
  moGate,
  validate(giniflowPlanExtractSchema),
  async (req, res) => {
    try {
      res.json(await extractPlan(req.params.visitId, req.body.plan));
    } catch (e) {
      // A refusal the MO can act on — "write the plan first", "AI is not
      // configured" — carries its reason; only a real fault is a 500.
      e?.status && e.status < 500
        ? res.status(e.status).json({ error: e.message })
        : handleError(res, e, "Gini Flow MO plan extract");
    }
  },
);

router.put(
  "/giniflow/stations/mo/:visitId/plan",
  moGate,
  validate(giniflowPlanSchema),
  async (req, res) => {
    try {
      res.json(
        await savePlan(req.params.visitId, {
          plan: req.body.plan,
          source: req.body.source,
          actorId: req.doctor?.doctor_id ?? null,
        }),
      );
    } catch (e) {
      handleError(res, e, "Gini Flow MO plan");
    }
  },
);

router.post(
  "/giniflow/stations/mo/:visitId/proposals",
  moGate,
  validate(giniflowProposalSchema),
  async (req, res) => {
    try {
      res.json(
        await addProposal(req.params.visitId, {
          ...req.body,
          actorId: req.doctor?.doctor_id ?? null,
        }),
      );
    } catch (e) {
      handleError(res, e, "Gini Flow MO proposal");
    }
  },
);

router.delete("/giniflow/stations/mo/proposals/:id", moGate, async (req, res) => {
  try {
    res.json(await withdrawProposal(req.params.id));
  } catch (e) {
    handleError(res, e, "Gini Flow MO proposal withdraw");
  }
});

router.post(
  "/giniflow/stations/mo/:visitId/tests",
  moGate,
  validate(giniflowOrderTestsSchema),
  async (req, res) => {
    try {
      res.json(
        await orderTests(req.params.visitId, {
          urgency: req.body.urgency,
          tests: req.body.tests,
          customTests: req.body.customTests,
          actorId: req.doctor?.doctor_id ?? null,
        }),
      );
    } catch (e) {
      handleError(res, e, "Gini Flow order tests");
    }
  },
);

router.post("/giniflow/stations/mo/:visitId/takeover", moGate, async (req, res) => {
  try {
    res.json(await takeOver(req.params.visitId, req.doctor?.doctor_id ?? null));
  } catch (e) {
    handleError(res, e, "Gini Flow MO take over");
  }
});

router.post("/giniflow/stations/mo/:visitId/release", moGate, async (req, res) => {
  try {
    res.json(await releaseWorkup(req.params.visitId, req.doctor?.doctor_id ?? null));
  } catch (e) {
    handleError(res, e, "Gini Flow MO release");
  }
});

router.post("/giniflow/stations/mo/:visitId/ready", moGate, async (req, res) => {
  try {
    res.json(await readyForDoctor(req.params.visitId, req.doctor?.doctor_id ?? null));
  } catch (e) {
    handleError(res, e, "Gini Flow MO ready");
  }
});

router.post("/giniflow/stations/mo/:visitId/close", moGate, async (req, res) => {
  try {
    res.json(await closeWithoutDoctor(req.params.visitId, req.doctor?.doctor_id ?? null));
  } catch (e) {
    handleError(res, e, "Gini Flow MO close");
  }
});

// ── Pharmacy ────────────────────────────────────────────────────────────────
// docs/gini-flow/16-PHARMACY-STATION-PLAN.md §8. The last station on the floor:
// when it marks a patient dispensed, the visit ends.
const pharmacyGate = requireCapability(CAP.GINIFLOW_STATION_PHARMACY);

// A refusal the counter can act on — "already dispensed", "say why it was not
// given", "external medicines are not ours" — is a 409/400 carrying the reason,
// never a 500.
const pharmacyError = (res, e, label) =>
  e?.status && e.status < 500
    ? res.status(e.status).json({ error: e.message })
    : handleError(res, e, label);

router.get(
  "/giniflow/stations/pharmacy/queue",
  pharmacyGate,
  validateQuery(giniflowDateQuerySchema),
  async (req, res) => {
    try {
      const date = await resolveDate(req.query.date);
      const data = await getPharmacyQueue(date);
      res.json({ date, ...data, serverTime: new Date().toISOString() });
    } catch (e) {
      pharmacyError(res, e, "Gini Flow pharmacy queue");
    }
  },
);

router.get("/giniflow/stations/pharmacy/:visitId", pharmacyGate, async (req, res) => {
  try {
    const patient = await getPharmacyPatient(req.params.visitId);
    if (!patient) return res.status(404).json({ error: "Visit not found" });
    res.json({ ...patient, serverTime: new Date().toISOString() });
  } catch (e) {
    pharmacyError(res, e, "Gini Flow pharmacy patient");
  }
});

router.post(
  "/giniflow/stations/pharmacy/:visitId/dispense/:medId",
  pharmacyGate,
  validate(giniflowDispenseSchema),
  async (req, res) => {
    try {
      res.json(
        await dispenseItem(req.params.visitId, Number(req.params.medId), {
          status: req.body.status,
          reason: req.body.reason,
          qtyNote: req.body.qtyNote,
          actorId: req.doctor?.doctor_id ?? null,
          actorName: req.doctor?.doctor_name ?? null,
        }),
      );
    } catch (e) {
      pharmacyError(res, e, "Gini Flow dispense");
    }
  },
);

// The exit. The bulk mark and the two status moves are one transaction; the
// WhatsApp send is deliberately outside it, after the commit — and NOT awaited
// (PH-02). The visit is already closed by then, so making the pharmacist watch a
// spinner while a vendor HTTP call hangs would block a counter with a queue
// behind it for work that is already done. The screen learns the outcome from
// `card_sent_at` on the next poll.
router.post(
  "/giniflow/stations/pharmacy/:visitId/dispense-all",
  pharmacyGate,
  validate(giniflowDispenseAllSchema),
  async (req, res) => {
    try {
      const result = await dispenseAll(req.params.visitId, {
        actorId: req.doctor?.doctor_id ?? null,
        actorName: req.doctor?.doctor_name ?? null,
      });
      sendCardToPatient(req.params.visitId).catch((e) =>
        console.warn("[giniflow pharmacy] medicine card send failed:", e?.message),
      );
      res.json({ ...result, card: { sending: true } });
    } catch (e) {
      pharmacyError(res, e, "Gini Flow dispense all");
    }
  },
);

router.post("/giniflow/stations/pharmacy/:visitId/send-card", pharmacyGate, async (req, res) => {
  try {
    res.json(await sendCardToPatient(req.params.visitId, { force: true }));
  } catch (e) {
    pharmacyError(res, e, "Gini Flow send medicine card");
  }
});

// ── Referrals ───────────────────────────────────────────────────────────────
// docs/gini-flow/19-REFERRALS-STATION-PLAN.md §9. The one place a patient leaves
// the Gini floor and goes somewhere else — a tracker, not a form, because the
// question a referral asks stays open until the specialist answers it.
//
// Nothing here moves `current_status`: a referral is parallel to the chain, and
// the visit continues to pharmacy and exit exactly as it would have.

const rxGate = requireCapability(CAP.GINIFLOW_STATION_RX);
const printRxGate = requireCapability(CAP.GINIFLOW_PRINT_RX);

router.get(
  "/giniflow/stations/rx/queue",
  rxGate,
  validateQuery(giniflowStationQuerySchema),
  async (req, res) => {
    try {
      const date = await resolveDate(req.query.date);
      res.json({
        date,
        ...(await getRxQueue(date, req.query.q ?? null)),
        serverTime: new Date().toISOString(),
      });
    } catch (e) {
      handleError(res, e, "Gini Flow Rx queue");
    }
  },
);

router.get("/giniflow/stations/rx/:visitId", rxGate, async (req, res) => {
  try {
    res.json(await getRxPatient(req.params.visitId));
  } catch (e) {
    handleError(res, e, "Gini Flow Rx patient");
  }
});

router.post("/giniflow/stations/rx/:visitId/start", rxGate, async (req, res) => {
  try {
    res.json(await startRxExplain(req.params.visitId, req.doctor?.doctor_id ?? null));
  } catch (e) {
    handleError(res, e, "Gini Flow Rx start");
  }
});

router.post("/giniflow/stations/rx/:visitId/explained", rxGate, async (req, res) => {
  try {
    res.json(await markRxExplained(req.params.visitId, req.doctor?.doctor_id ?? null));
  } catch (e) {
    handleError(res, e, "Gini Flow Rx explained");
  }
});

router.post("/giniflow/stations/rx/:visitId/reissue", printRxGate, async (req, res) => {
  try {
    res.json(await regenerateRx(req.params.visitId));
  } catch (e) {
    if (e.reason) return res.status(e.status || 409).json({ error: e.message, reason: e.reason });
    handleError(res, e, "Gini Flow reissue prescription");
  }
});

router.get("/giniflow/stations/rx/:visitId/print", printRxGate, async (req, res) => {
  try {
    const file = await fetchRxFile(req.params.visitId);
    res.set("Content-Type", file.contentType);
    res.set("Content-Disposition", `inline; filename="${encodeURIComponent(file.fileName)}"`);
    res.set("Cache-Control", "private, max-age=60");
    res.send(file.bytes);
  } catch (e) {
    if (e.reason) return res.status(e.status || 409).json({ error: e.message, reason: e.reason });
    handleError(res, e, "Gini Flow print prescription");
  }
});

const referralsGate = requireCapability(CAP.GINIFLOW_REFERRALS);

// RF-03. The chips are not the desk. A consultant decides a referral from the
// Care plan and must be able to write one, but the coordinator's desk — every
// patient's referrals for the day, the specialist appointments, closing the loop
// — is not theirs, and 19 §9 never said it was. So the three VISIT-scoped
// endpoints the chips use take either capability, and everything else stays on
// GINIFLOW_REFERRALS alone.
const referralChipGate = requireCapability([CAP.GINIFLOW_REFERRALS, CAP.GINIFLOW_STATION_DOCTOR]);

// A refusal the desk can act on — "no phone number for Dr. Gupta", "a letter has
// been generated for this referral" — is a 409 carrying the sentence, never a 500.
const referralsError = (res, e, label) =>
  e?.status && e.status < 500
    ? res.status(e.status).json({ error: e.message })
    : handleError(res, e, label);

router.get(
  "/giniflow/referrals",
  referralsGate,
  validateQuery(giniflowReferralQuerySchema),
  async (req, res) => {
    try {
      const date = await resolveDate(req.query.date);
      const data = await getReferrals(date, { q: req.query.q ?? null });
      res.json({ date, ...data, serverTime: new Date().toISOString() });
    } catch (e) {
      referralsError(res, e, "Gini Flow referrals");
    }
  },
);

// The create form's Patient field is a picker, not free text: a referral with no
// patient_id is a letter nobody can find again (§4.2).
router.get(
  "/giniflow/referrals/patients",
  referralsGate,
  validateQuery(giniflowSearchQuerySchema),
  async (req, res) => {
    try {
      const date = await resolveDate(req.query.date);
      res.json({ date, patients: await searchReferralPatients(date, req.query.q) });
    } catch (e) {
      referralsError(res, e, "Gini Flow referral patient search");
    }
  },
);

// What the consultant's chips read — which specialties this visit has already
// been referred to, so a selected chip and a Finalize panel cannot disagree.
router.get("/giniflow/referrals/visit/:visitId", referralChipGate, async (req, res) => {
  try {
    res.json({ referrals: await referralsForVisit(req.params.visitId) });
  } catch (e) {
    referralsError(res, e, "Gini Flow visit referrals");
  }
});

router.post(
  "/giniflow/referrals",
  referralsGate,
  validate(giniflowReferralSchema),
  async (req, res) => {
    try {
      res.json(
        await createReferral(req.body.visitId, {
          ...req.body,
          actorId: req.doctor?.doctor_id ?? null,
        }),
      );
    } catch (e) {
      referralsError(res, e, "Gini Flow create referral");
    }
  },
);

// The consultant's chip — specialty alone, the station fills in the rest (§5).
router.post(
  "/giniflow/referrals/visit/:visitId",
  referralChipGate,
  validate(giniflowReferralChipSchema),
  async (req, res) => {
    try {
      res.json(
        await createReferral(req.params.visitId, {
          ...req.body,
          source: "chip",
          actorId: req.doctor?.doctor_id ?? null,
        }),
      );
    } catch (e) {
      referralsError(res, e, "Gini Flow referral chip");
    }
  },
);

// Deselecting a chip. Refused with a 409 once a letter exists behind the row.
router.delete("/giniflow/referrals/:id", referralChipGate, async (req, res) => {
  try {
    res.json(await removeReferral(req.params.id));
  } catch (e) {
    referralsError(res, e, "Gini Flow remove referral");
  }
});

// The specialist's reply, and the medicines they started (brief §4.7, 19 §12.3).
//
// One call, not two: a reply saved without its medicines would tell the desk the
// loop was closed while Gini's prescriber still could not see the new drugs.
router.post(
  "/giniflow/referrals/:id/response",
  referralsGate,
  validate(giniflowReferralResponseSchema),
  async (req, res) => {
    try {
      res.json(
        await recordResponse(req.params.id, {
          note: req.body.note ?? null,
          medicines: req.body.medicines || [],
          complete: req.body.complete !== false,
          actorName: req.doctor?.short_name || req.doctor?.doctor_name || null,
        }),
      );
    } catch (e) {
      referralsError(res, e, "Gini Flow referral response");
    }
  },
);

// The letter, inline (§7.2, RF-05).
//
// The STORED file is authoritative when one exists: it is the letter the
// specialist was actually sent, and rendering fresh on every view would both
// cost a Puppeteer run per click and let the bytes on screen drift from the
// bytes on WhatsApp — the medicines are read live, so a letter viewed a week
// later would silently list a different prescription. A row with no stored file
// renders on demand, which is what makes the route work before Finalize has run.
router.get("/giniflow/referrals/:id/letter.pdf", referralsGate, async (req, res) => {
  try {
    // Proxied, never redirected: the storage bucket is private, so the public
    // URL Supabase composes 404s with "Bucket not found". Serve the stored
    // bytes when they are there and re-render when they are not — the letter
    // must open either way.
    const stored = await fetchStoredLetter(req.params.id);
    const { pdf, referral } = stored
      ? { pdf: stored, referral: await loadReferralHeader(req.params.id) }
      : await renderLetter(req.params.id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="Referral_${String(referral.name || "patient").replace(/[^a-zA-Z0-9._-]/g, "_")}_${referral.specialty}.pdf"`,
    );
    res.send(pdf);
  } catch (e) {
    referralsError(res, e, "Gini Flow referral letter");
  }
});

router.post(
  "/giniflow/referrals/:id/letter",
  referralsGate,
  validate(giniflowReferralLetterSchema),
  async (req, res) => {
    try {
      res.json(await generateLetter(req.params.id, { force: !!req.body.force }));
    } catch (e) {
      referralsError(res, e, "Gini Flow generate referral letter");
    }
  },
);

router.post(
  "/giniflow/referrals/:id/send",
  referralsGate,
  validate(giniflowReferralSendSchema),
  async (req, res) => {
    try {
      res.json(await sendLetter(req.params.id, { to: req.body.to, force: !!req.body.force }));
    } catch (e) {
      referralsError(res, e, "Gini Flow send referral letter");
    }
  },
);

router.post(
  "/giniflow/referrals/:id/appointment",
  referralsGate,
  validate(giniflowReferralAppointmentSchema),
  async (req, res) => {
    try {
      res.json(await bookAppointment(req.params.id, { date: req.body.date, note: req.body.note }));
    } catch (e) {
      referralsError(res, e, "Gini Flow book referral appointment");
    }
  },
);

router.post(
  "/giniflow/referrals/:id/complete",
  referralsGate,
  validate(giniflowReferralCompleteSchema),
  async (req, res) => {
    try {
      res.json(await completeReferral(req.params.id));
    } catch (e) {
      referralsError(res, e, "Gini Flow complete referral");
    }
  },
);

export default router;
