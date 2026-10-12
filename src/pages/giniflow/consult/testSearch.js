export const TEST_URGENCY = [
  { key: "today", label: "Today", sub: "lab now" },
  { key: "tomorrow", label: "Tomorrow", sub: "reception" },
  { key: "next_visit", label: "Next visit", sub: "with the follow-up" },
];

export const searchText = (value) =>
  (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export const rupees = (amount) => `₹${Number(amount || 0).toLocaleString("en-IN")}`;

export const MIN_SEARCH_LENGTH = 2;

const POPULAR_LIMIT = 24;

export function buildTestIndex(tests) {
  return tests.map((test) => {
    const name = searchText(test.name);
    const words = `${name} ${searchText(test.gloss)}`;
    return { test, name, words, compact: words.replace(/ /g, "") };
  });
}

const byUsageThenName = (a, b) =>
  (b.uses || 0) - (a.uses || 0) || a.name.localeCompare(b.name, "en", { sensitivity: "base" });

export function searchTests(index, query) {
  const tokens = searchText(query).split(" ").filter(Boolean);
  const matches =
    tokens.join("").length < MIN_SEARCH_LENGTH
      ? index
      : index.filter((entry) =>
          tokens.every((token) => entry.words.includes(token) || entry.compact.includes(token)),
        );
  return matches.map((entry) => entry.test).sort(byUsageThenName);
}

export function pickPopular(tests, panels) {
  const panelNames = new Set(panels.flatMap((p) => p.tests));
  const used = tests.filter((t) => t.uses > 0).sort((a, b) => b.uses - a.uses);
  const curated = tests.filter((t) => !(t.uses > 0) && (panelNames.has(t.name) || t.gloss));
  return new Set([...used, ...curated].slice(0, POPULAR_LIMIT).map((t) => t.name));
}

export const isSearching = (filter) =>
  searchText(filter).replace(/ /g, "").length >= MIN_SEARCH_LENGTH;
