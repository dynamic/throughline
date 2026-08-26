/**
 * throughline — session-created hook (maps to SessionStart).
 *
 * Injects a context block at session start: a pointer to HANDOFF.md plus
 * live git state. This automates the cheap half of orientation.
 *
 * Note: OpenCode's session.created hook doesn't inject text into context
 * like Claude Code's SessionStart does. Instead, we log a message that
 * the agent can read, or we could use experimental.chat.system.transform
 * to inject into the system prompt. For now, we'll just ensure the data
 * dir exists and log a message.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  type ThroughlineContext,
  tlDisabled,
  tlDataRoot,
  tlDataDir,
  tlActive,
  tlDataExists,
  tlSafeSid,
  tlCanonicalize,
  tlErr,
} from "../lib.js";

// Note: Unlike the shell version, this TypeScript port does NOT require jq.
// JSON parsing is native in TypeScript, so the shell's jq-availability check
// and warning are not applicable here.

interface SessionCreatedInput {
  sessionID: string;
}

// Mirrors session-onboard.sh's `git status -s | head -20` — bounded so a
// dirty tree with hundreds of changes doesn't blow up the injected block.
const GIT_STATUS_MAX_LINES = 20;

/**
 * Get live git state (branch, status). Status is capped at
 * GIT_STATUS_MAX_LINES lines, matching the shell hook.
 */
function getGitState(root: string): { branch: string; status: string } | null {
  try {
    const branch = execSync(`git -C "${root}" rev-parse --abbrev-ref HEAD`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const status = execSync(`git -C "${root}" status -s`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const statusLines = status.split("\n").filter((l) => l !== "");
    const boundedStatus = statusLines.slice(0, GIT_STATUS_MAX_LINES).join("\n");

    return { branch, status: boundedStatus };
  } catch {
    return null;
  }
}

/**
 * Whether `targetPath` is covered by a .gitignore rule, as seen from `root`.
 * `git check-ignore -q` itself: exit 0 = ignored, exit 1 = genuinely not
 * ignored, anything else (e.g. a THROUGHLINE_DATA_DIR pointed outside
 * root's own repo — check-ignore exits fatally rather than "not ignored"
 * for a path outside the tree it's asked about) is unanswerable. The shell
 * hook avoids ever hitting that fatal case via an outer path-prefix guard
 * (only calling check-ignore when $data is under $droot) rather than
 * branching on the exit code itself; this port makes the same case
 * explicit here instead, so "unanswerable" is never conflated with "not
 * ignored" — the caller must NOT treat "unknown" as "not ignored," or every
 * session on that config prints an unsatisfiable warning forever.
 */
function isGitIgnored(root: string, targetPath: string): "ignored" | "not-ignored" | "unknown" {
  try {
    execSync(`git -C "${root}" check-ignore -q "${targetPath}"`, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    return "ignored"; // exit 0
  } catch (err) {
    const status = (err as { status?: number }).status;
    return status === 1 ? "not-ignored" : "unknown";
  }
}

/**
 * Read the running plugin's version from package.json, so a stale installed
 * copy is visible at a glance the same way session-onboard.sh's `## throughline
 * vX.Y.Z` header is (issue #56, P1). package.json sits two directories above
 * this compiled file (dist/hooks/session-created.js -> ../../package.json),
 * mirroring the source layout (src/hooks/session-created.ts -> ../../package.json).
 */
function readPluginVersion(dataDir: string): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "";
  } catch (err) {
    tlErr(dataDir, `readPluginVersion: could not read/parse package.json: ${err}`);
    return "";
  }
}

// Anchors the same "**TYPE**" marker shape session-onboard.sh's awk pass
// looks for, so a prompt-only buffer (only ever a `**prompt**` line) is
// correctly excluded from the unconsumed-buffer count below — there is
// nothing for a later handoff to distill from a buffer with no captured
// action.
const RECORD_MARKER = /^- `[^`]*` \*\*[^*]+\*\*/;
const PROMPT_MARKER = /^- `[^`]*` \*\*prompt\*\*/;
const ENDED_MARKER = /^<!-- session-ended /;

/**
 * Sweep buffer/ for other sessions' unconsumed buffers (issue #56, P2 — port
 * of session-onboard.sh's awk pass). Returns the warning lines to append, or
 * an empty array when there is nothing to report.
 */
function sweepUnconsumedBuffers(bufDir: string, dataRoot: string, dataDir: string, currentSid: string): string[] {
  let files: string[];
  try {
    files = readdirSync(bufDir).filter((f) => f.startsWith("session-") && f.endsWith(".md"));
  } catch {
    return [];
  }

  let ended = 0;
  let unsure = 0;

  for (const f of files) {
    if (currentSid && f === `session-${currentSid}.md`) continue;

    let content: string;
    try {
      content = readFileSync(join(bufDir, f), "utf-8");
    } catch (err) {
      // Unreadable: matches the shell's own fallback (session-onboard.sh's
      // awk pass leaves all three counts at 0 on a read failure, which
      // falls through to the "unsure" bucket, not "nothing to report") —
      // an unreadable buffer might well hold real unconsumed work, so it
      // must not silently vanish from the count the way "prompt-only" does.
      tlErr(dataDir, `sweepUnconsumedBuffers: read failed for buffer/${f}: ${err}`);
      unsure++;
      continue;
    }

    const lines = content.split("\n");
    let total = 0;
    let promptOnly = 0;
    let isEnded = false;
    for (const line of lines) {
      if (RECORD_MARKER.test(line)) {
        total++;
        if (PROMPT_MARKER.test(line)) promptOnly++;
      } else if (ENDED_MARKER.test(line)) {
        isEnded = true;
      }
    }

    if (total > 0 && total === promptOnly) continue; // nothing to distill

    if (isEnded) ended++;
    else unsure++;
  }

  const lines: string[] = [];
  if (ended !== 0) {
    lines.push("");
    lines.push(
      `⚠️ ${ended} unconsumed session buffer(s) in \`${relative(dataRoot, bufDir)}/\` from sessions that ended without being distilled into a handoff. Consider running the handoff to fold them in.`,
    );
  }
  if (unsure !== 0) {
    lines.push("");
    lines.push(
      `ℹ️ ${unsure} other session buffer(s) in \`${relative(dataRoot, bufDir)}/\` with no end-stamp - could be live in another terminal, or could have exited without a clean shutdown. If none are still running, consider running the handoff.`,
    );
  }
  return lines;
}

/**
 * Session created hook implementation.
 */
export async function sessionCreated(
  ctx: ThroughlineContext,
  input: SessionCreatedInput,
): Promise<string | null> {
  if (tlDisabled()) return null;

  const root = ctx.directory;
  const dataRoot = tlDataRoot(ctx);
  const dataDir = tlDataDir(ctx);

  // Check if throughline is active
  const state = tlActive(ctx);
  const dataExists = tlDataExists(ctx);

  if (!dataExists && !state.active) {
    // Distinguish deliberate opt-out from bootstrap failure
    if (state.activeReason === "bootstrap-failed") {
      return `⚠️ throughline could not create its data directory (${relative(dataRoot, dataDir)}) - check permissions/disk space. Capture will not run.`;
    }
    return null;
  }

  const lines: string[] = [];

  // Header. Includes the running plugin's version (issue #56, P1) so a stale
  // installed copy is visible the same way session-onboard.sh's own
  // `## throughline vX.Y.Z` header is.
  const version = readPluginVersion(dataDir);
  lines.push(version ? `## throughline v${version} - project session context` : "## throughline - project session context");
  lines.push("");

  // Worktree sharing note. dataRoot (tlDataRoot()) is ALWAYS canonicalized
  // by lib.ts's computeDataRoot() — matching _lib.sh's tl_data_root(), which
  // canonicalizes on every return path, not just the linked-worktree one.
  // root must be canonicalized here too before comparing: a raw compare
  // against dataRoot false-positives on macOS, where /tmp (and os.tmpdir()'s
  // own /var/folders) resolves through /private/... — confirmed live, an
  // earlier version of this comparison canonicalized only ONE side and
  // wrongly claimed worktree-sharing on every single plain, non-worktree
  // session. root itself stays un-canonicalized everywhere else in this
  // function (it anchors relative()/path use and must match tool input
  // paths exactly) — canonicalization here is scoped to this one comparison.
  const canonicalRoot = tlCanonicalize(root);
  if (dataRoot !== canonicalRoot) {
    lines.push(
      `🔗 throughline data is shared with the main working tree at \`${dataRoot}\` (this is a linked worktree).`,
    );
    lines.push("");
  }

  // Capture errors breadcrumb
  const errPath = join(dataDir, ".capture-errors");
  if (existsSync(errPath)) {
    try {
      const errContent = readFileSync(errPath, "utf-8");
      const errCount = errContent.split("\n").filter((l) => l.trim()).length;
      if (errCount > 0) {
        lines.push(
          `⚠️ ${errCount} capture failure(s) recorded in \`${relative(dataRoot, errPath)}\` - some actions may be missing. Check disk space / permissions.`,
        );
        lines.push("");
      }
    } catch {
      // Ignore read errors
    }
  }

  // HANDOFF.md pointer
  const handoffPath = join(dataDir, "HANDOFF.md");
  if (existsSync(handoffPath)) {
    lines.push(`Durable handoff exists at \`${relative(dataRoot, handoffPath)}\` - read it before starting.`);

    // Extract "Last Updated" line
    try {
      const content = readFileSync(handoffPath, "utf-8");
      const match = content.match(/Last Updated:\s*(.+)/i);
      if (match) {
        lines.push(`Last Updated: ${match[1].trim()}`);
      }
    } catch {
      // Ignore read errors
    }
  } else {
    lines.push("No HANDOFF.md yet for this project. One will be written at the next handoff.");
  }

  // gitignore nudge for buffer/ (issue #56, P4 — port of session-onboard.sh's
  // check). buffer/ can hold raw, only best-effort-redacted command/path
  // text and must always stay untracked, even on a project that has
  // otherwise opted in to tracking HANDOFF.md/logs/. Scoped to buffer/
  // specifically, not the whole data dir — a directory-glob ignore pattern
  // can report the parent as "ignored" via check-ignore even when a file
  // inside it is genuinely trackable, so checking the coarser ancestor as a
  // proxy for the leaf that actually matters is unsound. Only fires when
  // dataDir lives inside dataRoot's own tree (an absolute
  // THROUGHLINE_DATA_DIR pointed elsewhere is a documented, supported
  // configuration this check cannot answer for) and root is actually inside
  // a git work tree.
  const bufDir = join(dataDir, "buffer");
  const rootInGitTree = (() => {
    try {
      execSync(`git -C "${root}" rev-parse --is-inside-work-tree`, { stdio: ["pipe", "pipe", "pipe"] });
      return true;
    } catch {
      return false;
    }
  })();
  // A plain startsWith would treat e.g. "/foo/project-backup" as "inside"
  // "/foo/project" — require the path separator (or exact equality) so only
  // a genuine subdirectory counts.
  if ((dataDir === dataRoot || dataDir.startsWith(dataRoot + sep)) && rootInGitTree) {
    if (isGitIgnored(dataRoot, `${bufDir}/`) === "not-ignored") {
      lines.push("");
      lines.push(
        `⚠️ \`${relative(dataRoot, bufDir)}/\` is not gitignored yet - it can contain raw command/path text (best-effort redacted only) and must stay untracked. throughline is local-only by default - typically the whole data dir should be gitignored, not just this subdir.`,
      );
    }
  }

  // Unconsumed-buffer sweep (issue #56, P2)
  if (existsSync(bufDir)) {
    lines.push(...sweepUnconsumedBuffers(bufDir, dataRoot, dataDir, tlSafeSid(input.sessionID)));
  }

  // Git state (if in worktree)
  const gitState = getGitState(root);
  if (gitState) {
    lines.push("");
    lines.push("### Live git state");
    lines.push("```");
    lines.push(`branch: ${gitState.branch}`);
    if (gitState.status) {
      lines.push(gitState.status);
    }
    lines.push("```");
  }

  return lines.join("\n");
}
