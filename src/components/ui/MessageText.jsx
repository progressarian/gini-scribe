import { Fragment, useMemo } from "react";
import "./MessageText.css";

// Chat messages arrive as markdown — Genie answers with tables, bold labels and
// bullet lists — and were printed verbatim, so a health summary read as a wall
// of pipes and asterisks. Rendered here into elements rather than HTML: the text
// is model- and patient-authored, so it must never be injected as markup.
//
// Some rows also carry escaped newlines ("\n" as two characters) from being
// JSON-encoded twice on the way in; those are restored before parsing.

const unescape = (s) =>
  String(s ?? "")
    .replace(/\\r\\n|\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"');

// **bold**, *italic*, `code` — applied in one pass so nesting cannot loop.
const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_)/g;

function inline(text, keyPrefix) {
  return String(text)
    .split(INLINE)
    .filter((p) => p !== "" && p !== undefined)
    .map((part, i) => {
      const key = `${keyPrefix}-${i}`;
      if (/^\*\*[^*]+\*\*$/.test(part) || /^__[^_]+__$/.test(part))
        return <strong key={key}>{part.slice(2, -2)}</strong>;
      if (/^`[^`]+`$/.test(part)) return <code key={key}>{part.slice(1, -1)}</code>;
      if (/^\*[^*\n]+\*$/.test(part) || /^_[^_\n]+_$/.test(part))
        return <em key={key}>{part.slice(1, -1)}</em>;
      return <Fragment key={key}>{part}</Fragment>;
    });
}

const isTableRow = (l) => l.trim().startsWith("|") && l.trim().endsWith("|");
const isDivider = (l) => /^\|[\s:|-]+\|$/.test(l.trim()) && l.includes("-");
const cells = (l) =>
  l
    .trim()
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim());

// Group lines into blocks: tables, lists, and paragraphs.
function parse(text) {
  const lines = unescape(text).split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (isTableRow(line) && isDivider(lines[i + 1] || "")) {
      const head = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      blocks.push({ type: "table", head, rows });
      continue;
    }

    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const items = [];
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ""));
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isTableRow(lines[i]) &&
      !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    blocks.push({ type: "p", text: para.join("\n") });
  }
  return blocks;
}

export default function MessageText({ text, style }) {
  const blocks = useMemo(() => parse(text), [text]);

  return (
    <div className="msgmd" style={style}>
      {blocks.map((b, i) => {
        if (b.type === "table") {
          return (
            <div className="msgmd__tablewrap" key={i}>
              <table className="msgmd__table">
                <thead>
                  <tr>
                    {b.head.map((h, j) => (
                      <th key={j}>{inline(h, `h${i}-${j}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r, j) => (
                    <tr key={j}>
                      {r.map((c, k) => (
                        <td key={k}>{inline(c, `c${i}-${j}-${k}`)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (b.type === "list") {
          const List = b.ordered ? "ol" : "ul";
          return (
            <List className="msgmd__list" key={i}>
              {b.items.map((it, j) => (
                <li key={j}>{inline(it, `l${i}-${j}`)}</li>
              ))}
            </List>
          );
        }
        return (
          <p className="msgmd__p" key={i}>
            {inline(b.text, `p${i}`)}
          </p>
        );
      })}
    </div>
  );
}
