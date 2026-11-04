export const TESTS_DUE = [
  {
    key: "abi",
    label: "ABI",
    months: 12,
    docTypes: ["abi"],
    resultNames: ["ABI Left", "ABI Right"],
  },
  {
    key: "vpt",
    label: "VPT",
    months: 12,
    docTypes: ["vpt"],
    resultNames: ["VPT Left", "VPT Right"],
  },
  {
    key: "fundus",
    label: "Fundus",
    months: 12,
    docTypes: ["eye"],
    docPattern:
      "\\m(fundus\\w*|fundoscop\\w*|funduscop\\w*|retinopathy|npdr|pdr|retinal (photo|imag)\\w*)",
  },
  { key: "echo", label: "Echo", months: 6, docTypes: ["echo"] },
];

export const TESTS_DUE_KEYS = TESTS_DUE.map((t) => t.key);

export const TESTS_DUE_DECISIONS = ["ordered", "declined"];

export const TESTS_DUE_SOURCE_LABEL = {
  result: "result on file",
  floor: "done on the floor",
  bill: "billed",
  report: "report",
};

export const intervalLabel = (months) => (months === 12 ? "yearly" : `every ${months} months`);
