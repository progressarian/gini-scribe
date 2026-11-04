import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const CODE_EXTENSIONS = new Set(["js", "jsx", "mjs", "cjs", "ts", "tsx", "json", "html", "sh", ""]);
const KNOWN_EXTENSIONS = new Set([
  ...CODE_EXTENSIONS,
  "sql",
  "md",
  "css",
  "txt",
  "yml",
  "yaml",
  "csv",
  "svg",
  "map",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "ico",
  "webp",
  "pdf",
  "xlsx",
  "docx",
  "woff",
  "woff2",
  "ttf",
  "eot",
  "otf",
  "example",
  "e2e",
  "gitignore",
  "prettierrc",
  "prettierignore",
  "dockerignore",
  "nvmrc",
  "npmrc",
]);
const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "ico",
  "webp",
  "pdf",
  "xlsx",
  "docx",
  "woff",
  "woff2",
  "ttf",
  "eot",
  "otf",
]);
const ALLOWED_NO_EXTENSION = new Set(["Dockerfile", "Procfile", "LICENSE"]);
const LIFECYCLE_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "postprepare",
];
const ALLOWED_PREPARE = new Set(["husky", "husky || true"]);
const MAX_CODE_LINE = 20000;
const KNOWN_INDICATORS = [/95\.135\.181\.151/, /\.npm-ws\./, /q4FZkxX\{!h,Sr3=@/];

const rev = process.argv[2];

function git(args, input) {
  return execFileSync("git", args, { input, maxBuffer: 1024 * 1024 * 512 });
}

function readTree() {
  if (!rev) {
    const paths = git(["ls-files", "-z"]).toString().split("\0").filter(Boolean);
    return paths
      .map((file) => {
        try {
          return { file, content: readFileSync(file) };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
  const entries = git(["ls-tree", "-r", "-z", rev])
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, file] = line.split("\t");
      const [, type, sha] = meta.split(" ");
      return { file, type, sha };
    })
    .filter((entry) => entry.type === "blob");
  const output = git(["cat-file", "--batch"], entries.map((entry) => entry.sha).join("\n") + "\n");
  let offset = 0;
  return entries.map((entry) => {
    const headerEnd = output.indexOf(10, offset);
    const size = Number(output.subarray(offset, headerEnd).toString().split(" ")[2]);
    const content = output.subarray(headerEnd + 1, headerEnd + 1 + size);
    offset = headerEnd + 1 + size + 1;
    return { file: entry.file, content };
  });
}

function extensionOf(file) {
  const base = path.basename(file);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? (base.startsWith(".") ? base.slice(1) : "") : base.slice(dot + 1).toLowerCase();
}

function isBinary(content) {
  return content.subarray(0, 8000).includes(0);
}

function checkFile({ file, content }, report) {
  const ext = extensionOf(file);
  const base = path.basename(file);
  const binary = isBinary(content);

  if (!KNOWN_EXTENSIONS.has(ext)) report(file, 0, `unrecognised file type ".${ext}"`);
  if (ext === "" && !ALLOWED_NO_EXTENSION.has(base) && !file.startsWith(".husky/") && !binary) {
    report(file, 0, "extensionless file in the repo; scripts must have a .js/.mjs/.sh extension");
  }
  if (
    BINARY_EXTENSIONS.has(ext) &&
    !binary &&
    /require\(|process\.|function\s*\(|=>/.test(content.toString())
  ) {
    report(file, 0, `.${ext} file contains JavaScript`);
  }
  if (binary) return;

  const text = content.toString();
  KNOWN_INDICATORS.forEach((pattern) => {
    if (pattern.test(text))
      report(file, 0, `matches a known malware indicator (${pattern.source})`);
  });

  if (!CODE_EXTENSIONS.has(ext)) return;
  if (base === "package-lock.json" || base.endsWith(".min.js")) return;

  text.split("\n").forEach((line, index) => {
    if (/[ \t]{80,}\S/.test(line))
      report(file, index + 1, "code hidden after a long run of whitespace");
    if (line.length > MAX_CODE_LINE)
      report(file, index + 1, `line is ${line.length} characters long`);
  });

  const hexCalls = text.match(/(parseInt|parseFloat|Math\.\w+)\(-?0x[0-9a-f]+/gi) || [];
  if (hexCalls.length >= 10 || /_0x[0-9a-f]{4,}/i.test(text)) report(file, 0, "looks obfuscated");

  if (base === "tasks.json" && file.includes(".vscode") && /folderOpen/.test(text)) {
    report(file, 0, "VS Code task runs automatically when the folder is opened");
  }

  if (base === "package.json") checkPackageJson(file, text, report);
}

function checkPackageJson(file, text, report) {
  let scripts;
  try {
    scripts = JSON.parse(text).scripts || {};
  } catch {
    report(file, 0, "package.json is not valid JSON");
    return;
  }
  LIFECYCLE_SCRIPTS.forEach((name) => {
    if (scripts[name]) report(file, 0, `"${name}" script runs on npm install: ${scripts[name]}`);
  });
  if (scripts.prepare && !ALLOWED_PREPARE.has(scripts.prepare)) {
    report(file, 0, `"prepare" script runs on npm install: ${scripts.prepare}`);
  }
  Object.entries(scripts).forEach(([name, command]) => {
    for (const match of command.matchAll(/\bnode\s+((?:-\S+\s+)*)(\S+)/g)) {
      const target = match[2];
      if (!/\.(m|c)?js$/.test(target) && !target.endsWith("/") && !target.startsWith("$")) {
        report(file, 0, `script "${name}" runs "node ${target}", a file without a .js extension`);
      }
    }
  });
}

function checkGitignore(files, report) {
  const gitignore = files.find((entry) => entry.file === ".gitignore");
  const lines = gitignore
    ? gitignore.content
        .toString()
        .split(/\r?\n/)
        .map((line) => line.trim())
    : [];
  if (!lines.some((line) => line === ".env" || line === "*.env"))
    report(".gitignore", 0, ".env is no longer ignored");
  if (!lines.includes(".env.*")) report(".gitignore", 0, ".env.* is no longer ignored");
}

const findings = [];
const report = (file, line, message) => findings.push({ file, line, message });
const files = readTree();
files.forEach((entry) => checkFile(entry, report));
checkGitignore(files, report);

if (findings.length) {
  console.error(
    `\nRepo safety check FAILED for ${rev || "the working tree"} (${findings.length} problem${findings.length > 1 ? "s" : ""}):\n`,
  );
  findings.forEach(({ file, line, message }) =>
    console.error(`  ${file}${line ? `:${line}` : ""}  ${message}`),
  );
  console.error(
    "\nThis pattern matches the Nov 2026 malware commit. Do not push or run npm scripts until it is reviewed.\n",
  );
  process.exit(1);
}
console.log(`Repo safety check passed for ${rev || "the working tree"} (${files.length} files).`);
