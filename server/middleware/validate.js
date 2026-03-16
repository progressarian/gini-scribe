import { ZodError } from "zod";

function formatZodError(e) {
  // Zod 4 uses .issues, Zod 3 uses .errors
  const items = e.issues || e.errors || [];
  return items.map((err) => `${(err.path || []).join(".")}: ${err.message}`);
}

// Express middleware factory: validates req.body against a Zod schema
export function validate(schema) {
  return (req, res, next) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (e) {
      if (e instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: formatZodError(e) });
      }
      return res.status(400).json({ error: "Invalid request body" });
    }
  };
}

// Validates req.query
export function validateQuery(schema) {
  return (req, res, next) => {
    try {
      req.query = schema.parse(req.query);
      next();
    } catch (e) {
      if (e instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", details: formatZodError(e) });
      }
      return res.status(400).json({ error: "Invalid query parameters" });
    }
  };
}
