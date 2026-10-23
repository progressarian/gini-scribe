import { useEffect, useState } from "react";
import { useSaveEditNextVisit } from "../../queries/hooks/useGiniflowMo";
import NextVisitPicker from "./NextVisitPicker";

export default function EditNextVisit({ visitId, fromDate, saved, onToast }) {
  const save = useSaveEditNextVisit(visitId);
  const [value, setValue] = useState(saved);

  useEffect(() => {
    setValue(saved);
  }, [visitId]);

  const change = (next) => {
    setValue(next);
    save.mutate(
      { nextVisitDate: next.date || null, nextVisitInterval: next.interval || null },
      { onError: (e) => onToast?.(e?.response?.data?.error || "The next visit was not saved") },
    );
  };

  return (
    <div className="dp-sec">
      <div className="dp-sec-title">
        📅 Next visit {save.isPending ? "· saving…" : save.isSuccess ? "· saved" : ""}
      </div>
      <NextVisitPicker
        fromDate={fromDate}
        interval={value?.interval || ""}
        date={value?.date || ""}
        required
        onChange={change}
      />
    </div>
  );
}
