import { useEffect } from "react";

export default function useDismissOnOutside(ref, onDismiss, active = true) {
  useEffect(() => {
    if (!active) return;
    let openedOutside = false;
    const isOutside = (node) => {
      const refs = Array.isArray(ref) ? ref : [ref];
      const els = refs.map((r) => r?.current).filter(Boolean);
      if (!els.length) return false;
      if (els.some((el) => el.contains(node))) return false;
      return !node?.closest?.("[data-popover-layer]");
    };
    const onDown = (e) => {
      openedOutside = isOutside(e.target);
    };
    const onUp = (e) => {
      if (openedOutside && isOutside(e.target)) onDismiss();
      openedOutside = false;
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", onUp, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", onUp, true);
    };
  }, [onDismiss, active]);
}
