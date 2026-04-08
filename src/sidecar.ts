/**
 * Sidecar lifecycle management for the knowledge indexer.
 *
 * Manages a headless Haiku agent that handles all indexing work:
 * keyword generation, index-vault updates, and vectorize incremental.
 *
 * Uses crew-tools Orchestrator for agent lifecycle (screen sessions).
 * Communication via a file-based queue + screen sendKeys to poke.
 */

import { join } from "path";
import { Orchestrator, screen } from "@agiterra/crew-tools";
import { queuePath } from "./queue.js";

const SIDECAR_ID = "kx";
const SIDECAR_DISPLAY = "KX (indexer)";

/**
 * Resolve knowledge-tools scripts path.
 * Accepts an explicit path or searches the plugin cache.
 */
export function resolveScriptsPath(pluginRoot?: string): string {
  if (pluginRoot) {
    return join(pluginRoot, "node_modules", "@agiterra", "knowledge-tools", "scripts");
  }
  // Fallback: search plugin cache
  const cacheBase = join(process.env.HOME ?? "/tmp", ".claude", "plugins", "cache");
  const { readdirSync, existsSync } = require("fs");
  try {
    for (const market of readdirSync(cacheBase)) {
      const knowledgeDir = join(cacheBase, market, "knowledge");
      if (!existsSync(knowledgeDir)) continue;
      const versions = readdirSync(knowledgeDir).sort().reverse();
      for (const v of versions) {
        const scripts = join(knowledgeDir, v, "node_modules", "@agiterra", "knowledge-tools", "scripts");
        if (existsSync(scripts)) return scripts;
      }
    }
  } catch { /* fall through */ }
  throw new Error("knowledge-tools scripts not found in plugin cache");
}

/** Check if the sidecar is alive. */
export async function isAlive(): Promise<boolean> {
  const orch = new Orchestrator();
  const agent = orch.store.getAgent(SIDECAR_ID);
  if (!agent) return false;
  return screen.isAlive(agent.screen_name);
}

/** Find and health-check an existing sidecar. Returns true if responsive. */
export async function healthCheck(): Promise<boolean> {
  if (!(await isAlive())) return false;

  const orch = new Orchestrator();
  try {
    await orch.sendToAgent(SIDECAR_ID, "ping\n");
    await new Promise((r) => setTimeout(r, 2000));
    const output = await orch.readAgent(SIDECAR_ID);
    return output.length > 0;
  } catch {
    return false;
  }
}

/** Launch a new sidecar. Kills any unresponsive existing one first. */
export async function launch(cwd: string, opts?: { scriptsPath?: string }): Promise<void> {
  const orch = new Orchestrator();
  const scriptsPath = opts?.scriptsPath ?? resolveScriptsPath();

  // Check for existing
  const existing = orch.store.getAgent(SIDECAR_ID);
  if (existing) {
    const alive = await screen.isAlive(existing.screen_name);
    if (alive) {
      const healthy = await healthCheck();
      if (healthy) return; // Already running and responsive
      await orch.stopAgent(SIDECAR_ID);
    } else {
      orch.store.deleteAgent(SIDECAR_ID);
    }
  }

  const prompt = `You are KX, a knowledge vault indexer sidecar. You run as Haiku to save tokens.

Your job: when you receive a message, check the index queue at ${queuePath(cwd)} for file paths (one per line). For each file:

1. Read the file content
2. Generate a one-line semantic summary
3. Generate 10-25 keywords: concrete terms, abstract themes, synonyms, abbreviations
4. Run: python3 ${scriptsPath}/index-vault.py update <path> '<summary>' '<keywords-csv>' 'none'

After processing ALL queued files, clear the queue file, then run:
  python3 ${scriptsPath}/vectorize.py --incremental

If the queue is empty when you check, just run vectorize incremental in case journal entries changed.

If you receive "ping", respond with "pong" and nothing else.

Format your work concisely. No commentary — just do the indexing and report what you indexed.`;

  await orch.launchAgent({
    id: SIDECAR_ID,
    displayName: SIDECAR_DISPLAY,
    runtime: "claude-code",
    projectDir: cwd,
    extraFlags: "--model haiku",
    prompt,
  });
}

/** Poke the sidecar to process the queue. */
export async function poke(): Promise<void> {
  const orch = new Orchestrator();
  await orch.sendToAgent(SIDECAR_ID, "process queue\n");
}

/** Stop the sidecar. */
export async function stop(): Promise<void> {
  const orch = new Orchestrator();
  const agent = orch.store.getAgent(SIDECAR_ID);
  if (!agent) return;

  const alive = await screen.isAlive(agent.screen_name);
  if (alive) {
    await orch.stopAgent(SIDECAR_ID);
  } else {
    orch.store.deleteAgent(SIDECAR_ID);
  }
}
