import express from "express";
import { SHEET_MAX_BYTES } from "../services/pharmacy/sheetImport.js";

export const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const rawBody = express.raw({ type: "*/*", limit: SHEET_MAX_BYTES });

export const readSheetUpload = (req, res, next) =>
  rawBody(req, res, (e) => {
    if (e?.type === "entity.too.large") {
      return res.status(413).json({ error: "The file is larger than 5 MB" });
    }
    if (e) return res.status(400).json({ error: "The file could not be read" });
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: "Attach the filled .xlsx sheet" });
    }
    next();
  });

export function sendSheet(res, file, fileName) {
  res.setHeader("Content-Type", XLSX);
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.send(file);
}
