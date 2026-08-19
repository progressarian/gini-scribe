import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export default function AnchoredPopover({
  anchorRef,
  children,
  align = "left",
  matchWidth = false,
  width,
  gap = 4,
  className = "",
  popoverRef,
}) {
  const innerRef = useRef(null);
  const ref = popoverRef || innerRef;
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const a = anchor.getBoundingClientRect();
      const el = ref.current;
      const h = el?.offsetHeight || 0;
      const w = matchWidth ? a.width : width || el?.offsetWidth || 0;
      const below = window.innerHeight - a.bottom;
      const flip = h > 0 && below < h + gap && a.top > below;
      const left = align === "right" ? a.right - w : a.left;
      setPos({
        top: flip ? Math.max(4, a.top - h - gap) : a.bottom + gap,
        left: Math.min(Math.max(4, left), Math.max(4, window.innerWidth - w - 4)),
        width: matchWidth ? a.width : width,
      });
    };
    place();
    const raf = requestAnimationFrame(place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchorRef, ref, align, matchWidth, width, gap]);

  useEffect(() => {
    if (ref.current) ref.current.style.visibility = pos ? "visible" : "hidden";
  }, [pos, ref]);

  return createPortal(
    <div
      ref={ref}
      className={className}
      data-popover-layer=""
      style={{
        position: "fixed",
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        ...(pos?.width ? { width: pos.width } : null),
        zIndex: 1200,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
