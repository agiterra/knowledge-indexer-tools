/**
 * Sidecar lifecycle management for the knowledge indexer.
 *
 * Manages a headless Haiku agent that handles all indexing work:
 * keyword generation, index-vault updates, and vectorize incremental.
 *
 * Sidecar is keyed by project directory (cwd), not agent ID. One sidecar
 * per repo, shared by all agents working in that directory. Exits after
 * 1 hour of inactivity.
 *
 * Uses crew-tools Orchestrator for agent lifecycle (screen sessions).
 * Communication via a file-based queue + screen sendKeys to poke.
 */

import { join } from "path";
import { createHash } from "crypto";
import { Orchestrator, screen } from "@agiterra/crew-tools";
import { queuePath } from "./queue.js";

const IDLE_TIMEOUT_MINUTES = 60;

/** Generate a stable sidecar ID for a project directory. */
function sidecarId(cwd: string): string {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return `kx-${hash}`;
}

/** Generate a display name from the project directory. */
function sidecarDisplay(cwd: string): string {
  const dirName = cwd.split("/").pop() ?? "unknown";
  return `KX (${dirName})`;
}

/**
 * Resolve knowledge-tools scripts path.
 * Accepts an explicit path or searches the plugin cache.
 */
export function resolveScriptsPath(pluginRoot?: string): string {
  if (pluginRoot) {
    return join(pluginRoot, "node_modules", "@agiterra", "knowledge-tools", "scripts");
  }
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

/** Check if the sidecar for a project is alive. */
export async function isAlive(cwd: string): Promise<boolean> {
  const orch = new Orchestrator();
  const id = sidecarId(cwd);
  const agent = orch.store.getAgent(id);
  if (!agent) return false;
  return screen.isAlive(agent.screen_name);
}

/** Find and health-check an existing sidecar. Returns true if responsive. */
export async function healthCheck(cwd: string): Promise<boolean> {
  if (!(await isAlive(cwd))) return false;

  const orch = new Orchestrator();
  const id = sidecarId(cwd);
  try {
    await orch.sendToAgent(id, "ping\n");
    await new Promise((r) => setTimeout(r, 2000));
    const output = await orch.readAgent(id);
    return output.length > 0;
  } catch {
    return false;
  }
}

/** Launch a new sidecar for a project. Kills any unresponsive existing one first. */
export async function launch(cwd: string, opts?: { scriptsPath?: string }): Promise<void> {
  const orch = new Orchestrator();
  const id = sidecarId(cwd);
  const scriptsPath = opts?.scriptsPath ?? resolveScriptsPath();

  // Check for existing sidecar for this project
  const existing = orch.store.getAgent(id);
  if (existing) {
    const alive = await screen.isAlive(existing.screen_name);
    if (alive) {
      const healthy = await healthCheck(cwd);
      if (healthy) return; // Already running and responsive
      await orch.stopAgent(id);
    } else {
      orch.store.deleteAgentByScreen(existing.screen_name);
    }
  }

  const prompt = `You are KX, a knowledge vault indexer sidecar for ${cwd.split("/").pop()}. You run as Haiku to save tokens.

Your job: when you receive a message, check the index queue at ${queuePath(cwd)} for file paths (one per line). For each file:

1. Read the file content
2. Generate a one-line semantic summary
3. Generate 10-25 keywords: concrete terms, abstract themes, synonyms, abbreviations
4. Run: python3 ${scriptsPath}/index-vault.py update <path> '<summary>' '<keywords-csv>' 'none'

After processing ALL queued files, clear the queue file, then run:
  python3 ${scriptsPath}/vectorize.py --incremental

If the queue is empty when you check, just run vectorize incremental in case journal entries changed.

If you receive "ping", respond with "pong" and nothing else.

IDLE TIMEOUT: If you receive no messages for ${IDLE_TIMEOUT_MINUTES} minutes, exit cleanly by typing /exit.

Format your work concisely. No commentary — just do the indexing and report what you indexed.`;

  await orch.launchAgent({
    env: {
      AGENT_ID: id,
      AGENT_NAME: sidecarDisplay(cwd),
    },
    runtime: "claude-code",
    projectDir: cwd,
    extraFlags: "--model haiku",
    prompt,
  });
}

/** Poke the sidecar for a project to process the queue. */
export async function poke(cwd: string): Promise<void> {
  const orch = new Orchestrator();
  await orch.sendToAgent(sidecarId(cwd), "process queue\n");
}

/** Stop the sidecar for a project. */
export async function stop(cwd: string): Promise<void> {
  const orch = new Orchestrator();
  const id = sidecarId(cwd);
  const agent = orch.store.getAgent(id);
  if (!agent) return;

  const alive = await screen.isAlive(agent.screen_name);
  if (alive) {
    await orch.stopAgent(id);
  } else {
    orch.store.deleteAgentByScreen(agent.screen_name);
  }
}
