/**
 * Watched path detection.
 *
 * Reads vault config to determine which directories should trigger
 * auto-indexing on write.
 */

import { resolve } from "path";
import { readFileSync, existsSync } from "fs";

/** Load watched directories from knowledge-tools config. */
export function loadWatchedDirs(cwd: string): string[] {
  const vaultDir = process.env.KNOWLEDGE_VAULT ?? ".knowledge";
  const configPath = resolve(cwd, vaultDir, "config.json");
  const dirs = [resolve(cwd, vaultDir)];

  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
    for (const d of cfg.extra_dirs ?? []) {
      const abs = resolve(cwd, d);
      if (existsSync(abs)) {
        dirs.push(abs);
      }
    }
  } catch {
    // No config or parse error — just use vault dir
  }

  return dirs;
}

/** Check if a file path falls under any watched directory. */
export function isWatched(filePath: string, watchedDirs: string[]): boolean {
  const abs = resolve(filePath);
  return watchedDirs.some((dir) => abs.startsWith(dir + "/") || abs === dir);
}
