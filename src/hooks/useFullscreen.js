import { useCallback, useEffect, useRef, useState } from "react";

export default function useFullscreen() {
  const ref = useRef(null);
  const [fullscreen, setFullscreen] = useState(false);

  const toggle = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
      setFullscreen(false);
      return;
    }
    setFullscreen(true);
    ref.current?.requestFullscreen?.().catch(() => {});
  }, []);

  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setFullscreen(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKey = (e) => {
      if (e.key !== "Escape" || document.fullscreenElement) return;
      setFullscreen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  return { ref, fullscreen, toggle };
}
