import 'dotenv/config'
import pg from 'pg'
const { Pool } = pg
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

const today = new Date().toISOString().split('T')[0]
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().split('T')[0] }

const patients = [
  {
    name: 'Ajinder Pal Singh', file_no: 'P_42010', phone: '9814200001', age: 44, sex: 'Male',
    time: '09:00', visit_type: 'Follow-Up', status: 'pending', category: 'maint',
    doctor: 'Dr. Bhansali', visit_count: 4, last_visit: daysAgo(55),
    bio: { hba1c: 7.8, fg: 148, bpSys: 132, bpDia: 84, ldl: 108, tg: 165, bp: '132/84' },
    prep: { biomarkers: true, compliance: true, categorized: true, assigned: true }
  },
  {
    name: 'Gurpreet Kaur Sandhu', file_no: 'P_38821', phone: '9815300002', age: 58, sex: 'Female',
    time: '09:30', visit_type: 'Follow-Up', status: 'checkedin', category: 'complex',
    doctor: 'Dr. Bhansali', visit_count: 11, last_visit: daysAgo(28),
    bio: { hba1c: 10.2, fg: 238, bpSys: 148, bpDia: 92, ldl: 142, bp: '148/92' },
    prep: { biomarkers: true, compliance: true, categorized: true, assigned: true }
  },
  {
    name: 'Ramesh Chand Verma', file_no: 'P_31045', phone: '9816100003', age: 62, sex: 'Male',
    time: '10:00', visit_type: 'Follow-Up', status: 'pending', category: 'ctrl',
    doctor: 'Dr. Kunal Sharma', visit_count: 8, last_visit: daysAgo(92),
    bio: { hba1c: 6.4, fg: 98, bpSys: 124, bpDia: 78, ldl: 88, bp: '124/78' },
    prep: { biomarkers: true, compliance: false, categorized: true, assigned: true }
  },
  {
    name: 'Sunita Devi Arora', file_no: 'P_44102', phone: '9817200004', age: 51, sex: 'Female',
    time: '10:30', visit_type: 'New Patient', status: 'pending', category: 'new',
    doctor: 'Dr. Priya Patel', visit_count: 1, last_visit: null,
    bio: { hba1c: 8.9, fg: 196, bp: '138/88' },
    prep: { biomarkers: false, compliance: false, categorized: false, assigned: false }
  },
  {
    name: 'Harjinder Singh Brar', file_no: 'P_29900', phone: '9818100005', age: 70, sex: 'Male',
    time: '11:00', visit_type: 'Follow-Up', status: 'seen', category: 'complex',
    doctor: 'Dr. Bhansali', visit_count: 19, last_visit: daysAgo(35),
    bio: { hba1c: 11.4, fg: 262, bpSys: 158, bpDia: 96, ldl: 168, bp: '158/96' },
    prep: { biomarkers: true, compliance: true, categorized: true, assigned: true }
  },
  {
    name: 'Manpreet Kaur Dhaliwal', file_no: 'P_39510', phone: '9819200006', age: 38, sex: 'Female',
    time: '11:30', visit_type: 'Follow-Up', status: 'pending', category: 'maint',
    doctor: 'Dr. Simranpreet K.', visit_count: 6, last_visit: daysAgo(61),
    bio: { hba1c: 7.2, fg: 126, bpSys: 128, bpDia: 80, ldl: 96, bp: '128/80' },
    prep: { biomarkers: true, compliance: true, categorized: true, assigned: false }
  },
  {
    name: 'Balwinder Singh Mann', file_no: 'P_21300', phone: '9810100007', age: 55, sex: 'Male',
    time: '12:00', visit_type: 'Follow-Up', status: 'pending', category: 'ctrl',
    doctor: 'Dr. Beant Sidhu', visit_count: 15, last_visit: daysAgo(120),
    bio: { hba1c: 6.1, fg: 94, bpSys: 118, bpDia: 74, bp: '118/74' },
    prep: { biomarkers: true, compliance: true, categorized: true, assigned: true }
  },
  {
    name: 'Neelam Sharma', file_no: 'P_45001', phone: '9820100008', age: 47, sex: 'Female',
    time: '12:30', visit_type: 'OPD', status: 'pending', category: null, is_walkin: true,
    doctor: null, visit_count: 2, last_visit: daysAgo(14),
    bio: {},
    prep: { biomarkers: false, compliance: false, categorized: false, assigned: false }
  },
]

// Ensure columns exist
await pool.query(`
  ALTER TABLE appointments
    ADD COLUMN IF NOT EXISTS age INTEGER,
    ADD COLUMN IF NOT EXISTS sex TEXT,
    ADD COLUMN IF NOT EXISTS visit_count INTEGER DEFAULT 1,
    ADD COLUMN IF NOT EXISTS last_visit_date DATE
`)

// Delete existing sample appointments for today then re-insert
await pool.query(`DELETE FROM appointments WHERE appointment_date = $1`, [today])

for (const p of patients) {
  await pool.query(`
    INSERT INTO appointments (
      patient_name, file_no, phone, age, sex,
      appointment_date, time_slot, visit_type, status, category,
      doctor_name, visit_count, last_visit_date, is_walkin,
      biomarkers, prep_steps
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb)
  `, [
    p.name, p.file_no, p.phone, p.age, p.sex,
    today, p.time, p.visit_type, p.status, p.category,
    p.doctor || null, p.visit_count, p.last_visit || null, p.is_walkin || false,
    JSON.stringify(p.bio), JSON.stringify(p.prep)
  ])
}

console.log(`✅ Inserted ${patients.length} sample appointments for ${today}`)
await pool.end()
