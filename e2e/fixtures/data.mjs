export const PIN = "4321";

export const USERS = {
  admin: { id: 9001, name: "E2E Admin", short_name: "Admin", role: "admin" },
  reception_admin: {
    id: 9002,
    name: "E2E Reception Admin",
    short_name: "RecAdmin",
    role: "reception_admin",
  },
  reception: { id: 9003, name: "E2E Reception", short_name: "Reception", role: "reception" },
  coordinator: { id: 9004, name: "E2E Coordinator", short_name: "Coord", role: "coordinator" },
  lab: { id: 9005, name: "E2E Lab", short_name: "Lab", role: "lab" },
};

export const CONSULTANTS = {
  banshali: {
    id: 9101,
    name: "Dr E2E Banshali",
    short_name: "Dr Banshali",
    role: "consultant",
    specialty: "Endocrinology",
  },
  rahul: {
    id: 9102,
    name: "Dr E2E Rahul",
    short_name: "Dr Rahul",
    role: "consultant",
    specialty: "Diabetology",
  },
  beant: {
    id: 9103,
    name: "Dr E2E Beant",
    short_name: "Dr Beant",
    role: "consultant",
    specialty: "Internal Medicine",
  },
};

function dobForAge(age) {
  const today = new Date();
  return `${today.getFullYear() - age}-01-15`;
}

export const PATIENTS = {
  general: { id: 9201, name: "E2E General Adult", sex: "Male", age: 40, file_no: "E2E_0001" },
  senior: { id: 9202, name: "E2E Senior 72", sex: "Female", age: 72, file_no: "E2E_0002" },
  cghsPaid: { id: 9203, name: "E2E CGHS Paid", sex: "Male", age: 55, file_no: "E2E_0003" },
  cghsReferral: {
    id: 9204,
    name: "E2E CGHS Referral",
    sex: "Female",
    age: 60,
    file_no: "E2E_0004",
  },
  pensioner: { id: 9205, name: "E2E Pensioner", sex: "Male", age: 68, file_no: "E2E_0005" },
};

for (const patient of Object.values(PATIENTS)) {
  patient.dob = dobForAge(patient.age);
  patient.phone = `90000${String(patient.id).slice(-5)}`;
  patient.health_id = `E2E-HID-${patient.id}`;
}

export const CATALOG_TESTS = [
  { test_name: "HbA1c", category: "lab", price: 500 },
  { test_name: "Lipid Profile", category: "lab", price: 600 },
  { test_name: "Fasting Blood Sugar", category: "lab", price: 100 },
  { test_name: "ABI", category: "machine", price: 800 },
  { test_name: "VPT", category: "machine", price: 700 },
];
