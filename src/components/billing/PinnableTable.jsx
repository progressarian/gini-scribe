import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pin, PinOff } from "lucide-react";
import "./pinnableTable.css";

function readPins(storageKey, fallback) {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
    return Array.isArray(saved) ? saved : fallback;
  } catch {
    return fallback;
  }
}

function savePins(storageKey, pins) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(pins));
  } catch {
    return;
  }
}

export default function PinnableTable({
  ariaLabel,
  columns,
  rows,
  rowKey,
  storageKey,
  defaultPinned = [],
  className = "",
}) {
  const known = useMemo(() => new Set(columns.map((c) => c.key)), [columns]);
  const [pins, setPins] = useState(() =>
    readPins(storageKey, defaultPinned).filter((key) => known.has(key)),
  );
  const headRefs = useRef({});
  const [offsets, setOffsets] = useState({});

  const ordered = useMemo(
    () => [
      ...columns.filter((c) => pins.includes(c.key)),
      ...columns.filter((c) => !pins.includes(c.key)),
    ],
    [columns, pins],
  );
  const pinnedKeys = ordered.filter((c) => pins.includes(c.key)).map((c) => c.key);
  const lastPinned = pinnedKeys[pinnedKeys.length - 1];

  const measure = useCallback(() => {
    let left = 0;
    const next = {};
    for (const key of pinnedKeys) {
      next[key] = left;
      left += headRefs.current[key]?.getBoundingClientRect().width ?? 0;
    }
    setOffsets((prev) =>
      Object.keys(next).length === Object.keys(prev).length &&
      Object.entries(next).every(([k, v]) => prev[k] === v)
        ? prev
        : next,
    );
  }, [pinnedKeys.join("|")]);

  useLayoutEffect(() => {
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    for (const key of pinnedKeys) {
      const el = headRefs.current[key];
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [measure, rows]);

  const toggle = (key) => {
    const next = pins.includes(key) ? pins.filter((k) => k !== key) : [...pins, key];
    setPins(next);
    savePins(storageKey, next);
  };

  const cellProps = (column) => {
    if (!pins.includes(column.key)) return { className: column.className || "" };
    return {
      className: `${column.className || ""} ptable__pinned${column.key === lastPinned ? " ptable__pinned--edge" : ""}`,
      style: { left: offsets[column.key] ?? 0 },
    };
  };

  return (
    <table className={`flow-table ptable ${className}`} aria-label={ariaLabel}>
      <thead>
        <tr>
          {ordered.map((column) => {
            const pinned = pins.includes(column.key);
            const props = cellProps(column);
            return (
              <th
                key={column.key}
                ref={(el) => {
                  headRefs.current[column.key] = el;
                }}
                className={`${props.className} ${column.headClassName || ""}`}
                style={props.style}
                scope="col"
              >
                <span className="ptable__head">
                  <span>{column.header}</span>
                  {column.pinnable === false ? null : (
                    <button
                      type="button"
                      className={`ptable__pin${pinned ? " ptable__pin--on" : ""}`}
                      aria-pressed={pinned}
                      aria-label={`${pinned ? "Unpin" : "Pin"} ${column.header} column`}
                      title={pinned ? "Unpin column" : "Pin column to the left"}
                      onClick={() => toggle(column.key)}
                    >
                      {pinned ? (
                        <PinOff size={12} aria-hidden="true" />
                      ) : (
                        <Pin size={12} aria-hidden="true" />
                      )}
                    </button>
                  )}
                </span>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)}>
            {ordered.map((column) => {
              const props = cellProps(column);
              return (
                <td
                  key={column.key}
                  data-label={column.label ?? column.header}
                  className={props.className}
                  style={props.style}
                >
                  {column.cell(row)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
