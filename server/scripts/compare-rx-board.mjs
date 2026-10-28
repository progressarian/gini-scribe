import "../loadEnv.js";
import pool from "../config/db.js";
import { getDayBoard, getSlaConfig } from "../services/giniflow/board.js";
import { getRxQueue } from "../services/giniflow/rxStation.js";

const date = process.argv[2] || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
try {
  const rx = await getRxQueue(date);
  const rxRows = [...rx.atDesk, ...rx.waiting];
  const board = await getDayBoard(date, await getSlaConfig());
  const rxCol = board.columns.find((c) => c.key === "rx");
  const onBoardRx = new Set(rxCol.cards.map((c) => c.id));
  console.log(`Rx station: ${rxRows.length}, manager Rx column: ${rxCol.count}`);
  for (const r of rxRows.filter((r) => !onBoardRx.has(r.visitId))) {
    const col = board.columns.find((c) => c.cards?.some((k) => k.id === r.visitId));
    const card = col?.cards.find((k) => k.id === r.visitId);
    console.log(
      `${r.name} ${r.fileNo} | ${r.statusLabel} | on manager board in: ${col ? col.name : "not shown"}` +
        (card ? ` | ${card.machine?.subtitle || card.lab?.subtitle || card.subtitle || ""}` : ""),
    );
  }
} finally {
  await pool.end();
}
