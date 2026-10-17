export const ASSIGNABLE_ROLES = ["growth_executive", "growth_manager", "head_of_growth"];
export const ASSIGNING_ROLES = ["ceo_admin", "head_of_growth"];

const TITLES = new Set(["dr", "mr", "mrs", "ms", "miss", "shri", "smt"]);

export function normaliseName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !TITLES.has(t))
    .join(" ");
}

export function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

const split = (person) => {
  const tokens = normaliseName(person.full_name).split(" ").filter(Boolean);
  return {
    person,
    full: tokens.join(" "),
    first: tokens[0] || "",
    last: tokens.slice(1).join(" "),
  };
};

const names = (list) => list.map((c) => c.person.full_name).join(", ");

function closest(typed, people) {
  const ranked = people
    .map((p) => ({
      p,
      d: typed.includes(" ") ? editDistance(typed, p.full) : editDistance(typed, p.first),
    }))
    .sort((a, b) => a.d - b.d);
  const best = ranked[0];
  if (!best || best.d > Math.max(3, Math.floor(typed.length / 2))) return null;
  if (ranked[1] && ranked[1].d === best.d) return null;
  return best.p.person;
}

function lookup(typed, people) {
  const tokens = typed.split(" ");
  const exact = people.filter((p) => p.full === typed);
  if (exact.length === 1) return { hit: exact[0].person, note: null };
  if (exact.length > 1) return { ambiguous: exact };

  if (tokens.length === 1) {
    const byFirst = people.filter((p) => p.first === typed);
    if (byFirst.length === 1) return { hit: byFirst[0].person, note: "Matched by first name" };
    if (byFirst.length > 1) return { ambiguous: byFirst };
    const byLast = people.filter((p) => p.last === typed);
    if (byLast.length === 1) return { hit: byLast[0].person, note: "Matched by surname" };
    if (byLast.length > 1) return { ambiguous: byLast };
    return null;
  }

  const rest = tokens.slice(1).join(" ");
  const near = people.filter((p) => p.first === tokens[0] && editDistance(rest, p.last) <= 2);
  if (near.length === 1) return { hit: near[0].person, note: "Check spelling" };
  if (near.length > 1) return { ambiguous: near };
  return null;
}

export function resolveAssignee(typedValue, staff, others = []) {
  const typed = normaliseName(typedValue);
  if (!typed) return { status: "blank" };

  const assignable = staff.map(split);
  const found = lookup(typed, assignable);
  if (found?.hit) return { status: "matched", assignee: found.hit, note: found.note };
  if (found?.ambiguous) {
    return {
      status: "failed",
      reason: `Matches ${found.ambiguous.length} staff: ${names(found.ambiguous)}`,
      suggestion: null,
    };
  }

  const outsider = lookup(typed, others.map(split));
  if (outsider?.hit) {
    return {
      status: "failed",
      reason: `${outsider.hit.full_name} is not on the growth team`,
      suggestion: null,
    };
  }

  const suggestion = closest(typed, assignable);
  return {
    status: "failed",
    reason: `No staff named ${String(typedValue).trim()}`,
    suggestion,
  };
}
