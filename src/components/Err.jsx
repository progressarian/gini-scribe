import "./Err.css";

export default function Err({ msg, onDismiss }) {
  if (!msg) return null;
  return (
    <div className="err">
      {"\u274C"} {msg}{" "}
      <button onClick={onDismiss} className="err__dismiss">
        Dismiss
      </button>
    </div>
  );
}
