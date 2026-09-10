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
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

/** Scriptable stand-ins for the two things isAlive consults. */
const state = {
  agent: null as { id: string; screen_name: string; screen_pid: number | null } | null,
  screenAlive: false,
};

// Installed BEFORE sidecar is imported -- sidecar builds its Orchestrator at
// call time, but the module binding is captured at import.
mock.module("@agiterra/crew-tools", () => ({
  screen: {
    isAlive: async (_name: string) => state.screenAlive,
  },
  createBackend: async () => ({}),
  Orchestrator: class {
    store = { getAgent: (_id: string) => state.agent };
  },
}));

const { isAlive } = await import("./sidecar.js");

const CWD = "/tmp/kx-test-project";

/** A pid that is certainly gone: spawn, wait for exit, reuse its number. */
async function deadPid(): Promise<number> {
  const proc = Bun.spawn(["true"]);
  const pid = proc.pid;
  await proc.exited;
  return pid;
}

function registerAgent(screen_pid: number | null) {
  state.agent = { id: "kx-test", screen_name: "kx-test-screen", screen_pid };
}

describe("isAlive", () => {
  beforeEach(() => {
    state.agent = null;
    state.screenAlive = false;
  });

  test("socket present + recorded pid DEAD -> false (the AGI-75 corpse)", async () => {
    state.screenAlive = true;
    registerAgent(await deadPid());
    expect(await isAlive(CWD)).toBe(false);
  });

  test("socket present + recorded pid ALIVE -> true", async () => {
    state.screenAlive = true;
    registerAgent(process.pid);
    expect(await isAlive(CWD)).toBe(true);
  });

  test("no socket -> false, even with a live pid", async () => {
    state.screenAlive = false;
    registerAgent(process.pid);
    expect(await isAlive(CWD)).toBe(false);
  });

  test("no registry row -> false", async () => {
    state.screenAlive = true;
    state.agent = null;
    expect(await isAlive(CWD)).toBe(false);
  });

  test("socket present + no recorded pid -> false", async () => {
    state.screenAlive = true;
    registerAgent(null);
    expect(await isAlive(CWD)).toBe(false);
  });

  // EPERM is not ESRCH. pid 1 (launchd) exists but refuses our signal as a
  // non-root user; a sidecar under another uid looks exactly the same. Reading
  // that as dead would relaunch a healthy sidecar on every single hook fire.
  // (Running as root the kill simply succeeds -- either way the answer is true.)
  test("socket present + pid alive but unsignalable (EPERM) -> true", async () => {
    state.screenAlive = true;
    registerAgent(1);
    expect(await isAlive(CWD)).toBe(true);
  });
});
