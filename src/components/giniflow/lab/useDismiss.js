import { useEffect, useRef } from "react";

export default function useDismiss(open, onClose, ref) {
  const opener = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    opener.current = document.activeElement;
    const layerAbove = () => !!document.querySelector("[data-popover-layer]");
    const onKey = (e) => e.key === "Escape" && !layerAbove() && onClose();
    const onDown = (e) =>
      ref.current &&
      !ref.current.contains(e.target) &&
      !e.target.closest?.("[data-popover-layer]") &&
      onClose();
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, [open, onClose, ref]);
}
