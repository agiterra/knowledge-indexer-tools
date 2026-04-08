/**
 * File-based indexing queue.
 *
 * Changed file paths are appended one per line. The sidecar reads and
 * clears the queue after processing.
 */

import { join } from "path";

/** Default queue file location within the vault. */
export function queuePath(cwd: string, vaultDir = ".knowledge"): string {
  return join(cwd, vaultDir, "meta", "index-queue.txt");
}

/** Append a file path to the indexing queue. */
export async function enqueue(
  cwd: string,
  filePath: string,
  vaultDir = ".knowledge",
): Promise<void> {
  const qp = queuePath(cwd, vaultDir);
  const existing = await readQueue(cwd, vaultDir);
  await Bun.write(qp, existing + filePath + "\n");
}

/** Read current queue entries as an array of paths. */
export async function readQueueEntries(
  cwd: string,
  vaultDir = ".knowledge",
): Promise<string[]> {
  const content = await readQueue(cwd, vaultDir);
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Clear the queue. */
export async function clearQueue(
  cwd: string,
  vaultDir = ".knowledge",
): Promise<void> {
  const qp = queuePath(cwd, vaultDir);
  await Bun.write(qp, "");
}

/** Read raw queue content. */
async function readQueue(cwd: string, vaultDir: string): Promise<string> {
  const qp = queuePath(cwd, vaultDir);
  const file = Bun.file(qp);
  if (await file.exists()) {
    return await file.text();
  }
  return "";
}
