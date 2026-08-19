import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import PatientRecordModal from "../components/ghm/PatientRecordModal.jsx";
function H() {
  const [open, setOpen] = useState(false);
  return (<div><button type="button" id="open" onClick={() => setOpen(true)}>open</button>
    {open && <PatientRecordModal patientId={1} patientName="Gunamay Marwaha" onClose={() => setOpen(false)} />}</div>);
}
createRoot(document.getElementById("root")).render(<StrictMode><H /></StrictMode>);
