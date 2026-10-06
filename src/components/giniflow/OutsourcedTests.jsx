import { Fragment } from "react";

export function OutsourcedTag({ label = "Outsourced" }) {
  return (
    <>
      {" "}
      <span className="badge b-pu">{label}</span>
    </>
  );
}

export function OutsourcedNote({ names = [], total = 0 }) {
  if (!names.length) return null;
  const label = names.length === total ? "Outsourced" : `Outsourced: ${names.join(", ")}`;
  return <OutsourcedTag label={label} />;
}

export function TestNames({ names, outsourced = [], separator = " · " }) {
  const marked = new Set(outsourced);
  return (names || []).map((name, index) => (
    <Fragment key={`${name}-${index}`}>
      {index > 0 && separator}
      {name}
      {marked.has(name) && <OutsourcedTag />}
    </Fragment>
  ));
}
