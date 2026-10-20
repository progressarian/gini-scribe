import { specialtyOf } from "../../../shared/specialties.js";

const personKey = (name) =>
  String(name || "")
    .toLowerCase()
    .replace(/\bdr\b\.?/g, "")
    .replace(/[^a-z]/g, "");

export async function loadCatalog(db) {
  const { rows: doctors } = await db.query(
    `SELECT id, name, short_name, specialty, role, COALESCE(is_chief, FALSE) AS is_chief
       FROM doctors
      WHERE COALESCE(is_active, TRUE) AND removed_at IS NULL`,
  );
  const people = doctors.map((d) => ({
    id: d.id,
    name: d.name,
    role: d.role,
    isChief: d.is_chief,
    keys: [personKey(d.name), personKey(d.short_name)].filter((k) => k.length >= 4),
    specialty: specialtyOf(d.specialty),
  }));
  return {
    people,
    consultantSpecialties: new Set(
      people.filter((p) => p.role === "consultant" && p.specialty).map((p) => p.specialty),
    ),
  };
}

export function personOf(catalog, text) {
  const said = personKey(text);
  if (said.length < 4) return null;
  return (
    catalog.people.find((p) => p.keys.some((k) => k === said)) ||
    catalog.people.find((p) => p.keys.some((k) => said.includes(k) || k.includes(said))) ||
    null
  );
}

const kindOfPerson = (person) =>
  person.isChief ? "chief" : person.role === "mo" ? "mo" : "consultant";

export function matchReferral(catalog, { doctor, specialty, reason }) {
  const person = doctor ? personOf(catalog, doctor) : null;
  const named = specialtyOf(specialty) || specialtyOf(reason) || person?.specialty || null;
  if (person) {
    return {
      kind: kindOfPerson(person),
      matchedDoctorId: person.id,
      matchedSpecialty: named,
      availability: "in_house",
    };
  }
  return {
    kind: "specialty",
    matchedDoctorId: null,
    matchedSpecialty: named,
    availability: !named
      ? "unknown"
      : catalog.consultantSpecialties.has(named)
        ? "in_house"
        : "not_available",
  };
}
