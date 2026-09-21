import { ZodError } from "zod";

function formatZodError(e) {
  // Zod 4 uses .issues, Zod 3 uses .errors
  const items = e.issues || e.errors || [];
  return items.map((err) => `${(err.path || []).join(".")}: ${err.message}`);
}

const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);

const isWholeNumberIssue = (issue) => issue.code === "invalid_type" && issue.expected === "int";

const isShapeMismatch = (issue) =>
  (issue.code === "invalid_type" && !isWholeNumberIssue(issue)) ||
  (issue.code === "invalid_value" && issue.values?.length === 1);

function innerIssue(issue) {
  if (issue.code !== "invalid_union" || !issue.errors) return issue;
  for (const branch of issue.errors) {
    const found = branch.map(innerIssue).find((i) => !isShapeMismatch(i));
    if (found) return { ...found, path: [...(issue.path || []), ...(found.path || [])] };
  }
  return issue;
}

function readableIssue(raw, labels) {
  const issue = innerIssue(raw);
  const key = issue.path?.[0];
  const label = key === undefined ? "" : (labels[key] ?? String(key).replaceAll("_", " "));
  if (issue.code === "unrecognized_keys") return `Unknown field: ${issue.keys.join(", ")}`;
  if (issue.message && !/^(Too (big|small)|Invalid)/.test(issue.message)) {
    return `${label} ${issue.message}`.trim();
  }
  if (isWholeNumberIssue(issue)) return `${label} must be a whole number`;
  if (issue.code === "invalid_value" && issue.values) {
    return `${label} must be one of: ${issue.values.join(", ")}`;
  }
  if (issue.code === "invalid_type" || issue.code === "invalid_union") {
    return `${label} is not valid`;
  }
  if (issue.code === "too_big" && issue.origin === "string") {
    return `${label} can be at most ${issue.maximum} characters`;
  }
  if (issue.code === "too_small" && issue.origin === "string") return `${label} can't be blank`;
  if (issue.code === "too_big") return `${label} can be at most ${issue.maximum}`;
  if (issue.code === "too_small") return `${label} must be at least ${issue.minimum}`;
  return `${label} ${issue.message}`.trim();
}

export function readableZodError(e, labels = {}) {
  const items = e.issues || e.errors || [];
  return [...new Set(items.map((issue) => sentence(readableIssue(issue, labels))))].join("; ");
}

function refuse(res, e, labels) {
  return res.status(400).json({
    error: labels ? readableZodError(e, labels) : "Validation failed",
    details: formatZodError(e),
  });
}

// Express middleware factory: validates req.body against a Zod schema
export function validate(schema, labels) {
  return (req, res, next) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (e) {
      if (e instanceof ZodError) return refuse(res, e, labels);
      return res.status(400).json({ error: "Invalid request body" });
    }
  };
}

// Validates req.query
export function validateQuery(schema, labels) {
  return (req, res, next) => {
    try {
      req.query = schema.parse(req.query);
      next();
    } catch (e) {
      if (e instanceof ZodError) return refuse(res, e, labels);
      return res.status(400).json({ error: "Invalid query parameters" });
    }
  };
}
