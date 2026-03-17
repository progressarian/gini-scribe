import "dotenv/config";
import express from "express";
import cors from "cors";
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
import activeVisitRoutes from "./routes/active-visits.js";
import messageRoutes from "./routes/messages.js";
import aiRoutes from "./routes/ai.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", 1); // trust first proxy (Railway/Render) for accurate IP
app.use(cors());

// Route-aware body size limits — only upload/transcript routes get large limits
app.use((req, res, next) => {
  const p = req.path;

  // 50MB: consultation save (transcripts + full visit data), base64 file/audio uploads
  const isLarge =
    (p === "/api/consultations" && req.method === "POST") ||
    p.includes("/upload-file") ||
    p.includes("/audio") ||
    p === "/api/convert-heic" ||
    p.startsWith("/api/ai/");

  // 5MB: AI-extracted documents, reasoning text, rx-feedback, history import
  const isMedium =
    p.includes("/documents") ||
    p.includes("/reasoning") ||
    p.includes("/rx-feedback") ||
    p.includes("/history");

  const limit = isLarge ? "50mb" : isMedium ? "5mb" : "1mb";
  express.json({ limit })(req, res, next);
});

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
app.use("/api", activeVisitRoutes);
app.use("/api", messageRoutes);
app.use("/api", aiRoutes);

// Serve frontend
const distPath = path.join(__dirname, "..", "dist");
app.use(express.static(distPath));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(distPath, "index.html"));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Gini Scribe API + Frontend running on port ${PORT}`));
