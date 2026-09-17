import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeTemplateFile } from "../services/billing/importTemplate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const target =
  process.argv[2] ?? path.resolve(here, "..", "..", "docs", "gini-flow", "billing-template.xlsx");

await writeTemplateFile(target);
console.log(`Billing template written to ${path.relative(process.cwd(), target)}`);
