import "./loadEnv.js";import pool from "./config/db.js";
import { syncTodayWalkingAppointments } from "./services/cron/healthraySync.js";
const t=Date.now();
try{
  console.log("FULL today-sync started…");
  await syncTodayWalkingAppointments();
  console.log(`FULL sync done in ${Math.round((Date.now()-t)/1000)}s`);
}catch(e){console.error("FULL SYNC ERR:",e.message);}
try{
  for(const fn of ['P_180433','P_180438']){
    const a=(await pool.query("SELECT file_no,patient_name,appointment_date,status,source FROM appointments WHERE file_no=$1 ORDER BY appointment_date DESC LIMIT 1",[fn])).rows;
    console.log(`RESULT ${fn}: ${a.length?JSON.stringify(a[0]):"(not in HealthRay today-list)"}`);
  }
  const last=(await pool.query("SELECT MAX(updated_at) last, COUNT(*) FILTER (WHERE updated_at>NOW()-interval '15 min')::int recent FROM appointments WHERE source='healthray'")).rows[0];
  console.log("healthray latest write:",last.last,"| last 15min:",last.recent);
}catch(e){console.error("CHECK ERR:",e.message);}
finally{await pool.end();process.exit(0);}
