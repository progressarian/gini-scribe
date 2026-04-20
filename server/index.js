import "dotenv/config";
import express from "express";
import cors from "cors";
import compression from "compression";
import path from "path";
import { fileURLToPath } from "url";

import { authMiddleware, requireAuth } from "./middleware/auth.js";
import { ipLimiter, userLimiter } from "./middleware/rateLimit.js";
import authRoutes from "./routes/auth.js";
import patientRoutes from "./routes/patients.js";
import consultationRoutes from "./routes/consultations.js";
import clinicalRoutes from "./routes/clinical.js";
import documentRoutes from "./routes/documents.js";
import outcomeRoutes from "./routes/outcomes.js";
import reportRoutes from "./routes/reports.js";
import reasoningRoutes from "./routes/reasoning.js";
import appointmentRoutes from "./routes/appointments.js";
import opdRoutes from "./routes/opd.js";
import activeVisitRoutes from "./routes/active-visits.js";
import messageRoutes from "./routes/messages.js";
import aiRoutes from "./routes/ai.js";
import alertRoutes from "./routes/alerts.js";
import healthLogRoutes from "./routes/health-logs.js";
import visitRoutes from "./routes/visit.js";
import syncRoutes from "./routes/sync.js";
import summaryRoutes from "./routes/summary.js";
import dashboardRoutes from "./routes/dashboard.js";
import { startCronJobs } from "./services/cron/index.js";
import { startSheetsCron } from "./services/cron/sheetsSync.js";
import { startTodaysShowCron } from "./services/cron/todaysShowSync.js";

// Cron/sync jobs run in a separate worker process (see server/worker.js) so
// heavy HealthRay sync work cannot starve the API's DB pool or event loop.
// Set RUN_CRON_IN_API=1 to fall back to the old single-process behavior.
const RUN_CRON_IN_API = process.env.RUN_CRON_IN_API === "1";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", 1); // trust first proxy (Railway/Render) for accurate IP
app.use(cors());

// Gzip compression — shrinks JSON API payloads 5-10x on the wire. threshold:0
// forces compression even for small responses; level 6 is the sweet spot for
// CPU vs. size. No filter override — compression's default skips already-
// compressed media types (images, video, gzipped uploads).
app.use(compression({ threshold: 1024, level: 6 }));

// Route-aware body size limits — only upload/transcript routes get large limits
app.use((req, res, next) => {
  const p = req.path;

  // 50MB: consultation save (transcripts + full visit data), base64 file/audio uploads
  const isLarge =
    (p === "/api/consultations" && req.method === "POST") ||
    (p.includes("/visit/") && p.endsWith("/document")) ||
    p.includes("/upload-file") ||
    p.includes("/audio") ||
    p === "/api/convert-heic" ||
    p.startsWith("/api/ai/");

  // 5MB: AI-extracted documents, reasoning text, rx-feedback, history import, visit doc uploads
  const isMedium =
    p.includes("/documents") ||
    p.includes("/document") ||
    p.includes("/reasoning") ||
    p.includes("/rx-feedback") ||
    p.includes("/history");

  const limit = isLarge ? "50mb" : isMedium ? "5mb" : "1mb";
  express.json({ limit })(req, res, next);
});

// Sync routes (no auth — internal/admin)
app.use("/api", syncRoutes);

// Auth middleware (attaches req.doctor if valid token, blocks unauthenticated on protected routes)
app.use(authMiddleware);
app.use(requireAuth);

// Rate limiting — IP-based for unauthenticated, user-based for authenticated
app.use("/api", ipLimiter);
app.use("/api", userLimiter);

// Routes
app.use("/api", authRoutes);
app.use("/api", patientRoutes);
app.use("/api", consultationRoutes);
app.use("/api", clinicalRoutes);
app.use("/api", documentRoutes);
app.use("/api", outcomeRoutes);
app.use("/api", reportRoutes);
app.use("/api", reasoningRoutes);
app.use("/api", appointmentRoutes);
app.use("/api", opdRoutes);
app.use("/api", activeVisitRoutes);
app.use("/api", messageRoutes);
app.use("/api", aiRoutes);
app.use("/api", alertRoutes);
app.use("/api", healthLogRoutes);
app.use("/api", visitRoutes);
app.use("/api", summaryRoutes);
app.use("/api", dashboardRoutes);

// Serve frontend
const distPath = path.join(__dirname, "..", "dist");
app.use(express.static(distPath));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(distPath, "index.html"));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Gini Scribe API + Frontend running on port ${PORT}`);
  if (RUN_CRON_IN_API) {
    console.log("⚠️  RUN_CRON_IN_API=1 — running cron jobs inside API process");
    startCronJobs();
    startSheetsCron();
    startTodaysShowCron();
  } else {
    console.log("ℹ️  cron jobs disabled in API process — run `npm run worker` separately");
  }
});
