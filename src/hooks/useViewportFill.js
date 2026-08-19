import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

function spaceBelow(el) {
  let total = 0;
  for (let node = el; node?.parentElement; node = node.parentElement) {
    for (let sib = node.nextElementSibling; sib; sib = sib.nextElementSibling) {
      const cs = getComputedStyle(sib);
      if (cs.display === "none" || cs.position === "fixed" || cs.position === "absolute") continue;
      total += sib.getBoundingClientRect().height;
    }
    const parent = getComputedStyle(node.parentElement);
    total += (parseFloat(parent.paddingBottom) || 0) + (parseFloat(parent.borderBottomWidth) || 0);
  }
  return total;
}

export default function useViewportFill(enabled = true, minHeight = 380) {
  const ref = useRef(null);
  const [height, setHeight] = useState(null);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el || !enabled) {
      setHeight((prev) => (prev === null ? prev : null));
      return;
    }
    const top = el.getBoundingClientRect().top + window.scrollY;
    const available = window.innerHeight - top - spaceBelow(el);
    setHeight((prev) => {
      const next = available >= minHeight ? Math.floor(available) : null;
      return prev === next ? prev : next;
    });
  }, [enabled, minHeight]);

  useLayoutEffect(measure);

  useEffect(() => {
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
  }, [measure]);

  return { ref, height, fitted: height != null };
}
