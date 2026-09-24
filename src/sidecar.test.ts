/**
 * isAlive is the probe that GATES ITS OWN RECOVERY PATH.
 *
 * post-tool-use.ts relaunches the sidecar only when `!isAlive(cwd)`. So a false
 * positive here does not merely misreport -- it disables the fix. AGI-75: a dead
 * sidecar whose screen socket lingered read as alive, check-sidecar printed the
 * self-contradicting "running (unresponsive)", the hook never took its launch
 * branch, and Herald's indexer sat dead for five days behind 160 queued paths.
 *
 * These tests pin BOTH directions, because a probe that gates recovery has two
 * ways to be useless: say alive about a corpse (never recover) and say dead
 * about a live process (relaunch forever, duplicate indexers on one queue).
 *
 * 2026-09-24 added the second direction's real incident: Brioche's vault had
 * three "(Remote or dead)" sockets named wire-kx-38732d94 beside the live one,
 * the probe looked at the FIRST name match, and the hook launched a duplicate
 * sidecar that ran beside the original for days. Hence the session LIST below,
 * with same-named dead entries ordered first.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createHash } from "crypto";

type Sess = { name: string; pid: number; state?: string };

/** Scriptable stand-ins for everything the sidecar consults or calls. */
const state = {
  agent: null as { id: string; screen_name: string; screen_pid: number | null } | null,
  sessions: [] as Sess[],
  launched: 0,
  stopped: 0,
  deleted: 0,
  pong: false,
  pongs: 0,
};

// Installed BEFORE sidecar is imported -- sidecar builds its Orchestrator at
// call time, but the module binding is captured at import.
mock.module("@agiterra/crew-tools", () => ({
  screen: {
    listSessions: async () => state.sessions,
    // Deliberately the OLD first-match semantics, so a regression back to it is caught.
    isAlive: async (name: string) => state.sessions.some((s) => s.name === name),
  },
  createBackend: async () => ({}),
  Orchestrator: class {
    store = {
      getAgent: (_id: string) => state.agent,
      deleteAgentByScreen: (_n: string) => { state.deleted++; state.agent = null; },
    };
    async readAgent(_id: string) {
      if (!state.agent) throw new Error("agent not found");
      return "pong ".repeat(state.pongs); // a NEW pong appears only after a ping, as healthCheck requires
    }
    async sendToAgent(_id: string, _t: string) {
      if (!state.agent) throw new Error("agent not found");
      if (state.pong) state.pongs++;
    }
    // A stop that does NOT kill the live session: what crew-tools' first-match
    // getSessionPid + bare `screen -S <name> -X quit` does when dead same-named sockets exist.
    async stopAgent(_id: string) { state.stopped++; }
    async launchAgent(_o: unknown) {
      state.launched++;
      state.sessions.push({ name: `wire-${ID}`, pid: process.pid });
    }
  },
}));

const { isAlive, launch } = await import("./sidecar.js");

const CWD = "/tmp/kx-test-project";
const ID = "kx-" + createHash("sha256").update(CWD).digest("hex").slice(0, 8);
const NAME = `wire-${ID}`;

/** A pid that is certainly gone: spawn, wait for exit, reuse its number. */
async function deadPid(): Promise<number> {
  const proc = Bun.spawn(["true"]);
  const pid = proc.pid;
  await proc.exited;
  return pid;
}

function registerAgent(screen_pid: number | null) {
  state.agent = { id: ID, screen_name: NAME, screen_pid };
}

beforeEach(() => {
  state.agent = null;
  state.sessions = [];
  state.launched = 0;
  state.stopped = 0;
  state.deleted = 0;
  state.pong = false;
  state.pongs = 0;
});

describe("isAlive", () => {
  test("socket present + its pid DEAD -> false (the AGI-75 corpse)", async () => {
    const d = await deadPid();
    state.sessions = [{ name: NAME, pid: d, state: "(Remote or dead)" }];
    registerAgent(d);
    expect(await isAlive(CWD)).toBe(false);
  });

  test("dead socket even WITHOUT a state column -> false (crew-tools drops it)", async () => {
    const d = await deadPid();
    state.sessions = [{ name: NAME, pid: d }];
    registerAgent(d);
    expect(await isAlive(CWD)).toBe(false);
  });

  test("live session, row pid matches -> true", async () => {
    state.sessions = [{ name: NAME, pid: process.pid }];
    registerAgent(process.pid);
    expect(await isAlive(CWD)).toBe(true);
  });

  test("no session at all -> false, even with a live recorded pid", async () => {
    registerAgent(process.pid);
    expect(await isAlive(CWD)).toBe(false);
  });

  // ★ THE 2026-09-24 INCIDENT: three dead same-named sockets listed BEFORE the live one.
  test("dead same-named sockets FIRST, live one after -> true", async () => {
    state.sessions = [
      { name: NAME, pid: await deadPid() },
      { name: NAME, pid: await deadPid() },
      { name: NAME, pid: await deadPid() },
      { name: NAME, pid: process.pid },
    ];
    registerAgent(await deadPid()); // and the row itself is stale, as it was
    expect(await isAlive(CWD)).toBe(true);
  });

  test("NO registry row + live session -> true (absent row is unknown, not dead)", async () => {
    state.sessions = [{ name: NAME, pid: process.pid }];
    expect(await isAlive(CWD)).toBe(true);
  });

  test("no registry row + no session -> false", async () => {
    expect(await isAlive(CWD)).toBe(false);
  });

  test("a PREFIX-named live session is not ours -> false", async () => {
    state.sessions = [{ name: NAME + "-2", pid: process.pid }];
    expect(await isAlive(CWD)).toBe(false);
  });

  // EPERM is not ESRCH. pid 1 (launchd) exists but refuses our signal as a
  // non-root user; a sidecar under another uid looks exactly the same.
  // (Running as root the kill simply succeeds -- either way the answer is true.)
  test("live but unsignalable (EPERM) -> true", async () => {
    state.sessions = [{ name: NAME, pid: 1 }];
    registerAgent(1);
    expect(await isAlive(CWD)).toBe(true);
  });
});

describe("launch never spawns beside a live same-named session", () => {
  const opts = { scriptsPath: "/nonexistent" };

  test("rowless + live -> no launch, no stop", async () => {
    state.sessions = [{ name: NAME, pid: await deadPid() }, { name: NAME, pid: process.pid }];
    await launch(CWD, opts);
    expect(state.launched).toBe(0);
    expect(state.stopped).toBe(0);
  });

  test("row + live + unhealthy + stop that MISSES -> refuses to launch (the duplicate path)", async () => {
    state.sessions = [{ name: NAME, pid: await deadPid() }, { name: NAME, pid: process.pid }];
    registerAgent(await deadPid());
    await launch(CWD, opts);
    expect(state.stopped).toBe(1);
    expect(state.launched).toBe(0);
  });

  test("row + live + healthy -> returns, touches nothing", async () => {
    state.sessions = [{ name: NAME, pid: process.pid }];
    registerAgent(process.pid);
    state.pong = true;
    await launch(CWD, opts);
    expect(state.stopped + state.launched).toBe(0);
  });

  // ★ ACCEPT PATHS -- a gate that only refuses is a wall, and a dead sidecar must still come back.
  test("row + ONLY dead sockets -> stale row deleted, sidecar launched", async () => {
    state.sessions = [{ name: NAME, pid: await deadPid() }];
    registerAgent(await deadPid());
    await launch(CWD, opts);
    expect(state.deleted).toBe(1);
    expect(state.launched).toBe(1);
  });

  test("no row + no session -> launched", async () => {
    await launch(CWD, opts);
    expect(state.launched).toBe(1);
  });
});
