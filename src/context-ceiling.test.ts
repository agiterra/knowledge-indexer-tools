/**
 * The context ceiling is the only thing that ends a sidecar on a vault written
 * more often than hourly (2026-10-22: Baguette's ran 19h and reached 804k
 * context per turn). Pin both directions: past the ceiling it relaunches, at or
 * under it -- and when the reading is unknown -- it does nothing.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createHash } from "crypto";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const state = { stopped: 0, launched: 0, sessions: [] as { name: string; pid: number }[] };

mock.module("@agiterra/crew-tools", () => ({
  screen: {
    listSessions: async () => state.sessions,
    isAlive: async (name: string) => state.sessions.some((s) => s.name === name),
    sendKeys: async () => {},
    readOutput: async () => "",
    killSession: async (name: string) => {
      state.stopped++;
      state.sessions = state.sessions.filter((s) => s.name !== name);
      return 0;
    },
  },
  createBackend: async () => ({}),
  Orchestrator: class {
    store = { getAgent: () => null, deleteAgentByScreen: () => {} };
    async readAgent() { return ""; }
    async sendToAgent() {}
    async stopAgent() {}
    async launchAgent() {
      state.launched++;
      state.sessions.push({ name: `wire-${ID}`, pid: process.pid });
    }
  },
}));

const { sessionContextTokens, recycleIfOverCeiling } = await import("./sidecar.js");

const CWD = "/tmp/kx-ceiling-project";
const ID = "kx-" + createHash("sha256").update(CWD).digest("hex").slice(0, 8);

function usage(ctx: number): string {
  return JSON.stringify({
    type: "assistant",
    message: { usage: { input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: ctx - 100, output_tokens: 7 } },
  });
}

/** A fake home holding one sidecar session log per entry, oldest first. */
function home(logs: string[][]): string {
  const h = mkdtempSync(join(tmpdir(), "kx-ceiling-"));
  const dir = join(h, ".claude-agents", ID, "projects", "-tmp-kx-ceiling-project");
  mkdirSync(dir, { recursive: true });
  logs.forEach((lines, i) => {
    const f = join(dir, `s${i}.jsonl`);
    writeFileSync(f, lines.join("\n") + "\n");
    const t = 1_700_000_000 + i * 60;
    utimesSync(f, t, t);
  });
  return h;
}

beforeEach(() => {
  state.stopped = 0;
  state.launched = 0;
  state.sessions = [{ name: `wire-${ID}`, pid: process.pid }];
});

describe("sessionContextTokens", () => {
  test("reads the LAST usage record of the NEWEST log", () => {
    const h = home([[usage(900_000)], [usage(20_000), '{"type":"user"}', usage(45_000), '{"type":"system"}']]);
    expect(sessionContextTokens(CWD, h)?.tokens).toBe(45_000);
  });
  test("no log -> null, never 0", () => {
    expect(sessionContextTokens(CWD, mkdtempSync(join(tmpdir(), "kx-empty-")))).toBeNull();
  });
  test("log with no usage record -> null", () => {
    expect(sessionContextTokens(CWD, home([['{"type":"user"}']]))).toBeNull();
  });
  test("a usage record past the 512 KiB tail is still found when it is the last one", () => {
    const pad = '{"type":"user","pad":"' + "x".repeat(1024 * 1024) + '"}';
    expect(sessionContextTokens(CWD, home([[pad, usage(130_000)]]))?.tokens).toBe(130_000);
  });
});

describe("recycleIfOverCeiling", () => {
  test("past the ceiling: stops the live sidecar and launches a fresh one", async () => {
    const got = await recycleIfOverCeiling(CWD, 100_000, home([[usage(804_191)]]));
    expect(got).toBe(804_191);
    expect(state.stopped).toBe(1);
    expect(state.launched).toBe(1);
  });
  test("at the ceiling: does nothing", async () => {
    expect(await recycleIfOverCeiling(CWD, 100_000, home([[usage(100_000)]]))).toBeNull();
    expect(state.stopped + state.launched).toBe(0);
  });
  test("unknown reading: does nothing", async () => {
    expect(await recycleIfOverCeiling(CWD, 100_000, home([['{"type":"user"}']]))).toBeNull();
    expect(state.stopped + state.launched).toBe(0);
  });
});
