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
import { sessionCompacted } from './hooks/session-compacted.js';
import { sessionIdle } from './hooks/session-idle.js';
import { tlDataDir, tlSafeSid } from './lib.js';

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

    it('experimental.chat.system.transform injects the queued context block exactly once', async () => {
      const hooks = await pluginFn(ctx);
      const sessionID = 'e2e-transform';

      await hooks.event!({ event: sessionCreatedEvent(sessionID) as any });

      const output1 = { system: [] as string[] };
      await hooks['experimental.chat.system.transform']!(
        { sessionID, model: {} as any },
        output1,
      );
      assert.equal(output1.system.length, 1, 'first transform call should inject the block');
      assert.ok(output1.system[0].includes('throughline'));

      const output2 = { system: [] as string[] };
      await hooks['experimental.chat.system.transform']!(
        { sessionID, model: {} as any },
        output2,
      );
      assert.equal(output2.system.length, 0, 'second call for the same session should inject nothing');
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

    it('tool.execute.after does NOT capture Claude Code-style PascalCase tool names', async () => {
      const hooks = await pluginFn(ctx);
      const sessionID = 'e2e-tool-pascal';

      // Regression guard: OpenCode never sends "Bash" — only "bash". If this
      // starts writing a line again, the tool-id casing regressed.
      await hooks['tool.execute.after']!(
        { tool: 'Bash', sessionID, callID: 'c1', args: { command: 'echo hi' } } as any,
        toolOutput() as any,
      );

      assert.ok(!existsSync(bufferPath(sessionID)), 'PascalCase tool id should not be captured');
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
});
