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
import { Orchestrator, screen, createBackend } from "@agiterra/crew-tools";
import { queuePath, enqueue, readQueueEntries } from "./queue.js";

/** How long launch() waits for the registry row to show a live process. */
const LAUNCH_VERIFY_TIMEOUT_MS = 20000;

const IDLE_TIMEOUT_MINUTES = 60;

/**
 * Build an Orchestrator. The sidecar only calls methods that don't touch
 * the terminal backend (launchAgent, sendToAgent, readAgent, stopAgent),
 * but crew-tools v2.1.0 requires the backend in the constructor — the
 * detected backend is fine; none of its methods will actually run.
 */
async function makeOrch(): Promise<Orchestrator> {
  return new Orchestrator(await createBackend());
}

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

/**
 * Check if the sidecar for a project is alive.
 *
 * SCREEN SOCKET PRESENCE IS NOT LIVENESS. screen.isAlive checks that a socket
 * with that name exists, and screen leaves "(Remote or dead)" sockets behind on
 * unclean shutdown -- after one reboot, 17 of 17 "alive" pids did not exist.
 * This reported a DEAD sidecar as running for an entire session while the vault
 * silently went unindexed (2026-07-31: 10 files on one vault, 6 on another).
 *
 * So the socket is necessary but not sufficient: the registered pid must also
 * be a live process. Checked with signal 0, which tests existence without
 * touching the process.
 */
export async function isAlive(cwd: string): Promise<boolean> {
  const orch = await makeOrch();
  const id = sidecarId(cwd);
  const agent = orch.store.getAgent(id);
  if (!agent) return false;
  if (!(await screen.isAlive(agent.screen_name))) return false;

  const pid = Number(agent.screen_pid);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // stale registry row sitting over a dead socket
  }
}

/** Find and health-check an existing sidecar. Returns true if responsive. */
export async function healthCheck(cwd: string): Promise<boolean> {
  if (!(await isAlive(cwd))) return false;

  const orch = await makeOrch();
  const id = sidecarId(cwd);
  try {
    // CORRELATE THE RESPONSE WITH THE REQUEST. This used to return
    // "output.length > 0" -- i.e. "the screen buffer has some text in it" --
    // which a DEAD screen satisfies with stale content from before it died. A
    // reading that cannot tell a fresh reply from leftover scrollback is not a
    // health check; it is a check that the terminal once had output.
    //
    // The sidecar prompt already specifies the contract: on "ping", respond
    // "pong" and nothing else. That contract was never checked. Count pongs
    // BEFORE and require a NEW one after, so a pong left over from an earlier
    // probe cannot pass for this one.
    const countPongs = (t: string) => (t.match(/pong/gi) ?? []).length;
    const before = countPongs(await orch.readAgent(id));
    await orch.sendToAgent(id, "ping\n");
    await new Promise((r) => setTimeout(r, 2000));
    const after = countPongs(await orch.readAgent(id));
    return after > before;
  } catch {
    return false;
  }
}

/** Launch a new sidecar for a project. Kills any unresponsive existing one first. */
export async function launch(cwd: string, opts?: { scriptsPath?: string }): Promise<void> {
  const orch = await makeOrch();
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
    ttlIdleMinutes: IDLE_TIMEOUT_MINUTES,
  });

  // VERIFY THE EFFECT, NOT THE CALL. launch used to return as soon as
  // launchAgent resolved, and the CLI printed "kx sidecar: launched" even when
  // the registry still held the OLD dead pid and nothing had started. A start
  // command that reports success without starting anything is the same defect
  // one layer along from a status command that reports healthy about a corpse:
  // the fixer lies as confidently as the detector did.
  // POLL, do not sample once. The first version checked after a flat 1500ms and
  // threw while the sidecar was in fact starting fine -- the registry row simply
  // had not been written yet. A start command that reports failure on a success
  // trains everyone to ignore it, which costs more than the bug it was added to
  // catch (same reasoning as making the shell linter escape-aware).
  const deadline = Date.now() + LAUNCH_VERIFY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isAlive(cwd)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    "sidecar launch did not produce a live process for " + id + " within " +
      LAUNCH_VERIFY_TIMEOUT_MS + "ms -- the registry row was never updated or the runtime exited immediately. NOT reporting this as launched.",
  );
}

/**
 * Launch, then RECONCILE. A restarted sidecar with an empty queue is useless if
 * the vault drifted while it was down, and that state looks perfectly healthy
 * from every angle. Anything the scan says is unindexed gets enqueued and poked.
 *
 * Separate from launch() so the liveness guarantee and the reconcile are
 * independently testable, and so a reconcile failure is never mistaken for a
 * launch failure -- the message says which one broke.
 */
export async function launchAndReconcile(
  cwd: string,
  opts?: { scriptsPath?: string },
): Promise<{ launched: boolean; enqueued: number }> {
  await launch(cwd, opts);
  let enqueued = 0;
  try {
    enqueued = await reconcile(cwd, opts);
  } catch (e: any) {
    throw new Error(
      "sidecar IS running, but reconcile failed so the vault may have an invisible backlog: " +
        String(e?.message ?? e),
    );
  }
  if (enqueued > 0) await poke(cwd);
  return { launched: true, enqueued };
}

/**
 * Reconcile the QUEUE against the vault's actual index state.
 *
 * ★ THE QUEUE CANNOT SEE ITS OWN BACKLOG. The sidecar only ever processes the
 * queue, and the queue is written by a hook at vault-write time. So anything
 * written while the sidecar was DEAD was never enqueued and is invisible to it
 * forever: after a successful restart you get an EMPTY queue sitting beside
 * unindexed files, with the sidecar, the queue and the status command all
 * reporting fine (2026-07-31 -- 6 files on one vault, 10 on another, 4 of which
 * survived a restart).
 *
 * index-vault.py scan already knows the truth. It was A MEASUREMENT WITH NO
 * CONSUMER, which is its own failure class: nobody is wrong, and nothing acts.
 *
 * So: ask the scan what is unindexed, enqueue whatever the queue is missing, and
 * return the count so the caller can SAY so. Reconciling from the authoritative
 * state rather than trusting an incremental log is the same move as reading a
 * lane's position from an append-only log rather than a terminal buffer.
 */
export async function reconcile(
  cwd: string,
  opts?: { scriptsPath?: string },
): Promise<number> {
  const scriptsPath = opts?.scriptsPath ?? resolveScriptsPath();
  const proc = Bun.spawn(["python3", join(scriptsPath, "index-vault.py"), "scan"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    // FAIL LOUD. A reconcile that silently returns 0 is indistinguishable from
    // a vault with nothing outstanding -- the calm-looking failure again.
    throw new Error(
      "index-vault.py scan failed (exit " + code + "); cannot reconcile the queue: " + err.slice(0, 200),
    );
  }

  const needed = out
    .split("\n")
    .filter((l) => l.includes("NEEDS_INDEX:"))
    .map((l) => l.slice(l.indexOf("NEEDS_INDEX:") + "NEEDS_INDEX:".length).trim())
    .filter(Boolean);
  if (needed.length === 0) return 0;

  const already = new Set(await readQueueEntries(cwd));
  const missing = needed.filter((f) => !already.has(f));
  for (const f of missing) await enqueue(cwd, f);
  return missing.length;
}

/** Poke the sidecar for a project to process the queue. */
export async function poke(cwd: string): Promise<void> {
  const orch = await makeOrch();
  await orch.sendToAgent(sidecarId(cwd), "process queue\n");
}

/** Stop the sidecar for a project. */
export async function stop(cwd: string): Promise<void> {
  const orch = await makeOrch();
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
