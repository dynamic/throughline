import assert from 'assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Import plugin components
import { ThroughlinePlugin as pluginFn } from './index.js';
import { sessionCreated } from './hooks/session-created.js';
import { chatMessage } from './hooks/chat-message.js';
import { toolExecuteAfter } from './hooks/tool-execute-after.js';
import { sessionCompacted, sessionCompactionRecovery } from './hooks/session-compacted.js';
import { sessionIdle } from './hooks/session-idle.js';
import { tlDataDir, tlDisabled, tlSafeSid } from './lib.js';

// The suite controls its own environment: an ambient THROUGHLINE_DISABLE in the
// calling shell (exported by a harness running CI locally) makes tlDisabled()
// true for every hook, so all capture assertions fail with nothing wrong in the
// code — a red check whose cause is invisible gets attributed to the change under
// test. Clear it at module load, before any hook runs. Case 12m of tests/run.sh still
// covers the kill switch for the shell hooks; the TypeScript copy in lib.ts is
// asserted directly by the 'tlDisabled kill switch' block below (dynamic/throughline#126),
// which saves and restores the variable around every case.
delete process.env.THROUGHLINE_DISABLE;

// --- Real-shaped fixture builders --------------------------------------
//
// These mirror what @opencode-ai/sdk's generated types (and the OpenCode
// docs' own event examples) actually put on the wire — NOT what would be
// convenient for the hook code to consume. A fixture shaped to match the
// hook's assumptions instead of the SDK's real payload is exactly how the
// original event-unwrapping and UserMessage.parts bugs shipped past this
// suite: the fixtures were wrong in the same way the code was, so nothing
// caught the mismatch. See dynamic/throughline#41 review notes.

function sessionCreatedEvent(sessionID: string) {
  return {
    type: 'session.created' as const,
    properties: { info: { id: sessionID } as any },
  };
}

function sessionIdleEvent(sessionID: string) {
  return { type: 'session.idle' as const, properties: { sessionID } };
}

function sessionCompactedEvent(sessionID: string) {
  return { type: 'session.compacted' as const, properties: { sessionID } };
}

// UserMessage (packages/sdk/dist/gen/types.gen.d.ts) has NO `parts` field —
// only `output.parts` (the sibling array) carries message content.
function userMessageOutput(text: string) {
  return {
    message: { role: 'user' as const, sessionID: 'x', id: 'm1' } as any,
    parts: [{ type: 'text' as const, text, id: 'p1', sessionID: 'x', messageID: 'm1' }] as any,
  };
}

function assistantMessageOutput(text: string) {
  return {
    message: { role: 'assistant' as const, sessionID: 'x', id: 'm1' } as any,
    parts: [{ type: 'text' as const, text, id: 'p1', sessionID: 'x', messageID: 'm1' }] as any,
  };
}

function toolOutput(overrides: Partial<{ title: string; output: string; metadata: any }> = {}) {
  return { title: 'ok', output: 'ok', metadata: {}, ...overrides };
}

describe('Throughline Plugin Integration Tests', () => {
  let tempDir: string;
  let ctx: any;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'throughline-test-'));
    ctx = { directory: tempDir, worktree: tempDir };

    try {
      execSync('git init', { cwd: tempDir, stdio: 'pipe' });
      execSync('git config user.name "Test User"', { cwd: tempDir, stdio: 'pipe' });
      execSync('git config user.email "test@example.com"', { cwd: tempDir, stdio: 'pipe' });
    } catch {
      // git not available — tests that need it check independently
    }
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  /** Path to a session's buffer file, derived the same way the plugin derives it. */
  function bufferPath(sessionID: string): string {
    return join(tlDataDir(ctx), 'buffer', `session-${tlSafeSid(sessionID)}.md`);
  }

  function readBuffer(sessionID: string): string {
    const path = bufferPath(sessionID);
    assert.ok(existsSync(path), `expected buffer file to exist: ${path}`);
    return readFileSync(path, 'utf-8');
  }

  describe('Plugin Loading', () => {
    it('should load the plugin and expose the expected hooks', async () => {
      const hooks = await pluginFn(ctx);
      assert.ok(hooks);
      assert.equal(typeof hooks['chat.message'], 'function');
      assert.equal(typeof hooks['tool.execute.after'], 'function');
      assert.equal(typeof hooks['experimental.chat.system.transform'], 'function');
      assert.equal(typeof hooks.event, 'function');
    });
  });

  // These drive the plugin exactly the way OpenCode itself would: through
  // the hooks object returned by pluginFn(), using SDK-shaped event and
  // hook-input/output objects. This is the regression gate for the
  // event-unwrapping (session.*), UserMessage.parts, and lowercase-tool-id
  // bugs — each only surfaces when exercised through index.ts, not when the
  // inner hook function is called directly with a hand-shaped object.
  describe('End-to-end through the plugin hooks object (real SDK shapes)', () => {
    it('session.created bootstraps the data dir and queues a context block', async () => {
      const hooks = await pluginFn(ctx);
      const sessionID = 'e2e-created';

      await hooks.event!({ event: sessionCreatedEvent(sessionID) as any });

      assert.ok(existsSync(tlDataDir(ctx)), 'data dir should exist after session.created');
    });

    it('experimental.chat.system.transform injects the queued context block on every call until session.idle (issue #56, P0a)', async () => {
      // Regression guard: OpenCode calls this hook MORE THAN ONCE per turn —
      // once for its own small-model title-generation pass, once for the
      // real primary-agent call, both with the identical sessionID and no
      // other field to tell them apart. A delete-on-first-read design let
      // the title call (which fires first) consume and destroy the block
      // before the real, user-facing call ever saw it — confirmed live, this
      // was the actual production bug, not a hypothetical. The fix pushes on
      // every call while an entry is pending and clears only at
      // session.idle, which fires once per turn after both transform calls
      // have already happened.
      const hooks = await pluginFn(ctx);
      const sessionID = 'e2e-transform';

      await hooks.event!({ event: sessionCreatedEvent(sessionID) as any });

      const output1 = { system: [] as string[] };
      await hooks['experimental.chat.system.transform']!(
        { sessionID, model: {} as any },
        output1,
      );
      assert.equal(output1.system.length, 1, 'first transform call (e.g. the title-generation pass) should inject the block');
      assert.ok(output1.system[0].includes('throughline'));

      const output2 = { system: [] as string[] };
      await hooks['experimental.chat.system.transform']!(
        { sessionID, model: {} as any },
        output2,
      );
      assert.equal(output2.system.length, 1, 'second transform call for the SAME turn (the real primary-agent call) must also get the block');
      assert.ok(output2.system[0].includes('throughline'));

      await hooks.event!({ event: sessionIdleEvent(sessionID) as any });

      const output3 = { system: [] as string[] };
      await hooks['experimental.chat.system.transform']!(
        { sessionID, model: {} as any },
        output3,
      );
      assert.equal(output3.system.length, 0, 'after session.idle (turn over), a later transform call should inject nothing');
    });

    it('chat.message captures a real UserMessage/parts payload to the buffer', async () => {
      const hooks = await pluginFn(ctx);
      const sessionID = 'e2e-chat';

      await hooks['chat.message']!(
        { sessionID } as any,
        userMessageOutput('investigate the flaky test') as any,
      );

      const content = readBuffer(sessionID);
      assert.ok(content.includes('**prompt**'));
      assert.ok(content.includes('investigate the flaky test'));
    });

    it('chat.message ignores assistant messages', async () => {
      const hooks = await pluginFn(ctx);
      const sessionID = 'e2e-chat-assistant';

      await hooks['chat.message']!(
        { sessionID } as any,
        assistantMessageOutput('here is my answer') as any,
      );

      assert.ok(!existsSync(bufferPath(sessionID)), 'assistant-only turn should not create a buffer');
    });

    it('tool.execute.after captures OpenCode\'s real lowercase tool ids', async () => {
      const hooks = await pluginFn(ctx);
      const sessionID = 'e2e-tool-bash';

      await hooks['tool.execute.after']!(
        { tool: 'bash', sessionID, callID: 'c1', args: { command: 'echo hi' } } as any,
        toolOutput() as any,
      );

      const content = readBuffer(sessionID);
      assert.ok(content.includes('**bash**'));
      assert.ok(content.includes('echo hi'));
    });

    it('tool.execute.after captures an unrecognized tool id generically, by name only (issue #56, P0b)', async () => {
      // OpenCode never actually sends "Bash" (only "bash") — this uses it as
      // a stand-in for "any tool id this switch doesn't have a specific case
      // for". That used to mean silent drop, gated on the id containing
      // "mcp__"/"__". Confirmed live that OpenCode's real MCP tool ids use a
      // single underscore (e.g. `perplexity-ask_perplexity_ask`), matching
      // neither check, so every MCP call was silently dropped — the "require
      // a specific unmatched-name shape" premise was the bug. The fix
      // captures any unmatched tool by its bare name (except the explicitly
      // noisy read/glob, covered by the test above), zero assumptions about
      // its argument shape.
      const hooks = await pluginFn(ctx);
      const sessionID = 'e2e-tool-unmatched';

      await hooks['tool.execute.after']!(
        { tool: 'Bash', sessionID, callID: 'c1', args: { command: 'echo hi' } } as any,
        toolOutput() as any,
      );

      const content = readBuffer(sessionID);
      assert.ok(content.includes('**Bash**'), 'unmatched tool id should be captured by name only');
    });

    it('session.idle and session.compacted resolve sessionID from event.properties', async () => {
      const hooks = await pluginFn(ctx);
      const sessionID = 'e2e-idle-compact';

      await hooks['tool.execute.after']!(
        { tool: 'bash', sessionID, callID: 'c1', args: { command: 'ls' } } as any,
        toolOutput() as any,
      );

      await hooks.event!({ event: sessionCompactedEvent(sessionID) as any });
      await hooks.event!({ event: sessionIdleEvent(sessionID) as any });

      const content = readBuffer(sessionID);
      assert.ok(content.includes('compaction-boundary'));
      assert.ok(content.includes('session-ended'));
    });

    it('session.compacted queues a recovery block that the NEXT transform call injects (issue #56, P3, full wiring)', async () => {
      const hooks = await pluginFn(ctx);
      const sessionID = 'e2e-compact-recovery';

      // A captured action before the compaction, so there is something for
      // the recovery block to inline.
      await hooks['tool.execute.after']!(
        { tool: 'bash', sessionID, callID: 'c1', args: { command: 'echo before-compaction' } } as any,
        toolOutput() as any,
      );

      await hooks.event!({ event: sessionCompactedEvent(sessionID) as any });

      const output = { system: [] as string[] };
      await hooks['experimental.chat.system.transform']!({ sessionID, model: {} as any }, output);

      assert.equal(output.system.length, 1, 'transform call after compaction should inject the recovery block');
      assert.ok(output.system[0].includes('Context was just compacted'));
      assert.ok(output.system[0].includes('echo before-compaction'));
    });
  });

  describe('Session Created Hook', () => {
    it('creates the data directory and returns null or a string', async () => {
      const result = await sessionCreated(ctx, { sessionID: 'test-session-123' });
      assert.ok(existsSync(tlDataDir(ctx)));
      assert.ok(result === null || typeof result === 'string');
    });

    it('includes a HANDOFF.md pointer when one exists', async () => {
      const dataDir = tlDataDir(ctx);
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'HANDOFF.md'), '# Handoff\nLast Updated: 2026-01-01\n');

      const result = await sessionCreated(ctx, { sessionID: 'test-session-handoff' });
      assert.ok(result, 'expected a context block when HANDOFF.md exists');
      assert.ok(result!.includes('HANDOFF.md'));
      assert.ok(result!.includes('Last Updated: 2026-01-01'));
    });

    it('sanitizes a dangerous session ID without throwing', async () => {
      const dangerousId = 'test<session>/123|dangerous';
      await assert.doesNotReject(() => sessionCreated(ctx, { sessionID: dangerousId }));
      assert.ok(existsSync(tlDataDir(ctx)));
    });

    it('does NOT claim worktree-sharing for a plain, non-worktree project (issue #56, P5)', async () => {
      // Regression guard for the exact bug this PR claims to fix, and the
      // regression that fix's first attempt introduced: tempDir sits under
      // node:os's tmpdir(), which resolves through a symlink on macOS
      // (/var -> /private/var). An early version of the P5 fix canonicalized
      // only ONE side of the dataRoot/root comparison and, as a result,
      // wrongly claimed worktree-sharing on every single plain project on
      // macOS — confirmed live before this test was added. tempDir here is
      // deliberately NOT a git worktree of anything; this must stay silent.
      const result = await sessionCreated(ctx, { sessionID: 'test-session-no-worktree' });
      assert.ok(result, 'expected a context block');
      assert.ok(
        !result!.includes('shared with the main working tree'),
        `plain project must not claim worktree-sharing, got: ${result}`,
      );
    });

    it('DOES claim worktree-sharing for a genuine linked git worktree (issue #56, P5)', async () => {
      // The positive case for the same fix: a REAL `git worktree add`, not a
      // synthetic ctx.worktree mismatch — tlDataRoot() resolves sharing via
      // git itself (see lib.ts computeDataRoot), so only a real linked
      // worktree exercises this path at all.
      execSync('git worktree add ../wt-linked -b wt-linked-branch', { cwd: tempDir, stdio: 'pipe' });
      const linkedDir = join(tempDir, '..', 'wt-linked');
      const linkedCtx = { directory: linkedDir, worktree: linkedDir };

      try {
        const result = await sessionCreated(linkedCtx, { sessionID: 'test-session-linked-worktree' });
        assert.ok(result, 'expected a context block');
        assert.ok(
          result!.includes('shared with the main working tree'),
          `linked worktree must claim sharing, got: ${result}`,
        );
      } finally {
        rmSync(linkedDir, { recursive: true, force: true });
        try {
          execSync('git worktree prune', { cwd: tempDir, stdio: 'pipe' });
        } catch {
          // best-effort cleanup
        }
      }
    });

    it('includes the running plugin version in the header (issue #56, P1)', async () => {
      // Matches session-onboard.sh's `## throughline vX.Y.Z` header, so a
      // stale installed copy is visible the same way on OpenCode.
      const result = await sessionCreated(ctx, { sessionID: 'test-session-version' });
      assert.ok(result, 'expected a context block');
      assert.match(result!, /^## throughline v\d+\.\d+\.\d+ - project session context/);
    });

    it('warns when buffer/ is not gitignored (issue #56, P4)', async () => {
      // tempDir's beforeEach git-inits it with no .gitignore at all — buffer/
      // is genuinely untracked-and-unignored here.
      const result = await sessionCreated(ctx, { sessionID: 'test-session-not-ignored' });
      assert.ok(result, 'expected a context block');
      assert.ok(result!.includes('not gitignored yet'), `expected the gitignore nudge, got: ${result}`);
    });

    it('stays silent when buffer/ IS gitignored (issue #56, P4)', async () => {
      writeFileSync(join(tempDir, '.gitignore'), '.claude/throughline/buffer/\n');
      const result = await sessionCreated(ctx, { sessionID: 'test-session-ignored' });
      assert.ok(result, 'expected a context block');
      assert.ok(!result!.includes('not gitignored yet'), `expected no gitignore nudge, got: ${result}`);
    });

    it('warns about unconsumed session buffers from OTHER sessions, excluding a prompt-only buffer (issue #56, P2)', async () => {
      const dataDir = tlDataDir(ctx);
      const bufDir = join(dataDir, 'buffer');
      mkdirSync(bufDir, { recursive: true });

      // An ended session with a real captured action: should count.
      writeFileSync(
        join(bufDir, 'session-other-ended.md'),
        '- `2026-01-01 00:00:00` **bash** `echo hi`\n\n<!-- session-ended 2026-01-01 00:00:01 (idle) -->\n',
      );
      // A prompt-only buffer: nothing to distill, should NOT count.
      writeFileSync(bufDir + '/session-other-promptonly.md', '- `2026-01-01 00:00:00` **prompt** "hi"\n');
      // The CURRENT session's own buffer: must be excluded from the sweep.
      writeFileSync(
        join(bufDir, 'session-test-session-current.md'),
        '- `2026-01-01 00:00:00` **bash** `echo current`\n',
      );

      const result = await sessionCreated(ctx, { sessionID: 'test-session-current' });
      assert.ok(result, 'expected a context block');
      assert.ok(result!.includes('1 unconsumed session buffer'), `expected exactly 1 unconsumed buffer, got: ${result}`);
      assert.ok(!result!.includes('promptonly'));
    });
  });

  describe('Chat Message Hook (direct call)', () => {
    it('captures a user prompt to the buffer', async () => {
      const sessionID = 'test-session-chat';
      await chatMessage(ctx, { sessionID } as any, userMessageOutput('This is a test user prompt') as any);

      const content = readBuffer(sessionID);
      assert.ok(content.includes('**prompt**'));
      assert.ok(content.includes('test user prompt'));
    });

    it('creates the buffer dir on the very first capture of a session', async () => {
      // Regression guard: chat.message used to skip the mkdir that
      // tool.execute.after does, so a session's opening prompt (always the
      // first capture event) silently vanished.
      const sessionID = 'test-session-first-prompt';
      assert.ok(!existsSync(join(tlDataDir(ctx), 'buffer')), 'buffer dir should not exist yet');

      await chatMessage(ctx, { sessionID } as any, userMessageOutput('first ever message') as any);

      const content = readBuffer(sessionID);
      assert.ok(content.includes('first ever message'));
    });

    it('redacts a recognizable token prefix in user prompts', async () => {
      // redactPrompt() is deliberately structural-only (PEM / auth schemes /
      // known token prefixes) — it does NOT do generic keyword=value
      // matching like redact() does, because that corrupts ordinary prose
      // ("bearer of good news" → "Bearer ***"). A bare "password: secret123"
      // is intentionally NOT masked here; see utils/redaction.ts.
      const sessionID = 'test-session-redact';
      await chatMessage(
        ctx,
        { sessionID } as any,
        userMessageOutput('set the token to ghp_abc123def456ghi789 before you push') as any,
      );

      const content = readBuffer(sessionID);
      assert.ok(!content.includes('ghp_abc123def456ghi789'));
      assert.ok(content.includes('ghp_***'));
    });

    it('does not capture non-user messages', async () => {
      const sessionID = 'test-session-assistant';
      await chatMessage(ctx, { sessionID } as any, assistantMessageOutput('This is an assistant response') as any);

      assert.ok(!existsSync(bufferPath(sessionID)));
    });
  });

  describe('Tool Execute After Hook (direct call, real OpenCode tool ids)', () => {
    it('captures bash tool executions', async () => {
      const sessionID = 'test-session-bash';
      await toolExecuteAfter(
        ctx,
        { tool: 'bash', sessionID, callID: 'call-123', args: { command: 'echo "Hello, World!"' } } as any,
        toolOutput() as any,
      );

      const content = readBuffer(sessionID);
      assert.ok(content.includes('**bash**'));
      assert.ok(content.includes('echo "Hello, World!"'));
    });

    it('captures edit tool executions using filePath', async () => {
      const testFile = join(tempDir, 'test-file.txt');
      writeFileSync(testFile, 'original content');

      const sessionID = 'test-session-edit';
      await toolExecuteAfter(
        ctx,
        { tool: 'edit', sessionID, callID: 'call-456', args: { filePath: testFile } } as any,
        toolOutput() as any,
      );

      const content = readBuffer(sessionID);
      assert.ok(content.includes('**edit**'));
      assert.ok(content.includes('test-file.txt'));
    });

    it('captures grep tool executions', async () => {
      const sessionID = 'test-session-grep';
      await toolExecuteAfter(
        ctx,
        { tool: 'grep', sessionID, callID: 'call-789', args: { pattern: 'hello world', path: '.' } } as any,
        toolOutput() as any,
      );

      const content = readBuffer(sessionID);
      assert.ok(content.includes('**grep**'));
      assert.ok(content.includes('hello world'));
    });

    it('captures webfetch tool executions', async () => {
      const sessionID = 'test-session-webfetch';
      await toolExecuteAfter(
        ctx,
        { tool: 'webfetch', sessionID, callID: 'call-101', args: { url: 'https://example.com' } } as any,
        toolOutput() as any,
      );

      const content = readBuffer(sessionID);
      assert.ok(content.includes('**webfetch**'));
      assert.ok(content.includes('example.com'));
    });

    it('captures websearch tool executions with prose-safe redaction', async () => {
      const sessionID = 'test-session-websearch';
      await toolExecuteAfter(
        ctx,
        { tool: 'websearch', sessionID, callID: 'call-102', args: { query: 'how to fix token refresh bug' } } as any,
        toolOutput() as any,
      );

      const content = readBuffer(sessionID);
      assert.ok(content.includes('**websearch**'));
      // Prose-safe redaction must not mangle a "token" that isn't a secret.
      assert.ok(content.includes('token refresh bug'));
    });

    it('captures task tool executions', async () => {
      const sessionID = 'test-session-task';
      await toolExecuteAfter(
        ctx,
        {
          tool: 'task',
          sessionID,
          callID: 'call-103',
          args: { description: 'audit the redaction rules', subagent_type: 'general-purpose' },
        } as any,
        toolOutput() as any,
      );

      const content = readBuffer(sessionID);
      assert.ok(content.includes('**agent**'));
      assert.ok(content.includes('general-purpose'));
      assert.ok(content.includes('audit the redaction rules'));
    });

    it('does not capture read or glob (deliberately excluded, noisy tools)', async () => {
      const sessionID = 'test-session-noisy';
      await toolExecuteAfter(
        ctx,
        { tool: 'read', sessionID, callID: 'c1', args: { filePath: '/x' } } as any,
        toolOutput() as any,
      );
      await toolExecuteAfter(
        ctx,
        { tool: 'glob', sessionID, callID: 'c2', args: { pattern: '**/*.ts' } } as any,
        toolOutput() as any,
      );

      assert.ok(!existsSync(bufferPath(sessionID)));
    });

    it('captures MCP tools by name only', async () => {
      const sessionID = 'test-session-mcp';
      await toolExecuteAfter(
        ctx,
        { tool: 'mcp__github__create_issue', sessionID, callID: 'c1', args: { title: 'x' } } as any,
        toolOutput() as any,
      );

      const content = readBuffer(sessionID);
      assert.ok(content.includes('**mcp__github__create_issue**'));
    });

    it("captures MCP tools using OpenCode's real single-underscore id convention (issue #56, P0b)", async () => {
      // The `mcp__server__tool` double-underscore form above is Claude
      // Code's convention. OpenCode's own MCP tool ids use a SINGLE
      // underscore between server and tool name — confirmed live as
      // `perplexity-ask_perplexity_ask` when a real websearch call was
      // routed through the perplexity-ask MCP server. This id matched
      // neither the old "mcp__"-prefix nor "__"-substring check, so it was
      // silently dropped in production before this fix.
      const sessionID = 'test-session-mcp-single-underscore';
      await toolExecuteAfter(
        ctx,
        { tool: 'perplexity-ask_perplexity_ask', sessionID, callID: 'c1', args: { messages: [] } } as any,
        toolOutput() as any,
      );

      const content = readBuffer(sessionID);
      assert.ok(content.includes('**perplexity-ask_perplexity_ask**'));
    });

    it('redacts sensitive info in tool args', async () => {
      const sessionID = 'test-session-sensitive';
      await toolExecuteAfter(
        ctx,
        {
          tool: 'bash',
          sessionID,
          callID: 'call-112',
          args: { command: 'curl -H "Authorization: Bearer secret123" https://api.example.com' },
        } as any,
        toolOutput() as any,
      );

      const content = readBuffer(sessionID);
      assert.ok(!content.includes('secret123'));
    });

    it('appends `[failed]` when the tool result reports an error', async () => {
      const sessionID = 'test-session-failed';
      await toolExecuteAfter(
        ctx,
        { tool: 'bash', sessionID, callID: 'c1', args: { command: 'false' } } as any,
        toolOutput({ metadata: { is_error: true } }) as any,
      );

      const content = readBuffer(sessionID);
      assert.ok(content.includes('[failed]'));
    });
  });

  describe('Session Compacted Hook', () => {
    it('stamps a compaction boundary in the buffer', async () => {
      const sessionID = 'test-session-compact';
      await toolExecuteAfter(
        ctx,
        { tool: 'bash', sessionID, callID: 'call-123', args: { command: 'ls' } } as any,
        toolOutput() as any,
      );

      await sessionCompacted(ctx, { sessionID });

      const content = readBuffer(sessionID);
      assert.ok(content.includes('compaction-boundary'));
      assert.ok(content.includes('auto'));
    });

    it('does not duplicate a trailing compaction boundary marker', async () => {
      const sessionID = 'test-session-no-dup';
      const path = bufferPath(sessionID);
      const bufferDir = join(tlDataDir(ctx), 'buffer');
      execSync(`mkdir -p "${bufferDir}"`);
      writeFileSync(
        path,
        '- `x` **bash** `ls`\n<!-- compaction-boundary 2023-01-01 00:00:00 (auto) - actions above predate a context compaction -->\n',
      );

      await sessionCompacted(ctx, { sessionID });

      const content = readFileSync(path, 'utf-8');
      const boundaryCount = (content.match(/compaction-boundary/g) || []).length;
      assert.strictEqual(boundaryCount, 1);
    });

    it('sessionCompactionRecovery inlines the buffer tail (issue #56, P3)', async () => {
      // Port of session-onboard.sh's source=compact branch. OpenCode's
      // session.created does not re-fire after a compaction, so this is the
      // only channel to re-inject anything post-compaction.
      const sessionID = 'test-session-compact-recovery';
      const bufferDir = join(tlDataDir(ctx), 'buffer');
      mkdirSync(bufferDir, { recursive: true });
      writeFileSync(
        join(bufferDir, `session-${tlSafeSid(sessionID)}.md`),
        '- `2026-01-01 00:00:00` **bash** `echo one`\n- `2026-01-01 00:00:01` **bash** `echo two`\n',
      );

      const recovery = await sessionCompactionRecovery(ctx, { sessionID });
      assert.ok(recovery, 'expected a recovery block');
      assert.ok(recovery!.includes('Context was just compacted'));
      assert.ok(recovery!.includes('echo one'));
      assert.ok(recovery!.includes('echo two'));
    });

    it('sessionCompactionRecovery returns null when there is no buffer yet', async () => {
      const recovery = await sessionCompactionRecovery(ctx, { sessionID: 'test-session-no-buffer-yet' });
      assert.strictEqual(recovery, null);
    });
  });

  describe('Session Idle Hook', () => {
    it('stamps a session-ended marker in the buffer', async () => {
      const sessionID = 'test-session-idle';
      await toolExecuteAfter(
        ctx,
        { tool: 'bash', sessionID, callID: 'call-789', args: { command: 'pwd' } } as any,
        toolOutput() as any,
      );

      await sessionIdle(ctx, { sessionID });

      const content = readBuffer(sessionID);
      assert.ok(content.includes('session-ended'));
      assert.ok(content.includes('(idle)'));
    });

    it('replaces a still-trailing marker instead of stacking duplicates (last-wins)', async () => {
      // session.idle fires after EVERY turn in OpenCode, not once at exit —
      // repeated idles with no activity in between must not accumulate markers.
      const sessionID = 'test-session-repeat-idle';
      await toolExecuteAfter(
        ctx,
        { tool: 'bash', sessionID, callID: 'c1', args: { command: 'ls' } } as any,
        toolOutput() as any,
      );

      await sessionIdle(ctx, { sessionID });
      await sessionIdle(ctx, { sessionID });
      await sessionIdle(ctx, { sessionID });

      const content = readBuffer(sessionID);
      const endedCount = (content.match(/session-ended/g) || []).length;
      assert.strictEqual(endedCount, 1, 'repeated idles must not stack markers');
    });

    it('moves the marker to the true end when activity resumes after an idle', async () => {
      const sessionID = 'test-session-resume-after-idle';
      await toolExecuteAfter(
        ctx,
        { tool: 'bash', sessionID, callID: 'c1', args: { command: 'ls' } } as any,
        toolOutput() as any,
      );
      await sessionIdle(ctx, { sessionID });

      // Activity resumes — the buffer picks back up after the marker.
      await toolExecuteAfter(
        ctx,
        { tool: 'bash', sessionID, callID: 'c2', args: { command: 'pwd' } } as any,
        toolOutput() as any,
      );
      await sessionIdle(ctx, { sessionID });

      const content = readBuffer(sessionID);
      const endedCount = (content.match(/session-ended/g) || []).length;
      assert.strictEqual(endedCount, 1, 'still only one marker');

      const lines = content.trim().split('\n');
      assert.ok(
        lines[lines.length - 1].startsWith('<!-- session-ended'),
        'marker must sit at the true end after activity resumes',
      );
      // The second bash line must appear BEFORE the (only) marker.
      const markerIndex = content.indexOf('<!-- session-ended');
      const secondBashIndex = content.indexOf('`pwd`');
      assert.ok(secondBashIndex >= 0 && secondBashIndex < markerIndex);
    });
  });

  describe('Error Handling', () => {
    it('handles an empty session ID without throwing', async () => {
      const invalidInput = { sessionID: '' };
      await assert.doesNotReject(() => sessionCreated(ctx, invalidInput));
      await assert.doesNotReject(() => sessionCompacted(ctx, invalidInput));
      await assert.doesNotReject(() => sessionIdle(ctx, invalidInput));
    });

    it('handles tool execute with no args gracefully', async () => {
      const sessionID = 'test-missing-args';
      await assert.doesNotReject(() =>
        toolExecuteAfter(
          ctx,
          { tool: 'bash', sessionID, callID: 'call-999', args: {} } as any,
          toolOutput() as any,
        ),
      );
      // No command → nothing to capture, but must not throw or write garbage.
      assert.ok(!existsSync(bufferPath(sessionID)));
    });
  });

  describe('tlDisabled kill switch', () => {
    // The plugin's own TypeScript copy of the kill switch is separate code from
    // the shell version covered by case 12m of tests/run.sh, and it gates every
    // hook here. Semantics are "anything except unset, "0" and "" disables":
    // an operator exporting THROUGHLINE_DISABLE=0 means "leave throughline on",
    // so "0" and "" must NOT flip the switch while "1" and any other non-empty
    // value must. Directly asserted so a dropped clause in lib.ts - which would
    // silently disable capture for every operator who exports the variable at
    // all - fails here instead of in the field. See dynamic/throughline#126.
    function withDisable(value: string | undefined, body: () => void): void {
      const prev = process.env.THROUGHLINE_DISABLE;
      if (value === undefined) delete process.env.THROUGHLINE_DISABLE;
      else process.env.THROUGHLINE_DISABLE = value;
      try {
        body();
      } finally {
        // Restore exactly what the module-load clear left: "unset" must be
        // restored with delete, not assigned the string "undefined", or every
        // capture assertion running after this block would see a set variable.
        if (prev === undefined) delete process.env.THROUGHLINE_DISABLE;
        else process.env.THROUGHLINE_DISABLE = prev;
      }
    }

    it('is off when the variable is unset', () => {
      withDisable(undefined, () => assert.strictEqual(tlDisabled(), false));
    });

    it('is off for "0" (an explicit opt-out of the opt-out)', () => {
      withDisable('0', () => assert.strictEqual(tlDisabled(), false));
    });

    it('is off for the empty string (exported with no value)', () => {
      withDisable('', () => assert.strictEqual(tlDisabled(), false));
    });

    it('is on for "1"', () => {
      withDisable('1', () => assert.strictEqual(tlDisabled(), true));
    });

    it('is on for any other non-empty value ("yes")', () => {
      withDisable('yes', () => assert.strictEqual(tlDisabled(), true));
    });

    it('restores the variable to its previous state after each case', () => {
      withDisable('1', () => assert.strictEqual(tlDisabled(), true));
      assert.strictEqual(
        process.env.THROUGHLINE_DISABLE,
        undefined,
        'a leaked THROUGHLINE_DISABLE would disable every later capture assertion',
      );
      assert.strictEqual(tlDisabled(), false);
    });

    it('suppresses sessionCreated on a fresh project: no block, no bootstrapped data dir', async () => {
      const sessionID = 'kill-switch-session';
      const prev = process.env.THROUGHLINE_DISABLE;
      try {
        // Control first: with the switch off the same call DOES bootstrap the
        // data dir, so the assertions below are not vacuously true (an empty
        // data dir would stay empty whatever tlDisabled() returned).
        delete process.env.THROUGHLINE_DISABLE;
        const enabled = await sessionCreated(ctx, { sessionID });
        assert.ok(enabled !== null, 'control: sessionCreated must produce a block when not disabled');
        assert.ok(existsSync(tlDataDir(ctx)), 'control: sessionCreated must bootstrap the data dir');
        rmSync(tlDataDir(ctx), { recursive: true, force: true });

        process.env.THROUGHLINE_DISABLE = '1';
        assert.strictEqual(tlDisabled(), true);
        assert.strictEqual(await sessionCreated(ctx, { sessionID }), null);
        assert.ok(
          !existsSync(tlDataDir(ctx)),
          'disabled plugin must not even create its data directory',
        );
        // No buffer-file assertion here: sessionCreated never writes a buffer,
        // so that check would hold whatever the switch does. The capture path is
        // pinned by the chatMessage case below.
      } finally {
        if (prev === undefined) delete process.env.THROUGHLINE_DISABLE;
        else process.env.THROUGHLINE_DISABLE = prev;
      }
    });

    it('suppresses sessionCreated on an already-active project, where only its own guard can', async () => {
      // The case above deletes the data dir before the disabled call, which
      // leaves it provable by tlActive()'s own "disabled" answer alone (that
      // answer is NOT redundant in general: it is the sole kill switch for
      // chatMessage and toolExecuteAfter, which have no guard of their own - see
      // the chatMessage case below. It is redundant only inside sessionCreated,
      // whose early return fires first): with no data dir,
      // `!dataExists && !state.active` returns null even when sessionCreated's
      // own `if (tlDisabled()) return null` guard is gone. The
      // real kill-switch situation is a project that is already active - data
      // dir present - where that guard is the ONLY thing between the hook and a
      // full onboarding block printed under THROUGHLINE_DISABLE. So bootstrap
      // first, then throw the switch, and assert null.
      const sessionID = 'kill-switch-active';
      const prev = process.env.THROUGHLINE_DISABLE;
      try {
        delete process.env.THROUGHLINE_DISABLE;
        assert.ok(
          (await sessionCreated(ctx, { sessionID })) !== null,
          'control: an active project must get a block while the switch is off',
        );
        assert.ok(existsSync(tlDataDir(ctx)), 'control: the data dir must exist before the switch');

        process.env.THROUGHLINE_DISABLE = '1';
        assert.strictEqual(tlDisabled(), true);
        assert.strictEqual(
          await sessionCreated(ctx, { sessionID }),
          null,
          'sessionCreated must return null on its own guard, not via tlActive()',
        );
      } finally {
        if (prev === undefined) delete process.env.THROUGHLINE_DISABLE;
        else process.env.THROUGHLINE_DISABLE = prev;
      }
    });

    it('suppresses chatMessage capture, whose only guard is tlActive()', async () => {
      // chatMessage and toolExecuteAfter carry no tlDisabled() guard of their
      // own: the `active: false` that tlActive() returns under the switch is
      // their ONLY kill switch. The sessionCreated cases above cannot cover that
      // path (that hook returns earlier, on its own guard), so without this case
      // tlActive()'s disabled check could be deleted and every prompt, tool call
      // and flush would go back to capturing under THROUGHLINE_DISABLE with the
      // whole suite green. Captured here by asserting a real prompt written
      // before the switch stays the only line in the buffer after it.
      const sessionID = 'kill-switch-chat';
      const prev = process.env.THROUGHLINE_DISABLE;
      try {
        delete process.env.THROUGHLINE_DISABLE;
        await chatMessage(
          ctx,
          { sessionID } as any,
          userMessageOutput('prompt captured before the switch') as any,
        );
        const before = readFileSync(bufferPath(sessionID), 'utf-8');
        assert.ok(
          before.includes('prompt captured before the switch'),
          'control: capture must run while the switch is off',
        );

        process.env.THROUGHLINE_DISABLE = '1';
        assert.strictEqual(tlDisabled(), true);
        await chatMessage(
          ctx,
          { sessionID } as any,
          userMessageOutput('prompt written after the switch') as any,
        );

        const after = readFileSync(bufferPath(sessionID), 'utf-8');
        assert.ok(
          !after.includes('prompt written after the switch'),
          'a disabled plugin must capture nothing after the switch is thrown '
            + '(chatMessage has no guard of its own but the disabled answer from tlActive)',
        );
        assert.strictEqual(
          after.split('\n').filter((l) => l.includes('**prompt**')).length,
          1,
          'the buffer must still hold exactly the pre-switch prompt',
        );
      } finally {
        if (prev === undefined) delete process.env.THROUGHLINE_DISABLE;
        else process.env.THROUGHLINE_DISABLE = prev;
      }
    });
  });
});
