/**
 * throughline — shared helpers for OpenCode plugin hooks.
 *
 * The plugin is a thin bridge (issue #179): each OpenCode event becomes a
 * Claude-shaped JSON payload on the stdin of one of the shared hooks/*.sh
 * scripts, copied into this package at build time (scripts/copy-hooks.mjs).
 * Capture, redaction, data-dir resolution and the session-start block all
 * live in those scripts, the same ones Claude Code, Codex, OMP and Hermes
 * run, so there is no second implementation here to drift.
 */

import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// --- Types ---

export interface ThroughlineContext {
  directory: string; // project root (working tree)
  worktree?: string; // workspace root
}

// --- Paths ---

/** Package root: dist/.. in the built package, which holds hooks/ and package.json. */
export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS_DIR = join(PLUGIN_ROOT, "hooks");

// --- Kill switch ---

/**
 * Machine-wide kill switch: THROUGHLINE_DISABLE set to anything but "0"
 * turns every hook into a no-op. The scripts check it too; checking here
 * as well skips the spawn.
 */
export function tlDisabled(): boolean {
  const val = process.env.THROUGHLINE_DISABLE;
  return val !== undefined && val !== "0" && val !== "";
}

// --- Running a hook script ---

const HOOK_TIMEOUT_MS = 5000;

/**
 * Run hooks/<script> with `payload` as JSON on stdin; resolve with its stdout.
 *
 * Never rejects: hooks/*.sh exit 0 by contract, and a spawn failure, timeout
 * or non-zero exit resolves with whatever stdout there was (usually empty),
 * so a broken install degrades to "nothing captured" instead of breaking the
 * OpenCode session.
 */
export function runHook(
  ctx: ThroughlineContext,
  script: string,
  payload: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(
        "sh",
        [join(HOOKS_DIR, script)],
        {
          cwd: ctx.directory,
          env: {
            ...process.env,
            CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
            CLAUDE_PROJECT_DIR: ctx.directory,
            ...extraEnv,
          },
          timeout: HOOK_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        },
        (_error, stdout) => resolve(typeof stdout === "string" ? stdout : ""),
      );
    } catch {
      resolve("");
      return;
    }
    // A script whose guard clause exits before reading stdin (inactive,
    // disabled, no jq) closes the pipe under the pending write. Without a
    // listener that EPIPE is an uncaught 'error' event that kills the host.
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(payload));
  });
}

// --- Per-session ordering ---

/**
 * Capture is enqueued without being awaited (a hook spawn costs tens of ms,
 * and OpenCode awaits plugin hooks on its own hot path), but records for one
 * session must still land in order, and before that session's compaction
 * boundary or idle stamp. One promise chain per session gives both.
 */
const queues = new Map<string, Promise<unknown>>();

export function enqueue(sessionID: string, job: () => Promise<unknown>): Promise<void> {
  const prev = queues.get(sessionID) ?? Promise.resolve();
  const next = prev.then(job).then(
    () => undefined,
    () => undefined,
  );
  queues.set(sessionID, next);
  // Drop the entry once this tail settles, unless a later job extended it.
  void next.then(() => {
    if (queues.get(sessionID) === next) queues.delete(sessionID);
  });
  return next;
}

/** Wait for every job already queued for this session. */
export function drain(sessionID: string): Promise<void> {
  return (queues.get(sessionID) ?? Promise.resolve()).then(() => undefined);
}
