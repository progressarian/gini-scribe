import "./RemoveBtn.css";

// Remove button for list items
export default function RemoveBtn({ onClick }) {
  return (
    <button className="no-print remove-btn" onClick={onClick} title="Remove">
      {"\u2715"}
    </button>
  );
}
