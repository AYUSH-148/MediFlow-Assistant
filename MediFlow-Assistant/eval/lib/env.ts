import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Next.js loads `.env.local` and `.env` into `process.env` before any route module runs.
 * The eval harness is a plain tsx process, so nothing does that for it - and every client
 * in this codebase (Pinecone, Upstash, HuggingFace, Gemini) reads its key at module load.
 * That means `loadEnv()` has to run BEFORE those modules are imported, which is why every
 * runner imports it statically and then pulls its suite in with a dynamic `import()`.
 */

// Precedence matches Next: `.env.local` overrides `.env`, and a variable already present
// in the real environment overrides both (so CI can inject keys without touching files).
const ENV_FILES = [".env.local", ".env"];

function parseEnvFile(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const declaration = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = declaration.indexOf("=");
    if (separator === -1) continue;

    const key = declaration.slice(0, separator).trim();
    if (!key) continue;

    let value = declaration.slice(separator + 1).trim();
    const quote = value[0];

    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      // Only double quotes carry escapes, matching dotenv.
      if (quote === '"') value = value.replace(/\\n/g, "\n");
    } else {
      // An unquoted value ends at an inline comment. The leading space is required so a
      // URL fragment or a token containing '#' is not truncated.
      const comment = value.indexOf(" #");
      if (comment !== -1) value = value.slice(0, comment).trim();
    }

    parsed[key] = value;
  }

  return parsed;
}

export function loadEnv(root: string = process.cwd()): string[] {
  const loaded: string[] = [];

  for (const file of ENV_FILES) {
    const path = resolve(root, file);
    if (!existsSync(path)) continue;

    loaded.push(file);
    for (const [key, value] of Object.entries(parseEnvFile(readFileSync(path, "utf8")))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }

  return loaded;
}

/**
 * Fail before the first API call rather than midway through a suite, where a missing key
 * surfaces as a partial result set that still prints a confident-looking percentage.
 */
export function requireEnv(keys: string[]): void {
  const missing = keys.filter((key) => !process.env[key]?.trim());
  if (missing.length === 0) return;

  throw new Error(
    `Missing required environment variable(s): ${missing.join(", ")}.\n` +
      `Set them in .env.local (see .env.local.example) before running the eval.`
  );
}
