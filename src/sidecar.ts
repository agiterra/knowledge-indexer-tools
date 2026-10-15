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

const BOOT_CONFIRM_TIMEOUT_MS = 45000;

function isReadonlyRowWrite(e: unknown): boolean {
  return /attempt to write a readonly database/i.test(String((e as { message?: string })?.message ?? e));
}

/**
 * Press Enter through Claude Code's boot dialogs (folder trust, dev-channel
 * consent; all share "Enter to confirm") until the input footer renders.
 * Targets the exact pid.name of the ONE live session, never a bare name.
 * Throws on timeout: a sidecar parked at a dialog looks alive and indexes
 * nothing.
 */
async function confirmBootDialogs(name: string): Promise<void> {
  const timeoutMs = Number(process.env.KX_BOOT_CONFIRM_MS) || BOOT_CONFIRM_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pids = await liveSessionPids(name);
    if (pids.length > 1) throw new Error(`[kx] ${pids.length} live sessions named ${name} (${pids.join(",")}) -- a duplicate sidecar`);
    if (pids.length === 1) {
      const target = `${pids[0]}.${name}`;
      const buf = await screen.readOutput(target);
      if (buf.includes("Enter to confirm")) {
        await screen.sendKeys(target, "\r");
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      if (buf.includes("⏵⏵") || buf.includes("? for shortcuts")) return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`[kx] ${name}: boot dialogs did not clear within ${timeoutMs}ms -- the sidecar is parked, NOT launched`);
}

/** The only model a KX sidecar may run (Tim 2026-10-15). */
export const SIDECAR_MODEL = "haiku";

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
/**
 * Every pid of a LIVE screen session named EXACTLY `name` -- all of them, not the first.
 *
 * ⛔ 2026-09-24 (Brioche's vault, wire-kx-38732d94): screen keeps "(Remote or dead)" sockets for
 * sessions that died uncleanly, under the SAME name as the live one. crew-tools' listSessions drops
 * the state column and getSessionPid returns the FIRST name match, so with three dead sockets beside
 * the live sidecar the answer depended on listing order: a dead one sorted first -> ESRCH -> "not
 * running" -> the hook launched a SECOND full sidecar (both ~150 MB, both on the queue, for days).
 * A liveness question about a NAME has to look at every session carrying that name.
 * EPERM counts as alive: the process exists under another uid (see isAlive below).
 */
async function liveSessionPids(name: string): Promise<number[]> {
  const pids: number[] = [];
  for (const s of await screen.listSessions()) {
    if (s.name !== name) continue;
    const st = (s as { state?: string }).state;
    if (st && /dead/i.test(st)) continue;
    if (!Number.isFinite(s.pid) || s.pid <= 0) continue;
    try {
      process.kill(s.pid, 0);
      pids.push(s.pid);
    } catch (e: any) {
      if (e?.code === "EPERM") pids.push(s.pid); // exists, other uid
    }
  }
  return pids;
}

export async function isAlive(cwd: string): Promise<boolean> {
  const orch = await makeOrch();
  const id = sidecarId(cwd);
  const agent = orch.store.getAgent(id);
  // NOT `return false` on a missing row. An absent row is "unknown", not "dead" -- and the caller
  // LAUNCHES on false. crew-tools' reality layer deletes rows it cannot see (and a hook whose
  // CREW_DB is the shared registry never had one), so ask the screens directly.
  // ⛔ AND NOT the recorded screen_pid either: a row outlives its process (AGI-75 found the
  // reverse -- a live socket over a dead pid). The question is "is ANY session with this exact
  // name alive", which answers both the corpse case (all dead -> false) and the stale-row case
  // (row pid dead, sidecar alive under a newer pid -> true).
  const name = agent?.screen_name ?? `wire-${id}`;
  return (await liveSessionPids(name)).length > 0;
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
  const name = existing?.screen_name ?? `wire-${id}`;
  if ((await liveSessionPids(name)).length > 0) {
    // Rowless but live: running, merely unregistered (a shared-registry CREW_DB never had a kx row).
    // healthCheck cannot ping without a row, so do not mistake "unaddressable" for "unhealthy".
    if (!existing) return;
    const healthy = await healthCheck(cwd);
    if (healthy) return; // Already running and responsive
    await orch.stopAgent(id);
  } else if (existing) {
    orch.store.deleteAgentByScreen(existing.screen_name);
  }
  // ⛔ FINAL GATE: never spawn beside a live session of the same name. stopAgent kills through
  // crew-tools' first-match getSessionPid and a bare `screen -S <name> -X quit`, either of which can
  // miss the live session when dead same-named sockets exist; a rowless live sidecar has no row to
  // stop at all. Launching anyway is exactly how the duplicate was made. Say so, and stay out.
  const survivors = await liveSessionPids(name);
  if (survivors.length > 0) {
    console.error(
      `[kx] NOT launching ${id}: live screen session(s) ${survivors.join(",")} still named ${name} ` +
        `(unhealthy or unstoppable). Refusing to start a duplicate; inspect with screen -ls.`,
    );
    return;
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

  const launchOpts = {
    // The model is pinned TWICE, on purpose. Tim 2026-10-15: no sidecar ever
    // runs anything but Haiku. CLAUDE_MODEL feeds every runtime template that
    // reads ${CLAUDE_MODEL:-...}; without it the sidecar inherited the parent
    // persona's pin or the template default, and its argv carried
    // claude-fable-5 / claude-opus-4-8 ahead of the trailing flag. The trailing
    // --model haiku still wins (last flag wins) for a template that hardcodes
    // its own --model, e.g. a per-uid ~/.wire/runtimes.json.
    env: {
      AGENT_ID: id,
      AGENT_NAME: sidecarDisplay(cwd),
      CLAUDE_MODEL: SIDECAR_MODEL,
      // A hook or a CLI run from inside Claude Code inherits this marker, and
      // the sidecar then saves NO transcript ("Transcript saving is off"), so
      // nothing can show which model answered. Blank it for the sidecar.
      CLAUDE_CODE_CHILD_SESSION: "",
    },
    runtime: "claude-code",
    projectDir: cwd,
    extraFlags: `--model ${SIDECAR_MODEL}`,
    prompt,
    ttlIdleMinutes: IDLE_TIMEOUT_MINUTES,
  };
  try {
    await orch.launchAgent(launchOpts);
  } catch (e) {
    // crews.db is writable only by crew-service (AGI-27). crew-tools >= 2.27
    // creates the screen, fires its dialog auto-confirm without awaiting it,
    // and THEN throws on the row write. The sidecar is running, rowless by
    // design (isAlive, poke and stop all handle that), but this process exits
    // before the auto-confirm lands and the sidecar sits at its dev-channel
    // dialog forever. Any OTHER error is a real launch failure.
    if (!isReadonlyRowWrite(e)) throw e;
    console.warn(`[kx] ${id}: crews.db refused the row write (readonly outside crew-service). The sidecar runs rowless. Confirming its boot dialogs here.`);
    await confirmBootDialogs(`wire-${id}`);
  }

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

/**
 * Poke the sidecar for a project to process the queue.
 *
 * ⛔ 2026-10-07 (Brioche, j:2036): isAlive() stopped requiring a registry row in v1.4.1, but poke
 * still went through sendToAgent, which RESOLVES THE ROW and throws "agent 'kx-…' not found".
 * Sidecars never self-register and the crew reaper drops rows, so on a live rowless sidecar the
 * PostToolUse hook queued the file, called this, and died -- every vault write, every persona.
 * The queue was then drained only by the hourly host sweep. Two callers of one fact ("is there a
 * sidecar") must agree on what identifies it: here, as in isAlive, the live SCREEN is the source.
 * Address it by `<pid>.<name>`: a bare name is ambiguous when dead same-named sockets sit beside it.
 */
export async function poke(cwd: string): Promise<void> {
  const orch = await makeOrch();
  const id = sidecarId(cwd);
  if (orch.store.getAgent(id)) {
    await orch.sendToAgent(id, "process queue\n");
    return;
  }
  const name = `wire-${id}`;
  const pids = await liveSessionPids(name);
  if (pids.length === 0) {
    throw new Error(`[kx] cannot poke ${id}: no registry row and no live screen session named ${name}`);
  }
  if (pids.length > 1) {
    throw new Error(
      `[kx] cannot poke ${id}: ${pids.length} live sessions named ${name} (${pids.join(",")}) -- ` +
        `a duplicate sidecar; inspect with screen -ls, poking one would hide the other`,
    );
  }
  const target = `${pids[0]}.${name}`;
  // Body, settle, then a lone submit: a terminator inside the paste-coalescing window is inserted
  // as a newline instead of submitting (same recipe as crew-tools sendToAgent).
  await screen.sendKeys(target, "process queue");
  await new Promise((r) => setTimeout(r, 700));
  await screen.sendKeys(target, "\r");
}

/**
 * Stop the sidecar for a project, and PROVE it stopped.
 *
 * It used to return at once when there was no registry row. Sidecars never
 * self-register and the crew reaper drops unregistered rows, so the usual live
 * sidecar HAS no row: stop printed "stopped", the screen kept running, and the
 * next start saw it alive and launched nothing (2026-10-15, the Haiku restart).
 * Same row-dependence v1.4.2 removed from poke. Now: the crew path when a row
 * exists, then an exact pid.name kill of every live session that survives
 * (rowless, or a stop that missed), then a re-check that throws on a survivor.
 */
export async function stop(cwd: string): Promise<void> {
  const orch = await makeOrch();
  const id = sidecarId(cwd);
  const agent = orch.store.getAgent(id);
  const names = [...new Set([agent?.screen_name, `wire-${id}`].filter((n): n is string => !!n))];
  const live = async () => (await Promise.all(names.map(liveSessionPids))).flat();

  if (agent && (await live()).length > 0) await orch.stopAgent(id);
  for (const n of names) {
    if ((await liveSessionPids(n)).length > 0) await screen.killSession(n);
  }
  const left = await live();
  if (left.length > 0) {
    throw new Error(
      `[kx] stop ${id} did not stop it: live session pid(s) ${left.join(",")} remain under ${names.join(" / ")}. NOT reporting this as stopped.`,
    );
  }
  if (orch.store.getAgent(id)) orch.store.deleteAgentByScreen(agent?.screen_name ?? `wire-${id}`);
}
