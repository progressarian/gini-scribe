import { Maximize2, Minimize2 } from "lucide-react";

export default function FullscreenButton({ fullscreen, onToggle, what = "page" }) {
  return (
    <button
      type="button"
      className={`tr-back${fullscreen ? " on" : ""}`}
      aria-pressed={fullscreen}
      onClick={onToggle}
      title={
        fullscreen
          ? "Leave full screen (Esc)"
          : `Hide the app header so the ${what} fills the screen`
      }
    >
      {fullscreen ? (
        <Minimize2 size={14} aria-hidden="true" />
      ) : (
        <Maximize2 size={14} aria-hidden="true" />
      )}{" "}
      {fullscreen ? "Exit full screen" : "Full screen"}
    </button>
  );
}
