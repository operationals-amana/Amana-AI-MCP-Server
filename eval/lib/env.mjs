import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Reads a shell-style env file (`export KEY=value` or `KEY=value`) into an object.
 * Anything already present in process.env wins, so CI can inject secrets without
 * a file on disk.
 */
export function loadEnv(fileName = ".env.production") {
  const env = {};
  const file = path.join(repoRoot, fileName);

  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (!match) continue;
      env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    }
  }

  return { ...env, ...process.env };
}

export function requireEnv(env, keys) {
  const missing = keys.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
  return env;
}

export { repoRoot };
