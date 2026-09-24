import { buildPrescriptionHtml } from "../templates/prescriptionTemplate.js";
import { normalizePrescriptionFooter } from "./prescriptionFooter.js";
import { getPrescriptionLogo } from "./prescriptionLogo.js";

const SAMPLE_VISIT = {
  patient: { name: "Sample Patient", age: 54, sex: "Male", file_no: "SAMPLE-0001" },
  doctor: {
    name: "Dr. Sample Doctor",
    qualification: "MBBS, MD (Medicine)",
    designation: "Consultant",
    reg_no: "00000",
  },
  summary: { totalVisits: 3 },
  activeDx: [
    { label: "Type 2 Diabetes Mellitus", status: "Controlled", since_year: 2019 },
    { label: "Hypertension", status: "Monitoring", since_year: 2021 },
  ],
  activeMeds: [
    {
      name: "Sample Tablet 500",
      composition: "Metformin 500 mg",
      dose: "1-0-1",
      timing: "After meals",
    },
    { name: "Sample Tablet 5", composition: "Amlodipine 5 mg", dose: "1-0-0", timing: "Morning" },
  ],
  visitSummaryText: "Sample prescription to preview the letterhead and footer. Not a real patient.",
};

export async function buildPrescriptionPreviewHtml(footer) {
  const logo = await getPrescriptionLogo();
  return buildPrescriptionHtml({
    ...SAMPLE_VISIT,
    rx_footer: normalizePrescriptionFooter(footer),
    rx_logo: logo.dataUri,
  });
}
