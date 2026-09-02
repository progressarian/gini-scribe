import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { requireCapability } from "../middleware/auth.js";
import { validate, validateQuery } from "../middleware/validate.js";
import { CAPABILITIES as CAP } from "../../shared/permissions.js";
import { blockActor, blockedResponse } from "../services/patientBlockGuard.js";
import {
  giniflowRxItemSchema,
  giniflowRxItemPatchSchema,
  giniflowRxPauseSchema,
  giniflowRxStopSchema,
  giniflowMedSearchQuerySchema,
  giniflowExternalMedSchema,
  giniflowFinalizeSchema,
  giniflowDoctorQueueQuerySchema,
  giniflowCarePlanSchema,
  giniflowProposalDecisionSchema,
  giniflowDateQuerySchema,
  giniflowMoQueueQuerySchema,
  giniflowPaymentSchema,
  giniflowReportSchema,
  giniflowOrderTestsSchema,
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
  giniflowReferralChipSchema,
  giniflowReferralLetterSchema,
  giniflowReferralSendSchema,
  giniflowReferralAppointmentSchema,
  giniflowReferralCompleteSchema,
} from "../schemas/index.js";
import {
  getVitalsQueue,
  getVitalsPatient,
  saveVitals,
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
import { getLabQueue, advanceSample, uploadReport } from "../services/giniflow/labStation.js";
import {
  getReferrals,
  searchReferralPatients,
  createReferral,
  removeReferral,
  renderLetter,
  storedLetterUrl,
  generateLetter,
  sendLetter,
  bookAppointment,
  completeReferral,
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
  getDoctorQueue,
  getConsult,
  getTrend,
  startConsult,
  releaseConsult,
  saveCarePlan,
  decideProposal,
} from "../services/giniflow/doctorStation.js";
import {
  getDraft,
  seedDraftFromRegimen,
  addItem,
  updateItem,
  removeItem,
  pauseItem,
  stopItem,
  searchMedicines,
  alternativesFor,
  addExternal,
} from "../services/giniflow/prescription.js";
import { buildCard } from "../services/giniflow/medicineCard.js";
import { finalizeConsult, finalizePreview } from "../services/giniflow/finalize.js";
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
    res.json({ ...consult, serverTime: new Date().toISOString() });
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

router.post("/giniflow/stations/doctor/:visitId/start", doctorGate, async (req, res) => {
  try {
    res.json(await startConsult(req.params.visitId, req.doctor?.doctor_id ?? null));
  } catch (e) {
    doctorError(res, e, "Gini Flow start consult");
  }
});

router.post("/giniflow/stations/doctor/:visitId/release", doctorGate, async (req, res) => {
  try {
    res.json(await releaseConsult(req.params.visitId, req.doctor?.doctor_id ?? null));
  } catch (e) {
    doctorError(res, e, "Gini Flow release consult");
  }
});

router.put(
  "/giniflow/stations/doctor/:visitId/care-plan",
  doctorGate,
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

// Seeds the draft from what the patient is already taking. Not automatic: the
// consultant decides when the consultation starts writing.
router.post(
  "/giniflow/stations/doctor/:visitId/prescription/seed",
  doctorGate,
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
  validate(giniflowRxItemSchema),
  async (req, res) => {
    try {
      res.json(await addItem(req.params.visitId, req.body));
    } catch (e) {
      doctorError(res, e, "Gini Flow add medicine");
    }
  },
);

router.patch(
  "/giniflow/stations/doctor/prescription/items/:itemId",
  doctorGate,
  validate(giniflowRxItemPatchSchema),
  async (req, res) => {
    try {
      res.json(await updateItem(req.params.itemId, req.body));
    } catch (e) {
      doctorError(res, e, "Gini Flow edit medicine");
    }
  },
);

router.delete(
  "/giniflow/stations/doctor/prescription/items/:itemId",
  doctorGate,
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
  validate(giniflowOrderTestsSchema),
  async (req, res) => {
    try {
      res.json(
        await orderTests(req.params.visitId, {
          urgency: req.body.urgency,
          tests: req.body.tests,
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

router.post(
  "/giniflow/stations/doctor/:visitId/finalize",
  doctorGate,
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
  validateQuery(giniflowDateQuerySchema),
  async (req, res) => {
    try {
      const date = await resolveDate(req.query.date);
      const data = await getLabQueue(date);
      res.json({ date, ...data, serverTime: new Date().toISOString() });
    } catch (e) {
      handleError(res, e, "Gini Flow lab queue");
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
        }),
      );
    } catch (e) {
      handleError(res, e, "Gini Flow lab report upload");
    }
  },
);

// ── MO / SD ─────────────────────────────────────────────────────────────────
const moGate = requireCapability(CAP.GINIFLOW_STATION_MO);

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
    const stored = await storedLetterUrl(req.params.id);
    if (stored) return res.redirect(stored);
    const { pdf, referral } = await renderLetter(req.params.id);
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
