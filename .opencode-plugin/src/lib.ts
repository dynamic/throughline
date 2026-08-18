/**
 * throughline — shared helpers for OpenCode plugin hooks.
 *
 * Resolves the data directory where session state lives. Precedence:
 *   1. $THROUGHLINE_DATA_DIR (absolute, or relative to the project root)
 *   2. .claude/throughline/   (default — universal workspace dir)
 *
 * "Project root" is the data root, not necessarily the session's own
 * working tree: in a linked git worktree it resolves to the MAIN working
 * tree by default, so every worktree shares one data dir.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";

// --- Types ---

export interface ThroughlineContext {
  directory: string; // project root (working tree)
  worktree?: string; // workspace root
}

export interface TlState {
  dataRoot: string; // main working tree (for data dir)
  dataDir: string; // resolved data directory
  active: boolean; // whether throughline is active
  activeReason?: "disabled" | "ignored" | "bootstrap-failed";
}

// --- Kill switch ---

/**
 * Machine-wide kill switch: THROUGHLINE_DISABLE set to anything but "0"
 * turns every hook into a no-op.
 */
export function tlDisabled(): boolean {
  const val = process.env.THROUGHLINE_DISABLE;
  return val !== undefined && val !== "0" && val !== "";
}

// --- Path resolution ---

/**
 * Return the project root. In OpenCode, ctx.directory is the working dir.
 */
export function tlRoot(ctx: ThroughlineContext): string {
  return ctx.directory;
}

/**
 * Resolve the data root (main working tree for worktree sharing).
 * Memoized via a module-level cache keyed by ctx.directory — a single
 * plugin instance can field hooks for more than one directory (e.g. a
 * subagent/task run against a different worktree), so an unkeyed cache
 * would leak the first directory's data root onto every other one.
 */
const _dataRootCache = new Map<string, string>();

export function tlDataRoot(ctx: ThroughlineContext): string {
  const key = tlRoot(ctx);
  const cached = _dataRootCache.get(key);
  if (cached !== undefined) return cached;
  const computed = computeDataRoot(ctx);
  _dataRootCache.set(key, computed);
  return computed;
}

function computeDataRoot(ctx: ThroughlineContext): string {
  const wt = tlRoot(ctx);
  const worktreeShared = process.env.THROUGHLINE_WORKTREE_SHARED ?? "1";

  if (worktreeShared === "0" || worktreeShared === "false" || worktreeShared === "no" || worktreeShared === "off") {
    return wt;
  }

  try {
    const gd = execSync(`git -C "${wt}" rev-parse --path-format=absolute --git-dir`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const cd = execSync(`git -C "${wt}" rev-parse --path-format=absolute --git-common-dir`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    // gd == cd means this IS the main worktree
    if (gd === cd) return wt;

    // Confirmed linked worktree. Get main worktree path.
    const wtList = execSync(`git -C "${wt}" worktree list --porcelain`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const match = wtList.match(/^worktree (.+)$/m);
    if (!match) return wt;

    const mainWt = match[1];
    if (!existsSync(mainWt)) return wt;

    // Migration safety: don't strand pre-existing data
    const ownDir = dirUnder(wt);
    const mainDir = dirUnder(mainWt);

    if (ownDir !== mainDir && (existsSync(ownDir) || existsSync(join(ownDir, "HANDOFF.md")))) {
      return wt;
    }

    return mainWt;
  } catch {
    return wt;
  }
}

/**
 * Compute the data dir under a given root.
 */
function dirUnder(root: string): string {
  const envDir = process.env.THROUGHLINE_DATA_DIR;
  if (envDir) {
    return isAbsolute(envDir) ? envDir : join(root, envDir);
  }
  return join(root, ".claude", "throughline");
}

/**
 * Resolve the data directory for this project.
 */
export function tlDataDir(ctx: ThroughlineContext): string {
  const dataRoot = tlDataRoot(ctx);
  return dirUnder(dataRoot);
}

// --- Activation ---

/**
 * Check if a data dir already exists.
 */
export function tlDataExists(ctx: ThroughlineContext): boolean {
  const data = tlDataDir(ctx);
  return existsSync(data) || existsSync(join(data, "HANDOFF.md"));
}

/**
 * Activation decision for this project.
 * Returns { active, reason? } where reason explains why inactive.
 */
export function tlActive(ctx: ThroughlineContext): TlState {
  const dataRoot = tlDataRoot(ctx);
  const dataDir = dirUnder(dataRoot);

  if (tlDisabled()) {
    return { dataRoot, dataDir, active: false, activeReason: "disabled" };
  }

  // Check for .throughlineignore
  if (existsSync(join(dataRoot, ".throughlineignore")) || existsSync(join(tlRoot(ctx), ".throughlineignore"))) {
    return { dataRoot, dataDir, active: false, activeReason: "ignored" };
  }

  // Already active if data exists
  if (tlDataExists(ctx)) {
    return { dataRoot, dataDir, active: true };
  }

  // Auto-activate: bootstrap the data dir
  try {
    mkdirSync(dataDir, { recursive: true });
    return { dataRoot, dataDir, active: true };
  } catch {
    return { dataRoot, dataDir, active: false, activeReason: "bootstrap-failed" };
  }
}

// --- Session ID ---

/**
 * Sanitize a session id for safe use as a filename.
 * Keep only [A-Za-z0-9._-], collapse everything else to '_'.
 */
export function tlSafeSid(sid: string): string {
  if (!sid) return "";
  const sanitized = sid.replace(/[^A-Za-z0-9._-]/g, "_");
  if (sanitized === "" || sanitized === "." || sanitized === "..") return "";
  return sanitized;
}

// --- Timestamps ---

/**
 * Format current timestamp for buffer lines.
 */
export function tlNow(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// --- Buffer operations ---

/**
 * Append one timestamped record line to a session buffer.
 *
 * `bufDir` is the resolved `<dataDir>/buffer` directory; the error
 * breadcrumb on a write failure goes to `<dataDir>/.capture-errors`
 * (dataDir's root, not under buffer/ — see tlErr), so it's derived here
 * rather than threading a separate dataDir param through every caller.
 */
export function tlAppendLine(bufDir: string, sid: string, content: string): void {
  const ts = tlNow();
  const bufPath = join(bufDir, `session-${sid}.md`);
  const line = `- \`${ts}\` ${content}\n`;

  try {
    appendFileSync(bufPath, line, "utf-8");
  } catch (err) {
    tlErr(dirname(bufDir), `write failed for session-${sid}: ${err}`);
  }
}

/**
 * Breadcrumb for swallowed failures. Takes the resolved data dir explicitly
 * — every caller already has it from tlActive()/tlDataDir(), and guessing
 * it from process.cwd() (as this used to) writes the breadcrumb into
 * whatever directory the OpenCode process happened to start in rather than
 * the project's actual data dir, where session-created.ts looks for it.
 */
export function tlErr(dataDir: string, message: string): void {
  try {
    const errPath = join(dataDir, ".capture-errors");
    appendFileSync(errPath, `${tlNow()} ${message}\n`, "utf-8");
  } catch {
    // Silently fail - this is the error reporter itself
  }
}

/**
 * Clean control characters and backticks from a string.
 */
export function tlCleanCtrl(str: string): string {
  return str.replace(/[\x00-\x1F\x7F`]/g, " ");
}
