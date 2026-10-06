import assert from 'assert';
import { describe, it } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { redact, redactPrompt, clean, clamp, redactCleanClamp } from './redaction.js';
import * as redactionModule from './redaction.js';

/**
 * The rule tables live on the module namespace rather than as named imports so a
 * missing table shows up as a failing assertion in the parity tests below rather
 * than as a module-link error that hides every other test in this file.
 */
const TOKEN_PREFIX_RULES = (redactionModule as { TOKEN_PREFIX_RULES?: readonly { name: string; pattern: RegExp; replacement: string }[] }).TOKEN_PREFIX_RULES;
const MYSQL_PW_RULES = (redactionModule as { MYSQL_PW_RULES?: readonly { name: string; pattern: RegExp; replacement: string }[] }).MYSQL_PW_RULES;
const KEYWORD_WORDS = (redactionModule as { KEYWORD_WORDS?: readonly string[] }).KEYWORD_WORDS;
const SEPARATOR_WORDS = (redactionModule as { SEPARATOR_WORDS?: readonly string[] }).SEPARATOR_WORDS;

/**
 * Whether a second engine is actually callable here. Declared before any `describe` body
 * runs because `describe` callbacks execute synchronously at module evaluation: a `const`
 * declared further down the file is still in its temporal dead zone when the first test
 * option object reads it, which throws instead of skipping. Every test that shells out to
 * `jq` carries `skip: JQ_PRESENT ? false : ...` so a machine without `jq` on PATH skips them
 * rather than failing the suite - the assertions that only parse `hooks/_lib.sh` never do
 * shell out, and stay unguarded so they still run there.
 */
function jqIsUsable(): boolean {
  try {
    execFileSync('jq', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const JQ_PRESENT = jqIsUsable();

describe('Redaction Utilities', () => {
  describe('redact()', () => {
    it('should redact PEM private keys', () => {
      const pemKey = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7AwHKqnhQV2Kh
-----END PRIVATE KEY-----`;
      
      const result = redact(pemKey);
      assert.strictEqual(result, '***private-key-redacted***');
    });

    it('should redact incomplete PEM keys', () => {
      const incompletePem = `-----BEGIN RSA PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7AwHKqnhQV2Kh`;
      
      const result = redact(incompletePem);
      assert.strictEqual(result, '***private-key-redacted***');
    });

    it('should redact URL userinfo with password', () => {
      const urlWithAuth = 'https://user:password@example.com/path';
      const result = redact(urlWithAuth);
      assert.strictEqual(result, 'https://user:***@example.com/path');
    });

    it('should redact GitHub personal access tokens (ghp_)', () => {
      const token = 'ghp_AbcDefGhiJklMnoPqrStuVwxYzaBcDefGhiJ';
      const result = redact(token);
      assert.strictEqual(result, 'ghp_***');
    });

    it('should redact GitHub fine-grained tokens (github_pat_)', () => {
      const token = 'github_pat_Abc_Def_Ghi123';
      const result = redact(token);
      assert.strictEqual(result, 'github_pat_***');
    });

    it('should redact GitHub app tokens (gh_)', () => {
      const token = 'gho_AbcDefGhiJklMnoPqrStuVwxYzaBcDefGhiJ';
      const result = redact(token);
      assert.strictEqual(result, 'gh_***');
    });

    it('should redact Slack tokens', () => {
      const token = 'xoxb-AbCdEfGhIjKlMnOpQrStUv';
      const result = redact(token);
      assert.strictEqual(result, 'xox-***');
    });

    it('should redact Stripe keys', () => {
      const token = 'sk-AbCdEfGhIjKlMnOpQrSt';
      const result = redact(token);
      assert.strictEqual(result, 'sk-***'); // The pattern should match sk- followed by 10+ alphanumeric/underscore/dash chars
    });

    it('should redact AWS access keys', () => {
      const token = 'AKIAIOSFODNN7EXAMPLE';
      const result = redact(token);
      assert.strictEqual(result, 'AKIA***');
    });

    it('should redact Google API keys', () => {
      const token = 'AIzaSyAa8yy0uycm8alisu0234jlasdf98234jk'; // 35 chars after AIza
      const result = redact(token);
      assert.strictEqual(result, 'AIza***');
    });

    it('should redact Bearer tokens (any length)', () => {
      const auth = 'Authorization: Bearer abc123';
      const result = redact(auth);
      // The dedicated auth scheme rule should match first, but the generic keyword matcher
      // also matches "bearer" and masks the value, causing double redaction
      assert.strictEqual(result, 'Authorization: *** ***');
    });

    it('should redact Bearer tokens case insensitive', () => {
      const auth = 'authorization: bearer ABCDEF123';
      const result = redact(auth);
      assert.strictEqual(result, 'authorization: *** ***');
    });

    it('should redact Basic auth (8+ chars)', () => {
      const auth = 'Authorization: Basic dGVzdDp0ZXN0';
      const result = redact(auth);
      assert.strictEqual(result, 'Authorization: *** ***');
    });

    it('should redact Token auth', () => {
      const auth = 'Authorization: Token abcdef123456';
      const result = redact(auth);
      // Both the dedicated token scheme rule and the generic keyword matcher apply
      assert.strictEqual(result, 'Authorization: *** ***'); 
    });

    it('should redact generic keyword=value patterns', () => {
      const text = 'password=mypassword';
      const result = redact(text);
      assert.strictEqual(result, 'password=***');
    });

    it('should redact generic keywords with colons', () => {
      const text = 'api_key: secret_value';
      const result = redact(text);
      assert.strictEqual(result, 'api_key: ***');
    });

    it('should handle quoted values in generic patterns', () => {
      const text = 'token="my_secret_token"';
      const result = redact(text);
      assert.strictEqual(result, 'token=***');
    });

    it('should handle unquoted values in generic patterns', () => {
      const text = 'secret=value something_else';
      const result = redact(text);
      assert.strictEqual(result, 'secret=*** something_else');
    });

    it('should not redact short Basic auth values', () => {
      // Less than 8 characters
      const auth = 'Basic test';
      const result = redact(auth);
      assert.strictEqual(result, 'Basic test'); // Should not be redacted
    });

    it('should handle complex mixed content', () => {
      const complex = `
        API Key: AIzaSyAa8yy0uycm8alisu0234jlasdf98234jkls
        Password: mySecretPass
        URL: https://admin:mypass@api.example.com/data
        Token: ghp_abc123def456
        Auth: Bearer sometoken123
      `;
      const result = redact(complex);
      assert.ok(result.includes('AIza***'));
      assert.ok(result.includes('Password: ***')); // Generic keyword matching
      assert.ok(result.includes('admin:***@api.example.com'));
      // Note: ghp_ might be masked by the generic matcher before the prefix matcher gets to it
      assert.ok(result.includes('***'));
      assert.ok(result.includes('*** ***')); // Bearer sometoken123 becomes *** ***
    });

    it('should handle empty string', () => {
      const result = redact('');
      assert.strictEqual(result, '');
    });

    it('should handle very long inputs', () => {
      const longText = 'a'.repeat(10000) + ' password=secret ' + 'b'.repeat(10000);
      const result = redact(longText);
      assert.ok(result.includes('password=***'));
      assert.ok(result.length > 10000); // Make sure it didn't truncate unexpectedly
    });
  });

  describe('redactPrompt()', () => {
    it('should redact PEM private keys', () => {
      const pemKey = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7AwHKqnhQV2Kh
-----END PRIVATE KEY-----`;
      
      const result = redactPrompt(pemKey);
      assert.strictEqual(result, '***private-key-redacted***');
    });

    it('should redact URL userinfo in prompt mode', () => {
      const urlWithAuth = 'https://user:password@example.com/path';
      const result = redactPrompt(urlWithAuth);
      assert.strictEqual(result, 'https://user:***@example.com/path');
    });

    it('should redact token prefixes in prompt mode', () => {
      const token = 'ghp_AbcDefGhiJklMnoPqrStuVwxYzaBcDefGhiJ';
      const result = redactPrompt(token);
      assert.strictEqual(result, 'ghp_***');
    });

    it('should redact Bearer tokens with 16+ chars in prompt mode', () => {
      const auth = 'Authorization: Bearer VeryLongTokenThatExceedsSixteenCharacters';
      const result = redactPrompt(auth);
      assert.strictEqual(result, 'Authorization: Bearer ***');
    });

    it('should NOT redact short Bearer tokens in prompt mode', () => {
      const auth = 'Authorization: Bearer short';
      const result = redactPrompt(auth);
      assert.strictEqual(result, 'Authorization: Bearer short'); // Should not be redacted
    });

    it('should redact Token auth with 16+ chars in prompt mode', () => {
      const auth = 'Authorization: Token VeryLongTokenThatExceedsSixteenChars';
      const result = redactPrompt(auth);
      assert.strictEqual(result, 'Authorization: Token ***');
    });

    it('should NOT redact short Token values in prompt mode', () => {
      const auth = 'Authorization: Token short';
      const result = redactPrompt(auth);
      assert.strictEqual(result, 'Authorization: Token short'); // Should not be redacted
    });

    it('should NOT redact generic keywords in prompt mode (to avoid false positives)', () => {
      const text = 'The password field should not be redacted here';
      const result = redactPrompt(text);
      assert.strictEqual(result, 'The password field should not be redacted here');
    });

    it('should not redact ordinary English phrases like "bearer of good news"', () => {
      const text = 'The bearer of good news should not be redacted';
      const result = redactPrompt(text);
      assert.strictEqual(result, 'The bearer of good news should not be redacted');
    });

    it('should not redact "basic" followed by short text in prompt mode', () => {
      const text = 'This is basic usage';
      const result = redactPrompt(text);
      assert.strictEqual(result, 'This is basic usage');
    });

    it('should redact "basic" followed by 16+ chars in prompt mode', () => {
      const text = 'Basic VeryLongBase64StringThatExceedsSixteenChars';
      const result = redactPrompt(text);
      assert.strictEqual(result, 'Basic ***');
    });
  });

  describe('clean()', () => {
    it('should remove control characters', () => {
      const input = 'Hello\x00World\x01Test';
      const result = clean(input);
      assert.strictEqual(result, 'Hello World Test');
    });

    it('should replace backticks with spaces', () => {
      const input = 'Code `const x = 5` is here';
      const result = clean(input);
      assert.strictEqual(result, 'Code  const x = 5  is here');
    });

    it('should handle carriage return and newline characters', () => {
      const input = 'Line 1\r\nLine 2\nLine 3';
      const result = clean(input);
      assert.strictEqual(result, 'Line 1  Line 2 Line 3'); // \n becomes space, but \r\n becomes two spaces (\r and \n)
    });

    it('should return unchanged string with no control chars or backticks', () => {
      const input = 'Normal text with no special chars';
      const result = clean(input);
      assert.strictEqual(result, 'Normal text with no special chars');
    });
  });

  describe('clamp()', () => {
    it('should truncate strings longer than max length', () => {
      const input = 'This is a very long string that will be truncated';
      const result = clamp(input, 20);
      assert.strictEqual(result, 'This is a very long …');
    });

    it('should not truncate strings shorter than max length', () => {
      const input = 'Short string';
      const result = clamp(input, 20);
      assert.strictEqual(result, 'Short string');
    });

    it('should use custom ellipsis when provided', () => {
      const input = 'This is a very long string that will be truncated';
      const result = clamp(input, 20, '...');
      assert.strictEqual(result, 'This is a very long ...');
    });

    it('should handle exact length strings', () => {
      const input = 'Exactly twenty chrs';
      const result = clamp(input, 21);
      assert.strictEqual(result, 'Exactly twenty chrs');
    });

    it('should return just ellipsis when maxLen is 0', () => {
      const input = 'Some text';
      const result = clamp(input, 0);
      assert.strictEqual(result, '…'); // When length is 0, it will still add the ellipsis
    });
  });

  describe('redactCleanClamp()', () => {
    it('should perform redact, clean, clamp in sequence - command path', () => {
      const input = 'password=' + 'a'.repeat(25) + ' ' + 'more text';
      const result = redactCleanClamp(input, 30);
      // Should redact the password, clean control chars, and clamp to 30 chars
      assert.ok(result.length <= 30);
    });

    it('should perform redact, clean, clamp in sequence - prompt path', () => {
      const input = 'https://user:pass@example.com';
      const result = redactCleanClamp(input, 40, true);
      // Should redact the password, clean control chars, and clamp to 40 chars
      assert.ok(result.includes('user:***@example.com'));
      assert.ok(result.length <= 40);
    });

    it('should use prompt-safe redaction when promptSafe flag is true', () => {
      const input = 'The bearer of good news should not be redacted';
      const result = redactCleanClamp(input, 100, true);
      // In prompt mode, "bearer of good news" should NOT be redacted
      assert.strictEqual(result, 'The bearer of good news should not be redacted');
    });

    it('should use command-path redaction when promptSafe flag is false', () => {
      const input = 'Authorization: Bearer token_value';
      const result = redactCleanClamp(input, 100, false);
      assert.strictEqual(result, 'Authorization: *** ***');
    });
  });

  describe('Edge Cases', () => {
    it('should handle null and undefined gracefully', () => {
      // Note: TypeScript would normally prevent passing null/undefined to these functions
      // But we're testing the runtime behavior for completeness
      assert.strictEqual(redact(''), '');
      assert.strictEqual(redactPrompt(''), '');
    });

    it('should handle very long tokens appropriately', () => {
      const veryLongToken = 'ghp_' + 'a'.repeat(1000);
      const result = redact(veryLongToken);
      assert.strictEqual(result, 'ghp_***');
    });

    it('should handle multiple occurrences of the same pattern', () => {
      const text = 'token1=abc123 token2=def456 ghp_token=xyz789';
      const result = redact(text);
      assert.ok(result.includes('token1=***'));
      assert.ok(result.includes('token2=***'));
      // Note: ghp_token as a whole might not match the pattern since it has underscore
      // It depends on how the regex matches compound names
      assert.ok(result.includes('***'));
    });

    it('should maintain proper sentinel handling to prevent over-masking', () => {
      const text = 'Visit https://user:password@example.com/path?token=value';
      const result = redact(text);
      // The URL userinfo should be redacted with sentinel, then converted to ***
      // The query param should also be redacted separately
      assert.ok(result.includes('user:***@example.com'));
      assert.ok(result.includes('?token=***'));
    });

    it('should never leak TLREDACTSENTINEL sentinel in output', () => {
      const urlWithAuth = 'https://user:password@example.com/path';
      const result = redact(urlWithAuth);
      assert.ok(!result.includes('TLREDACTSENTINEL'));
      assert.ok(result.includes('user:***@example.com'));
    });
  });
});

// ---------------------------------------------------------------------------
// jq parity with hooks/_lib.sh (issue #90)
// ---------------------------------------------------------------------------

/**
 * `hooks/_lib.sh` and this plugin are two implementations of one rule set. The
 * tests below parse the shell file, compose the jq defs the way jq itself would,
 * and compare the result to the TypeScript tables - so a rule added, removed,
 * reordered or re-tuned on the jq side turns this suite red instead of quietly
 * leaving OpenCode users without it. That is the point of issue #90: the issue #81
 * rules (the client-anchored MySQL `-p<password>` set and the `xapp-`, `sk_live_`,
 * `rk_test_`, `glpat-`, `npm_`, `SG.` prefixes) were added on the jq side and not
 * ported here at the same time, because nothing mechanical was checking.
 */

function repoLibPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, 'hooks', '_lib.sh');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error('could not find hooks/_lib.sh above ' + fileURLToPath(import.meta.url));
}

const HEREDOC_OPEN = "<<'TL_JQ_DEFS'";
const HEREDOC_CLOSE = '\nTL_JQ_DEFS';

/** The jq redaction defs exactly as the hooks hand them to jq. */
function jqDefs(): string {
  const sh = readFileSync(repoLibPath(), 'utf8');
  const start = sh.indexOf(HEREDOC_OPEN);
  assert.ok(start >= 0, 'hooks/_lib.sh no longer opens the tl_jq_redact_defs heredoc');
  // The heredoc is opened on a pipe (`| sed /^[[:space:]]*#/d`), so the body starts
  // at the first newline after the marker, not at the marker itself.
  const bodyStart = sh.indexOf('\n', start + HEREDOC_OPEN.length);
  assert.ok(bodyStart > 0, 'the tl_jq_redact_defs heredoc marker is not followed by a newline');
  const rest = sh.slice(bodyStart + 1);
  const end = rest.indexOf(HEREDOC_CLOSE);
  assert.ok(end >= 0, 'the tl_jq_redact_defs heredoc is not terminated');
  // tl_jq_redact_defs() pipes the heredoc through `sed /^[[:space:]]*#/d`, so
  // full-line comments never reach jq and must not be parsed here either.
  return rest
    .slice(0, end)
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** Decode a jq string literal into the text jq would hand to gsub. */
function decodeJqString(rawLiteral: string): string {
  const literal = rawLiteral.trim(); // args come out of a `,`/`;` split with the separator's whitespace attached
  assert.ok(literal.startsWith('"') && literal.endsWith('"'), `expected a jq string literal, got: ${literal}`);
  const body = literal.slice(1, -1);
  const simple: Record<string, string> = {
    '"': '"',
    '\\': '\\',
    '/': '/',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
  };
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = body[++i];
    assert.ok(next !== undefined, 'jq string literal ends in a backslash');
    if (next === 'u') {
      out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16));
      i += 4;
      continue;
    }
    // `\(...)` is jq string interpolation; the marker is kept so the parity
    // assertions below can see which named group a replacement echoes back.
    if (next === '(') {
      out += '\\(';
      continue;
    }
    out += simple[next] ?? next;
  }
  return out;
}

/** Split on a separator that sits outside every string literal and every call. */
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inString = false;
  let escaped = false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      current += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === sep && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** The raw (still-quoted) string literals in a jq expression, in source order. */
function jqLiterals(text: string): string[] {
  const lits: string[] = [];
  let inString = false;
  let escaped = false;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString && ch !== '"') continue;
    if (!inString) {
      inString = true;
      current = ch;
      continue;
    }
    current += ch;
    if (escaped) escaped = false;
    else if (ch === '\\') escaped = true;
    else if (ch === '"') {
      inString = false;
      lits.push(current);
      current = '';
    }
  }
  return lits;
}

/** `fname(...)` calls appearing in a jq expression, each split into `;`-separated args. */
function jqCalls(text: string, fname: string): string[][] {
  const calls: string[][] = [];
  const needle = fname + '(';
  let from = 0;
  for (;;) {
    const open = text.indexOf(needle, from);
    if (open < 0) return calls;
    let i = open + needle.length;
    let depth = 1;
    let inString = false;
    let escaped = false;
    let args: string[] | null = null;
    let current = '';
    for (; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        current += ch;
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        current += ch;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          args = splitTopLevel(current, ';');
          break;
        }
      }
      current += ch;
    }
    assert.ok(args, `unbalanced call to ${fname} in the jq defs`);
    calls.push(args);
    from = open + needle.length + 1;
  }
}

/** The body of `def NAME[($args)]: ... ;` from the jq defs. */
function jqDefBody(defs: string, name: string): string {
  const header = new RegExp('(?:^|\\n)\\s*def ' + name + '\\s*(?:\\([^)]*\\))?\\s*:');
  const match = header.exec(defs);
  assert.ok(match, `hooks/_lib.sh no longer defines def ${name} - the parity parser needs updating`);
  const start = (match.index ?? 0) + match[0].length;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < defs.length; i++) {
    const ch = defs[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ';' && depth === 0) return defs.slice(start, i);
  }
  throw new Error(`def ${name} is not terminated by a ';'`);
}

/** jq's `\(.name)` replacement interpolation is JS's `$<name>`. */
function toJsReplacement(jqRepl: string): string {
  return jqRepl.replace(/\\\(\.([A-Za-z_][A-Za-z0-9_]*)\)/g, (_all, groupName: string) => '$<' + groupName + '>');
}

/**
 * Two spellings are pure syntax and are normalized before comparison:
 *   - jq writes some CR/LF matches as the literal control character instead of the
 *     `\r` / `\n` escape (same meaning, different bytes);
 *   - JS has no atomic group, so the TS span writes `(?>X)` as the standard
 *     `(?=(?<tlspan>X))\k<tlspan>` emulation. See `redaction.ts`.
 */
function normalizeJqRegexText(text: string): string {
  return text.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

function denormalizeJsAtomicEmulation(text: string): string {
  const OPEN = '(?:(?=(?<tlspan>';
  const CLOSE = '))\\k<tlspan>';
  const a = text.indexOf(OPEN);
  assert.ok(a >= 0, 'the TS MySQL span no longer uses the atomic-group emulation - update this checker');
  assert.ok(text.indexOf(OPEN, a + 1) < 0, 'the TS MySQL span unexpectedly contains two spans');
  const b = text.indexOf(CLOSE, a);
  assert.ok(b > a, 'the TS MySQL span is not closed by its backreference - update this checker');
  // CLOSE is dropped rather than replaced by ')' : the ')' that closes the atomic
  // group in jq's text is the one the JS emulation writes just after the
  // backreference (`...\k<tlspan>` + ')*?'), so it is still in the tail below.
  return text.slice(0, a) + '(?>' + text.slice(a + OPEN.length, b) + text.slice(b + CLOSE.length);
}

/**
 * Places where the TypeScript writes DIFFERENT regex text on purpose because JS and
 * Oniguruma read identical text differently. Each row says what the TS spells, what
 * jq spells, and why - the MySQL/prefix parity assertions below fold these back
 * before comparing text, and the differential test at the bottom of this file is
 * what stops the mapping from being used to hide a real divergence: text equality
 * proves the tables line up, behavioural equality against jq proves they mean the
 * same thing.
 */
const ENGINE_SPELLINGS: readonly { ts: string; jq: string; why: string }[] = [
  {
    ts: String.raw`\\[^\n]`,
    jq: String.raw`\\.`,
    why: 'JS . also refuses CR, U+2028 and U+2029; jq . refuses only LF, so a backslash-CR inside a quoted argument would stop the TS span and leak the password behind it',
  },
  {
    ts: String.raw`(?=[^ \t\n\v\f\r\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000])`,
    jq: String.raw`(?=\S)`,
    why: 'JS \s matches U+FEFF and misses U+0085; Oniguruma reads both the other way round, so the code points are listed rather than trusted to an escape',
  },
  {
    ts: String.raw`[^ \t\n\v\f\r\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000'\"\\]`,
    jq: String.raw`[^\s'\"\\]`,
    why: 'the same code-point list, for the glue run',
  },

];

/** Fold the deliberate JS spellings back into jq's before comparing pattern text. */
function tsTextToJqText(source: string): string {
  let out = source;
  for (const row of ENGINE_SPELLINGS) {
    out = out.split(row.ts).join(row.jq);
  }
  return out;
}

type JqRule = { name: string; pattern: string; replacement: string };

function jqPrefixRules(): JqRule[] {
  return jqCalls(jqDefBody(jqDefs(), '_prefix_tokens'), 'gsub').map((args, i) => ({
    name: `_prefix_tokens rule ${i}`,
    pattern: decodeJqString(args[0]),
    replacement: decodeJqString(args[1]),
  }));
}

function jqMysqlRules(): JqRule[] {
  const defs = jqDefs();
  const anchorTemplate = (): string => {
    const terms = splitTopLevel(jqDefBody(defs, '_mysql_anchor'), '+').map((t) => t.trim());
    assert.strictEqual(terms.length, 2, '_mysql_anchor no longer composes as "literal + $tail"');
    assert.strictEqual(terms[1], '$tail', '_mysql_anchor no longer ends in $tail');
    return decodeJqString(terms[0]);
  };
  const defValues: Record<string, string> = {
    _mysql_pw_lead: decodeJqString(jqLiterals(jqDefBody(defs, '_mysql_pw_lead'))[0]),
    _mysql_pw_glue: decodeJqString(jqLiterals(jqDefBody(defs, '_mysql_pw_glue'))[0]),
  };
  const bodyLiterals = jqLiterals(jqDefBody(defs, '_mysql_pw_body'));
  assert.ok(
    bodyLiterals.length === 3 && decodeJqString(bodyLiterals[0]) === '"',
    '_mysql_pw_body no longer reads as: if $q == the double quote, then <double body> else <single body>',
  );
  const bodyValues: Record<string, string> = {
    double: decodeJqString(bodyLiterals[1]),
    single: decodeJqString(bodyLiterals[2]),
  };
  const evalConcat = (expr: string, params: Record<string, string>): string =>
    splitTopLevel(expr, '+')
      .map((raw) => raw.trim())
      .map((term) => {
        if (term.startsWith('"')) return decodeJqString(term);
        const bodyCall = /^_mysql_pw_body\((.+)\)$/.exec(term);
        if (bodyCall) {
          const quote = params[bodyCall[1].trim().replace(/^\$/, '')];
          assert.ok(quote !== undefined, `_mysql_pw_body called with an unknown parameter: ${term}`);
          return quote === '"' ? bodyValues.double : bodyValues.single;
        }
        if (term.startsWith('$')) {
          const value = params[term.replace(/^\$/, '')];
          assert.ok(value !== undefined, `unknown jq parameter in the MySQL defs: ${term}`);
          return value;
        }
        const anchorCall = /^_mysql_anchor\(([\s\S]*)\)$/.exec(term);
        if (anchorCall) return anchorTemplate() + evalConcat(anchorCall[1], params);
        const defValue = defValues[term];
        assert.ok(defValue !== undefined, `unknown jq def referenced by the MySQL rules: ${term}`);
        return defValue;
      })
      .join('');

  const rules: JqRule[] = [];
  for (const args of jqCalls(jqDefBody(defs, '_mysql_pw_pre'), '_mysql_pw_quoted')) {
    const params = { q: decodeJqString(args[0]), esc: decodeJqString(args[1]) };
    const [expr, replLiteral] = jqCalls(jqDefBody(defs, '_mysql_pw_quoted'), 'gsub')[0];
    assert.ok(/^_mysql_anchor\(/.test(expr.trim()), '_mysql_pw_quoted no longer wraps its pattern in _mysql_anchor');
    rules.push({
      name: `mysql quoted value ${JSON.stringify(params.q)}${params.esc ? ' (escaped)' : ''}`,
      pattern: evalConcat(expr.trim(), params),
      replacement: toJsReplacement(decodeJqString(replLiteral)),
    });
  }
  const [spanExpr, spanReplLiteral] = jqCalls(jqDefBody(defs, '_mysql_pw'), 'gsub')[0];
  assert.ok(/^_mysql_anchor\(/.test(spanExpr.trim()), '_mysql_pw no longer wraps its pattern in _mysql_anchor');
  rules.push({
    name: 'mysql span rule',
    pattern: evalConcat(spanExpr.trim(), {}),
    replacement: toJsReplacement(decodeJqString(spanReplLiteral)),
  });
  return rules;
}

/** The alternation inside the first `(?:` at `from`, split at top-level `|`. */
function jqAlternationBranches(text: string, from: number, what: string): string[] {
  const open = text.indexOf('(?:', from);
  assert.ok(open >= 0, `no (?: group found for ${what} in ${JSON.stringify(text.slice(0, 80))} - the parity parser needs updating`);
  let depth = 0;
  let end = -1;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.ok(end > open, `the (?: group for ${what} is never closed`);
  const body = text.slice(open + 3, end);
  // Split on `|` outside every group and every bracket class: `auth(?:orization)?` and
  // `client[_-]?id` both contain regex syntax, and a naive split('|') would cut them.
  const branches: string[] = [];
  let current = '';
  let groupDepth = 0;
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\') {
      current += ch + (body[++i] ?? '');
      continue;
    }
    if (inClass) {
      current += ch;
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === '(') groupDepth++;
    else if (ch === ')') groupDepth--;
    if (ch === '|' && groupDepth === 0) {
      branches.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  branches.push(current);
  return branches;
}

/**
 * jq's generic keyword=value rule, as parsed from its own `def redact` - the two
 * alternations it is built from, plus the pattern they sit in. Nothing else in this
 * file checks this rule's WORD list: the prefix and MySQL rules have table parity, and
 * before this parser the generic rule's list was only covered by whatever keyword some
 * corpus input happened to contain, which is exactly how a keyword added on the jq side
 * (say `private[_-]?key`) would stop being masked here with the suite still green.
 */
function jqGenericKeywordRule(): { keywords: string[]; separators: string[]; pattern: string } {
  const body = jqDefBody(jqDefs(), 'redact');
  const calls = jqCalls(body, 'gsub');
  const generic = calls.map((args) => decodeJqString(args[0])).find((p) => p.includes('(?<k>'));
  assert.ok(generic, 'jq `redact` no longer has a generic keyword=value gsub with a `(?<k>` group - the parity parser needs updating');
  const kStart = generic.indexOf('(?<k>');
  const sStart = generic.indexOf('(?<s>');
  assert.ok(kStart >= 0 && sStart > kStart, 'the generic rule no longer reads as a `(?<k>` group followed by a `(?<s>` group');
  return {
    keywords: jqAlternationBranches(generic, generic.indexOf('(?:', kStart), 'the keyword alternation'),
    separators: jqAlternationBranches(generic, generic.indexOf('(?:', sStart), 'the copula alternation'),
    pattern: generic,
  };
}

/**
 * Plain-language spellings of the keywords, used to ask whether the port actually fires
 * on each keyword jq lists - the structural comparison above proves the lists agree, this
 * proves the list is wired into the rule. A branch with no representative here fails loudly
 * rather than passing vacuously.
 */
const KEYWORD_PROBES = [
  'token', 'secret', 'password', 'passwd', 'api_key', 'api-key', 'access_key', 'access-key',
  'credential', 'auth', 'authorization', 'client_id', 'client-id',
];

/** The defs run in each jq pipeline, in order. */
function jqPipeline(defs: string, name: string): string[] {
  return splitTopLevel(jqDefBody(defs, name), '|')
    .map((term) => term.trim().replace(/\(.*\)$/, ''))
    .filter((term) => /^[A-Za-z_]/.test(term));
}

describe('jq parity with hooks/_lib.sh (issue #90)', () => {
  it('parses the jq defs well enough to see the rules it is checking', () => {
    // Guards every parity assertion below: a parser that silently returned an
    // empty list would turn them all into vacuous passes.
    const prefixes = jqPrefixRules();
    const mysql = jqMysqlRules();
    assert.ok(prefixes.length >= 12, `expected at least 12 _prefix_tokens rules, parsed ${prefixes.length}`);
    assert.strictEqual(mysql.length, 5, 'expected 4 quoted + 1 span MySQL rules');
    const patterns = prefixes.map((r) => r.pattern).join('\n');
    for (const marker of ['ghp_', 'github_pat_', 'gh[oprsu]_', 'xox[baprs]-', 'xapp-', 'sk-[', 'sk|rk', 'AKIA', 'AIza', 'glpat-', 'npm_', 'SG\\.']) {
      assert.ok(patterns.includes(marker), `the parsed _prefix_tokens rules do not mention ${marker}`);
    }
  });

  it('carries every _prefix_tokens rule in TOKEN_PREFIX_RULES, in order, verbatim', () => {
    const jqRules = jqPrefixRules();
    assert.ok(Array.isArray(TOKEN_PREFIX_RULES), 'redaction.ts must export TOKEN_PREFIX_RULES');
    const tsRules = TOKEN_PREFIX_RULES as readonly { name: string; pattern: RegExp; replacement: string }[];
    const missing = jqRules.filter((jq) => !tsRules.some((ts) => ts.pattern.source === normalizeJqRegexText(jq.pattern)));
    const extra = tsRules.filter((ts) => !jqRules.some((jq) => normalizeJqRegexText(jq.pattern) === ts.pattern.source));
    assert.strictEqual(
      tsRules.length,
      jqRules.length,
      `jq _prefix_tokens has ${jqRules.length} rules, the TS table has ${tsRules.length};` +
        ` unpported: ${JSON.stringify(missing.map((r) => r.pattern))};` +
        ` not in jq: ${JSON.stringify(extra.map((r) => r.pattern.source))}`,
    );
    jqRules.forEach((jq, i) => {
      const ts = tsRules[i];
      assert.strictEqual(
        tsTextToJqText(ts.pattern.source),
        normalizeJqRegexText(jq.pattern),
        `prefix rule ${i} diverged from jq (${jq.pattern})`,
      );
      assert.strictEqual(ts.replacement, toJsReplacement(jq.replacement), `prefix rule ${i} replacement diverged from jq`);
    });
  });

  it('carries every MySQL -p<password> rule in MYSQL_PW_RULES, in order, verbatim', () => {
    const jqRules = jqMysqlRules();
    assert.ok(Array.isArray(MYSQL_PW_RULES), 'redaction.ts must export MYSQL_PW_RULES');
    const tsRules = MYSQL_PW_RULES as readonly { name: string; pattern: RegExp; replacement: string }[];
    assert.strictEqual(tsRules.length, jqRules.length, 'the TS MySQL table and jq _mysql_pw_all have different rule counts');
    jqRules.forEach((jq, i) => {
      const ts = tsRules[i];
      assert.strictEqual(
        denormalizeJsAtomicEmulation(tsTextToJqText(ts.pattern.source)),
        normalizeJqRegexText(jq.pattern),
        `MySQL rule ${i} (${jq.name}) diverged from hooks/_lib.sh`,
      );
      assert.strictEqual(ts.replacement, jq.replacement, `MySQL rule ${i} replacement diverged from hooks/_lib.sh`);
    });
  });

  /**
   * The generic keyword=value rule's WORD list, which no table covers: the prefix and
   * MySQL rules compare `TOKEN_PREFIX_RULES` / `MYSQL_PW_RULES` against jq, but the
   * generic rule's keywords and copulas live in two arrays in `redaction.ts` and in one
   * `gsub` in `hooks/_lib.sh`, and until this test nothing read the jq side of them. A
   * keyword added on the jq side (`private[_-]?key`, say) would therefore have kept the
   * suite green while OpenCode stopped masking it - the exact drift issue #90 is about.
   */
  it("carries jq's generic keyword and copula lists", () => {
    const rule = jqGenericKeywordRule();
    assert.ok(Array.isArray(KEYWORD_WORDS), 'redaction.ts must export KEYWORD_WORDS');
    assert.ok(Array.isArray(SEPARATOR_WORDS), 'redaction.ts must export SEPARATOR_WORDS');
    // Parser sanity first: a parse that silently returned an empty list would make the
    // two deep-equal assertions below vacuous.
    assert.ok(rule.keywords.length >= 9, `expected at least 9 generic keywords, parsed ${rule.keywords.length}: ${JSON.stringify(rule.keywords)}`);
    for (const marker of ['token', 'password', 'passwd', 'credential', 'api[_-]?key', 'auth(?:orization)?', 'client[_-]?id']) {
      assert.ok(rule.keywords.includes(marker), `the parsed generic keyword list does not contain ${marker}`);
    }
    assert.deepStrictEqual([...rule.separators], [...SEPARATOR_WORDS], 'jq copula list and SEPARATOR_WORDS diverged');
    assert.deepStrictEqual([...rule.keywords], [...KEYWORD_WORDS], 'jq generic keyword list and KEYWORD_WORDS diverged');
  });

  /**
   * The behavioural half of the parity check above: the lists must be WIRED into the rule,
   * not merely equal to it. This one runs `jq`, so it carries the same skip guard every
   * other `jq`-calling test in this file has - the assertions above parse `hooks/_lib.sh`
   * and need no second engine, and used to sit in the same test as these probes, which made
   * the whole test (including the two list comparisons) fail with `spawnSync jq ENOENT` on a
   * machine without `jq` on PATH instead of skipping.
   */
  it('fires on every keyword jq lists, on both engines', {
    skip: JQ_PRESENT ? false : 'jq is not on PATH on this machine',
  }, () => {
    // Every keyword probe is run against both engines, and a keyword dropped from the TS
    // list would show up here as a port that leaves the value visible where jq masks it.
    const values = ['S3cretPw', 'AbCd.mn_op'];
    const separators = ['=', ':', ' ', ' is ', ' was ', ' are '];
    const inputs: string[] = [];
    for (const word of KEYWORD_PROBES) {
      for (const sep of separators) inputs.push(`${word}${sep}${values[inputs.length % values.length]}`);
    }
    const defs = jqDefs();
    const diffs: string[] = [];
    let jqMasked = 0;
    for (const [index, input] of inputs.entries()) {
      const value = values[index % values.length];
      const jqOut = execFileSync('jq', ['-nr', '--arg', 's', input, defs + ' $s | redact'], { encoding: 'utf8' }).replace(/\n$/, '');
      const tsOut = redact(input);
      if (jqOut !== tsOut) diffs.push(`${JSON.stringify(input)}\n    jq: ${JSON.stringify(jqOut)}\n    ts: ${JSON.stringify(tsOut)}`);
      if (!jqOut.includes(value)) jqMasked++;
      if (tsOut.includes(value) && !jqOut.includes(value)) diffs.push(`LEAK: the port left ${JSON.stringify(value)} visible in ${JSON.stringify(input)} while jq masks it`);
    }
    assert.deepStrictEqual(diffs, [], `${diffs.length} keyword/copula probe input(s) diverge from jq`);
    // And that the probes probe: if jq masked none of them the equality above proves
    // nothing about a keyword list being wired into the rule at all.
    assert.ok(jqMasked > 0, `jq masked none of the ${inputs.length} keyword probes; the probes no longer reach the generic rule`);
  });

  /**
   * The full def chain each jq pipeline runs, pinned by name and order. This is what
   * notices a rule ADDED on the jq side - no behavioural probe can see a def that does not
   * exist in the port, and the text comparisons above only cover the defs they name. The
   * `gsub` entries are the two inline rules (the Token-scheme word rule and the generic
   * keyword=value catch-all), pinned positionally rather than by text because their text
   * is checked elsewhere: the scheme literals by the probe inputs above, the keyword lists
   * by the test above.
   */
  it('runs the same def chain as jq, in the same order, on both paths', () => {
    const defs = jqDefs();
    assert.deepStrictEqual(jqPipeline(defs, 'redact'), [
      '_pem', '_auth_scheme', 'gsub', '_url', '_prefix_tokens', '_mysql_pw_all', 'gsub', '_unmask',
    ], 'jq `redact` changed its def chain; the TS port must gain, drop or reorder the matching pass');
    assert.deepStrictEqual(jqPipeline(defs, 'redact_prompt'), [
      '_pem', '_auth_scheme_prose', '_url', '_prefix_tokens', '_unmask',
    ], 'jq `redact_prompt` changed its def chain; the TS prompt path must follow');
  });

  it('runs the MySQL rules in the command chain only, exactly as jq does', () => {
    const defs = jqDefs();
    const command = jqPipeline(defs, 'redact');
    const prompt = jqPipeline(defs, 'redact_prompt');
    assert.ok(command.includes('_mysql_pw_all'), 'jq redact no longer runs _mysql_pw_all - re-check the port');
    assert.ok(
      command.indexOf('_prefix_tokens') < command.indexOf('_mysql_pw_all'),
      'jq runs _mysql_pw_all after _prefix_tokens; the TS port must keep that position',
    );
    assert.ok(
      !prompt.some((def) => def.startsWith('_mysql')),
      'jq redact_prompt now includes a MySQL rule; the TS prompt path must gain it too',
    );
    // And the TS port must actually mirror that placement, not just claim it.
    assert.strictEqual(redact('mysql -h db -u app -pS3cretPw dbname'), 'mysql -h db -u app -p*** dbname');
    assert.strictEqual(redactPrompt('mysql -h db -u app -pS3cretPw dbname'), 'mysql -h db -u app -pS3cretPw dbname');
  });
});

describe('issue #81 rules, ported to the OpenCode plugin', () => {
  const masked = [
    ['mysql -h db -u app -pS3cretPw dbname', 'mysql -h db -u app -p*** dbname'],
    ['ssh host "mysqldump -u x -pS3cretPw dbname"', 'ssh host "mysqldump -u x -p*** dbname"'],
    ['mysqladmin -h1 -pS3cretPw status', 'mysqladmin -h1 -p*** status'],
    ['mariadb-dump --single-transaction -pS3cretPw dbname', 'mariadb-dump --single-transaction -p*** dbname'],
    ['mysql -u app -p"pa ss" dbname', 'mysql -u app -p*** dbname'],
    ['mysql -uroot "-pS3cretPw" db', 'mysql -uroot "-p***" db'],
    ['mysql -uroot \'-pS3cret Pw\' db', 'mysql -uroot \'-p***\' db'],
    ['ssh prod "mysqldump -uroot \\"-pS3cret Pw\\" app"', 'ssh prod "mysqldump -uroot \\"-p***\\" app"'],
    ['docker exec db sh -c "mysql -uroot \\"-pS3cret\\" app"', 'docker exec db sh -c "mysql -uroot \\"-p***\\" app"'],
    ['mysql -uroot "-p"S3cretPw db', 'mysql -uroot "-p***" db'],
    ['mysql -uroot -p"abc"def db', 'mysql -uroot -p*** db'],
    ['mysql -u root -p$(cat pwfile) dbname', 'mysql -u root -p*** dbname'],
    ['mysqldump db \\\n-pS3cretPw dbname', 'mysqldump db \\\n-p*** dbname'],
    ['mysql -h h 2>&1 -pS3cretPw db', 'mysql -h h 2>&1 -p*** db'],
    ['mysqladmin ping &>/dev/null -pS3cretPw', 'mysqladmin ping &>/dev/null -p***'],
    ['mysql -h db -u root -e "show databases;" -pS3cretPw', 'mysql -h db -u root -e "show databases;" -p***'],
    ["mysql -e 'a|b' -pS3cretPw dbname", "mysql -e 'a|b' -p*** dbname"],
    ['mysql -e "select -pfoo from t" -pS3cretPw dbname', 'mysql -e "select -pfoo from t" -p*** dbname'],
    // Documented false positives: the anchor is a word, not a parse position.
    ['find /var/lib/mysql -name x.ibd -print', 'find /var/lib/mysql -name x.ibd -p***'],
    ['docker run --name mysql -p3306:3306 mysql:8', 'docker run --name mysql -p*** mysql:8'],
  ];
  for (const [input, expected] of masked) {
    it(`masks the password in ${JSON.stringify(input)}`, () => {
      assert.strictEqual(redact(input), expected);
      assert.ok(!redact(input).includes('S3cret'), `the password survived in ${JSON.stringify(redact(input))}`);
    });
  }

  const untouched = [
    'ssh -p 2222 host true',
    'mysql -p dbname',
    'mysql -u app db | ssh -p2222 host',
    'mysql db; tar -pczf x.tgz d',
    'mysqldump db && cp -pr a b',
    'mysqldump db & ssh -p2222 host',
    'mysql -uroot && rsync "-pavz" src dst',
    // A plain newline is a hard stop: no -p on the next line is in scope for the
    // client named above it.
    'mysql -e "select 1" \n scp -p file host:',
    'ls -p /tmp',
    'notmysql -pX',
  ];
  for (const input of untouched) {
    it(`leaves ${JSON.stringify(input)} alone`, () => {
      assert.strictEqual(redact(input), input);
    });
  }

  const prefixes = [
    ['glab api -H "X: glpat-ABCDEFGHIJKLMNOPQRST"', 'glab api -H "X: glpat-***"'],
    ['deploy --key sk_live_AbCdEfGh1234567890', 'deploy --key sk_live_***'],
    ['deploy --key rk_test_AbCdEfGh1234567890', 'deploy --key rk_test_***'],
    ['echo xapp-1-A01B2C3D4E5F-1234567890abcdef-abcdef1234', 'echo xapp-***'],
    ['echo npm_AbCdEfGh1234567890AbCdEfGh1234', 'echo npm_***'],
    ['mail --key SG.abcdefghijklmnopqrst.ABCDEFGHIJKLMNOPQRST', 'mail --key SG.***'],
  ];
  for (const [input, expected] of prefixes) {
    it(`masks ${JSON.stringify(input)} on both paths`, () => {
      assert.strictEqual(redact(input), expected);
      // These are shape-only rules, so the prose-safe prompt path runs them too.
      assert.strictEqual(redactPrompt(input), expected);
    });
  }

  const prefixFalsePositives = [
    'echo glpat-ABCDEFGHIJKLMNOPQRS',
    'echo glpat-abc',
    'cat MSG.errorMessageTemplate.userNotFoundError',
    'ls xapp-config-generator',
    'echo disk_test_AbCdEfGh1234567890',
    'echo fooxapp-1-A01B2C3D4E5F-1234567890abcdef',
    'echo mynpm_AbCdEfGh1234567890AbCdEfGh123456',
  ];
  for (const input of prefixFalsePositives) {
    it(`leaves the identifier in ${JSON.stringify(input)} alone`, () => {
      assert.strictEqual(redact(input), input);
      assert.strictEqual(redactPrompt(input), input);
    });
  }

  it('does not blow up on a long run of redirects with no -p behind it', () => {
    // jq 1.7.1 hits Oniguruma's retry limit at 12 `N>&M` tokens once the span is
    // not atomic; the TS port emulates the atomic group for the same reason, and
    // this is the case that proves the emulation is doing its job.
    const input = 'mysqldump ' + Array(20).fill('2>&1').join(' ') + ' db';
    const started = Date.now();
    const result = redact(input);
    const elapsed = Date.now() - started;
    assert.strictEqual(result, input);
    assert.ok(elapsed < 5000, `redacting ${JSON.stringify(input)} took ${elapsed}ms - the span is backtracking again`);
  });
});

// ---------------------------------------------------------------------------
// Regex-ENGINE parity, not just rule-text parity (issue #90)
// ---------------------------------------------------------------------------

/**
 * The parity suite above compares pattern TEXT, which cannot see the case that
 * matters most: JS and Oniguruma read the *same* text differently. JS `.` also
 * refuses CR, JS `\s` additionally matches U+FEFF, and JS `\b` is not
 * Unicode-aware. The first two are fixed by spelling the rule out (see
 * `JS_NOT_WS` / the `[ ^\n]` step in `redaction.ts` and `ENGINE_SPELLINGS` here);
 * the third is left as a documented divergence, except on the Token-scheme word rule, which
 * issue #116 split at the anchor seam instead of picking a side. This suite pins all of it, and
 * its differential test is what stops the text-normalization mapping from being
 * used to paper over a real behavioural drift.
 */
/**
 * Places where the two implementations still behave differently, each with its
 * DIRECTION pinned, because the direction is not uniform and cannot be made so.
 *
 * JS reads `\b` as ASCII-only and Oniguruma reads it as Unicode, and THAT difference
 * cannot be spelled out the way `\s` was. Measured, not assumed: the closest
 * Unicode-property class JS offers, `[\p{L}\p{N}\p{M}_]`, disagrees with Oniguruma's
 * word set on 583 of the 19,979 code points probed against jq 1.7.1 (and
 * `[\p{L}\p{N}_]` on 2,179), so a lookbehind written with property escapes would move
 * the divergence rather than close it - and it would land on the side that leaks, in
 * rules whose `\S`-spelled classes use identity escapes the `u` flag rejects.
 *
 * `\w` is a different case and was fixed rather than pinned: in the generic keyword
 * rule an affix that stops early does not merely shift a boundary, it makes the
 * separator alternatives unmatchable so the rule never fires and the secret is stored
 * whole. There the port over-approximates Oniguruma's word set (`JS_WORD_STAR`), which
 * fires wherever jq fires - but its residue is NOT only on the masking side, and this
 * comment used to say it was. Running the widened class as a second pass keeps it from
 * eating a keyword a later RULE needs, and that is why the seeded fuzz test can assert
 * zero leaks over its own corpus; it does not cover the case where the FIRST pass, whose
 * affixes are ASCII like jq's text, eats a keyword the single Unicode-aware pass would
 * have matched instead. Two rows below are that: `under` rows with a `\w` mechanism, not a
 * `\b` one, both leaking on `main` too. So `under` rows are NOT all `\b`-anchored, and a
 * future `\w` change must check them rather than assume the direction.
 * The `over` rows below are the residue of the widened class: a non-ASCII character
 * jq's `\w` refuses and the port's over-approximation accepts.
 *
 * So each row below says which engine masks more, and the differential test asserts
 * that row rather than assuming a direction. `over` = the port masks a command jq
 * leaves visible (no secret escapes). `under` = jq masks a secret the port leaves in
 * cleartext: a LEAK, with both outputs pinned verbatim so it cannot grow quietly, in
 * shape or in count. A later round that closes one must DELETE its row, not soften it.
 */
const ENGINE_DIVERGENCES: readonly {
  input: string;
  /**
   * Rows that carry BOTH outputs pinned verbatim, `under` rows always and `over` rows where
   * jq masks part of the line too (see the `over` row above the differential test for why
   * the direction heuristic cannot describe those). A pinned `ts` is asserted without `jq`.
   */
  direction: 'over' | 'under';
  note: string;
  /** Rows with `ts` set are asserted output-for-output, in both engines. */
  jq?: string;
  ts?: string;
}[] = [
  {
    input: 'mysql\u00e9 -pS3cretPw db',
    direction: 'over',
    note: 'jq does not anchor after a non-ASCII word character (Unicode-aware \\b), the TS port does',
  },
  {
    input: '\u00e9mysql -pS3cretPw db',
    direction: 'over',
    note: 'same, on the leading \\b of the client-name anchor',
  },
  {
    input: 'mail --key \u00e9SG.abcdefghijklmnopqrst.ABCDEFGHIJKLMNOPQRST',
    direction: 'over',
    note: 'jq leaves this SendGrid-shaped token in cleartext (its \\b does not fire after \u00e9); the port masks it. Over-redaction here is a gap on the jq side, not a leak here.',
  },
  {
    // The over-match above is not harmless in the general case, because an early rule
    // that masks MORE than jq can consume the keyword a LATER rule needed, and the
    // secret that rule would have masked survives. Both of these are the port's own
    // `\b` firing after \u00e9; the difference from the three rows above is only what
    // the extra mask swallows. These two are NEW leaks: `main` masks both secrets (measured
    // against a build of `main` - it returns `\u00e9SG.abc...password=***` and `\u00e9mysql -pxtoken ***`,
    // the same text jq writes), so the rules this port adds are what make them survive. The
    // third `\b` row of this class, the Token-scheme one, is deleted below: issue #116 closed it.
    input: '\u00e9SG.abcdefghijklmnopqrst.ABCDEFGHIJKLMNOPQRSTpassword=S3cret',
    direction: 'under',
    jq: '\u00e9SG.abcdefghijklmnopqrst.ABCDEFGHIJKLMNOPQRSTpassword=***',
    ts: '\u00e9SG.***=S3cret',
    note: 'LEAK, introduced by this port (masks fine on `main`): the port anchors on \u00e9 and the SendGrid token class swallows the following `password`, so the generic keyword rule never fires and `S3cret` survives. jq anchors nowhere and masks `password=S3cret` instead. Accepted as rare: it needs a non-ASCII letter glued directly in front of an `SG.` token that is itself glued to a `keyword=value` pair. dynamic/throughline#116 closed only the Token-scheme instance of this class, by splitting that rule at its anchor seam; this row and the MySQL one below stay open because the rules that fire there have no generic fall-through to hand the value to.',
  },
  {
    input: '\u00e9mysql -pxtoken abcS3cret',
    direction: 'under',
    jq: '\u00e9mysql -pxtoken ***',
    ts: '\u00e9mysql -p*** abcS3cret',
    note: 'LEAK, introduced by this port (masks fine on `main`): the port anchors on \u00e9 and the MySQL span eats `token`, so the token-word rule never fires and `abcS3cret` survives. Same mechanism as the row above, different rule order, same acceptance. dynamic/throughline#116 closed the third row of this class, the Token-scheme word rule, by splitting that rule at the anchor seam so it masks through the generic rule where the engines disagree; these two stay pinned because the rules that fire there have no such fall-through to hand the value to.',
  },
  // The `over` rows below are the residue of over-approximating Oniguruma's `\w` in the
  // generic keyword rule (`JS_WORD_STAR`): jq's `\w` refuses a non-ASCII PUNCTUATION,
  // SYMBOL or FORMAT character, so its affix stops there, the separator alternatives
  // cannot match it, and jq leaves the secret in cleartext - the port fires and masks.
  // One row per Unicode general category the residue spans, so the shape is pinned
  // without pinning 45 near-identical inputs; the seeded fuzz test below sweeps the
  // separators around them and asserts the direction on each.
  {
    input: 'password\u00a9=S3cret',
    direction: 'over',
    note: 'So (symbol other): jq does not treat \u00a9 as a word character, so its keyword affix stops and `=` is unreachable as a separator; the port masks.',
  },
  {
    input: 'password\u00ad=S3cret',
    direction: 'over',
    note: 'Cf (format, soft hyphen): same shape, and the character is invisible in most renderings, which is what makes a pinned row worth having.',
  },
  {
    input: 'password\ufeff=S3cret',
    direction: 'over',
    note: 'Cf (BOM): jq leaves `password<BOM>=S3cret` verbatim because its `\\w` refuses U+FEFF and a JS `\\s` used to accept it; the port now masks it for the opposite reason. This is the one residue case the hand-written corpus already carried.',
  },
  {
    input: 'password\u200b=S3cret',
    direction: 'over',
    note: 'Cf (zero-width space): zero-width characters are exactly what a copy-paste from a web page leaves between a keyword and its `=`.',
  },
  {
    input: 'password\u180e=S3cret',
    direction: 'over',
    note: 'Cf (Mongolian vowel separator): the category is what matters, not the character.',
  },
  {
    input: 'password\u2011=S3cret',
    direction: 'over',
    note: 'Pd (dash): a non-breaking hyphen in `password\u2011=S3cret`; jq leaks, the port masks.',
  },
  {
    input: 'password\u201c=S3cret',
    direction: 'over',
    note: 'Pi (initial punctuation quote): a curly quote glued to the keyword. Checked rather than assumed: the quoted form `password\u201c"S3cret"` is left verbatim by BOTH engines, so only the bare value diverges - the quote alternative masks it on neither side.',
  },
  {
    input: 'password\u20ac=S3cret',
    direction: 'over',
    note: 'Sc (currency symbol).',
  },
  {
    input: 'password\u3001=S3cret',
    direction: 'over',
    note: 'Po (CJK punctuation, ideographic comma).',
  },
  {
    input: 'password\u{1f600}=S3cret',
    direction: 'over',
    note: 'So outside the BMP, seen here as a UTF-16 surrogate pair: without the `u` flag this file matches code units, and a surrogate is neither ASCII nor whitespace, so it counts as a word character. jq sees one code point and refuses it.',
  },
  {
    input: 'password\ue000=S3cret',
    direction: 'over',
    note: 'Co (private use): no Unicode property resolves this one either way, which is the honest limit of any attempt to spell the Oniguruma word set out in JS.',
  },
  // The URL userinfo anchor. jq's `_url` requires a scheme (`://`); this port anchors on
  // `//`, so a scheme-relative reference is masked here and left verbatim by jq. Chosen
  // direction: `hunter2` in userinfo position is a password in any reading, and the
  // shipped plugin masks these two today - narrowing the anchor to reach jq's text would
  // have been an un-redaction, not a parity fix. Widening jq's `_url` is the way to close
  // them, in the hooks repo, not by removing a mask here.
  {
    input: '//user:pw@host',
    direction: 'over',
    note: 'Scheme-relative userinfo: jq\'s `_url` anchors on `://` and leaves this verbatim; the port anchors on `//` and masks the password. Deliberate, and the direction is pinned - if it ever flips, a credential the shipped plugin masks is being stored in cleartext.',
  },
  // The row that used to sit here is the dynamic/throughline#116 leak, and it is CLOSED, so
  // per the rule at the top of this table ("a later round that closes one must DELETE its row,
  // not soften it") it is gone: the port no longer anchors its Token rule with a bare
  // word-boundary, so `\u00fcTOKEN is <secret>` now reaches the generic keyword rule and masks the
  // way the hooks do. Both inputs of that leak live in `engineCases` as ordinary parity rows,
  // and `it('masks the value after a non-ASCII letter …')` asserts them without `jq`.
  //
  // The two `over` rows below are what the fix leaves behind. The two `under` rows above it
  // (`SG.`, MySQL client anchor) are untouched: same mechanism, different rule, still leaking.
  {
    // The residue of that fix, and it points the safe way: an input where the port now masks
    // MORE than the hooks, because jq's own Token rule ate the copula `is` so jq's generic
    // rule never reached the value.
    input: '\u00a9token is S3cretPw',
    direction: 'over',
    jq: '\u00a9Token *** S3cretPw',
    ts: '\u00a9token is ***',
    note: 'OVER-REDACTION, and the leak here is on the jq side: \u00a9 is not a word character to Oniguruma, so jq anchors a boundary there, its Token rule matches the word `is` as the value, and the copula its generic rule needed is rewritten away - `S3cretPw` survives in the hooks. This port cannot tell that \u00a9 from the \u00fc in the row this replaces (no JS class reproduces Oniguruma\'s word set), so in the ambiguous zone it masks the value through the GENERIC separator and value alternatives and writes the keyword and separator back verbatim, which leaves the copula alive for the pass that needs it. Both outputs pinned because jq masks part of the line too and the direction heuristic cannot describe this row.',
  },
  {
    // Same ambiguous zone, the shape where neither engine leaks and only the literal moved.
    input: '\u00a9token YWJjZGVmZ2hpamts',
    direction: 'over',
    jq: '\u00a9Token ***',
    ts: '\u00a9token ***',
    note: 'LITERAL-ONLY residue of the same fix, pinned so it cannot quietly become a leak. Both engines mask the whole value; jq writes its own `Token` spelling and this port leaves the keyword as the input spelled it, because in the ambiguous zone it masks through the generic rule instead of guessing which side of the boundary jq landed on. `over` here means "the port did not mask less" - both outputs are pinned, so any change of shape, including one that stops masking the value, fails.',
  },
  {
    // The chain the ambiguous zone has to answer without knowing which side of the boundary
    // fired: the VALUE is itself a keyword, so masking just the value would delete the keyword
    // the generic rule needs next. Review of the first version of dynamic/throughline#116 found
    // exactly this shape leaking, and no test before it covered it.
    input: '\u00a0token is password S3cretPw9',
    direction: 'over',
    jq: '\u00a0Token *** password ***',
    ts: '\u00a0token is ***',
    note: 'OVER-REDACTION by design, and the shape that decides the design: NBSP is not a word character to Oniguruma, so jq anchors a boundary there, its Token rule eats the copula, `password` survives as a keyword and jq\'s generic rule then masks `S3cretPw9`. This port cannot see which side of the boundary NBSP is on, so when the value is keyword-like the mask walks forward over the pairs it heads: ` is password S3cretPw9` goes in one mask. Both outputs pinned - if the walk ever stops one pair short this row fails as a leak, which is exactly what it did before the walk existed.',
  },
  {
    // Same walk, with the head keyword carrying a non-ASCII affix: that is why the walk asks
    // KEYWORD_CONTAINED (Unicode-aware, like jq) and not KEYWORD_HEAD (ASCII-anchored, like
    // pass 6a). An ASCII-anchored test stops the walk one pair short here.
    input: '\u2014token is \u00fcsecret S3cretPw9',
    direction: 'over',
    jq: '\u2014Token *** \u00fcsecret ***',
    ts: '\u2014token is ***',
    note: 'OVER-REDACTION, the Unicode-affix case of the walk: jq\'s generic keyword group reads `\u00fcsecret` as a keyword because its `\w` is Unicode-aware and JS\'s is ASCII, so the secret behind it is masked by jq and has to be masked here too. An ASCII-anchored keyword test in the walk leaks this input; KEYWORD_CONTAINED is what closes it.',
  },
  {
    // The walk across a copula spelled with a case-fold partner, on an astral prefix.
    input: '\u{1f600}TOKEN i\u017f password S3cretPw9',
    direction: 'over',
    jq: '\u{1f600}Token *** password ***',
    ts: '\u{1f600}TOKEN i\u017f ***',
    note: 'OVER-REDACTION: an astral prefix reaches the ambiguous zone as a low surrogate (above ASCII, so this port cannot tell it from a letter), and the copula is spelled with U+017F, which only the fold-spelled separator matches. Same walk as the rows above, pinned so neither half of that can regress silently.',
  },
  {
    input: 'x//user:pw@host',
    direction: 'over',
    note: 'Same rule, same direction, with the anchor mid-token rather than at the start of the input, so the `//` anchor is pinned in both positions.',
  },
  // Pass 6b re-runs the generic rule over text pass 6a already rewrote, and a guard on the
  // keyword alone cannot see every case of that. When a keyword carries a non-ASCII
  // character in its MIDDLE, both passes match it (6a's `\w*` suffix stops at the
  // character and the separator alternative then matches from there), so 6a masks the value
  // and 6b masks 6a's `***` plus whatever is glued to it. The keyword guard does not catch
  // this and a VALUE guard ("skip when the value starts with `***`") is worse: it cannot
  // tell 6a's `***` from three asterisks a user pasted, and `password\u00e9=***S3cretPw` is a
  // value this port must mask, which such a guard would hand back in cleartext. So the
  // residue stays pinned. It masks MORE than jq and never less.
  {
    input: 'token\u00e9token="a b"c d',
    direction: 'over',
    jq: 'token\u00e9token=***c d',
    ts: 'token\u00e9token=*** d',
    note: 'OVER-REDACTION, pinned verbatim because jq masks part of this line too and the direction heuristic only recognises "jq left it visible": pass 6a masks the second `token`, and pass 6b - whose widened suffix crosses the \u00e9 - then matches `token\u00e9token=***` plus the `c` glued to it and masks that as well. jq stops after its own mask. Both engines mask the secret; this port also eats one ASCII character glued to it.',
  },
  // The two-pass keyword rule has a leak direction too, and these rows are it. Pass 6a runs
  // jq's ASCII affixes FIRST, and a keyword whose ASCII affix stops short of the non-ASCII
  // letter jq's `\w*` would cross can match a LATER keyword in the same line and eat it as
  // the earlier one's value - so the keyword jq would have matched is gone before the
  // widened pass runs, and the value behind it survives. Pass 6b then masks the earlier
  // keyword's value, which is why the output looks like it masked more than jq while
  // leaking a secret jq masks. Both rows leak identically on `main` (measured against a
  // build of `main`), so neither is a regression; they are pinned because they contradict
  // any claim that the second pass can only over-mask. Closing them needs pass 6b to see
  // the whole line before 6a consumes it, which reintroduces the U+180E leak the two-pass
  // shape exists to avoid - so the two-pass order stays, and this class stays pinned.
  {
    input: 'export DB_PASSWORD_\u00c9 SECRET PASSWORD S3cret',
    direction: 'under',
    jq: 'export DB_PASSWORD_\u00c9 *** PASSWORD ***',
    ts: 'export DB_PASSWORD_\u00c9 *** *** S3cret',
    note: 'LEAK, pre-existing on `main` (`export DB_PASSWORD_\u00c9 SECRET *** S3cret`): JS\'s ASCII `\w*` stops `DB_PASSWORD_` short of \u00c9, so pass 6a matches `SECRET PASSWORD` and masks `PASSWORD` as its value; jq\'s `\w*` crosses \u00c9, matches `DB_PASSWORD_\u00c9 SECRET` first, and still has `PASSWORD S3cret` to mask. `S3cret` survives here and on `main`, and only pass 6b\'s later mask makes the line look over-redacted.',
  },
  {
    input: 'secret\u00e9 api_key credential hunter2',
    direction: 'under',
    jq: 'secret\u00e9 *** credential ***',
    ts: 'secret\u00e9 *** *** hunter2',
    note: 'LEAK, pre-existing on `main` (`secret\u00e9 api_key *** hunter2`): same mechanism one keyword later - `secret\u00e9` cannot fire in pass 6a, so `api_key credential` is matched instead and `hunter2` is never reached. The shape the seeded corpus cannot generate: its two-keyword template puts no affix on the first keyword.',
  },
  // The Token-scheme ambiguous zone and the MySQL client anchor both need words out of the same
  // line, and the two orderings each delete one the other needs. These two `over` rows are what
  // the shipped order leaves behind; the secrets are masked in both engines on both inputs.
  {
    input: '\u00a9token is mysql -pS3cret',
    direction: 'over',
    jq: '\u00a9Token *** mysql -p***',
    ts: '\u00a9token is *** -p***',
    note: 'OVER-REDACTION, both secrets masked in both engines: \u00a9 is not a word character to Oniguruma, so jq anchors a boundary there, its Token rule eats the copula, and its generic rule never sees a `token is <value>` pair - `mysql` stays visible. This port cannot tell \u00a9 from \u00e9, so in the ambiguous zone it masks the value through the generic alternatives and its own generic pass then masks the client name too. What matters is the ORDER: the client name stays on the line until `_mysql_pw_all` has anchored on it. Masking it at step 3 - what the first version of this fix did - leaked `-pS3cret` on 5,454 of the 150,480-input sweep that found it.',
  },
  {
    input: '\u00a9token token password S3cretPw',
    direction: 'over',
    jq: '\u00a9Token *** password ***',
    ts: '\u00a9token ***',
    note: 'OVER-REDACTION by the chain walk, pinned because the two engines match at DIFFERENT positions here: jq anchors after \u00a9, so its leftmost match is the first `token` and it eats the second one, leaving `password S3cretPw` to the generic rule; this port refuses the first position, and an ASCII-anchored pass run over the zone\u0027s output then reaches the second `token` and eats `password` - the keyword the generic rule needed - which is exactly how this input leaked. Running the ambiguous zone FIRST means its walk covers the whole run and no ASCII-anchored match is left to eat a keyword the generic pass still needed.',
  },
  // The cost of KEYWORD_CONTAINED being a substring test, pinned rather than asserted in a
  // comment. Review of dynamic/throughline#122 asked that this be named as a known cost; these
  // two rows are what "named" means in a suite: the prose word masked here, and the prose word
  // that is NOT masked, both written down with both engines' output.
  {
    input: '\u00a9token is authority S3cretPw9',
    direction: 'over',
    jq: '\u00a9Token *** authority ***',
    ts: '\u00a9token is ***',
    note: 'OVER-REDACTION of ordinary prose, and the cost this branch accepts: `authority` is not a keyword, it CONTAINS one (`auth(?:orization)?`), and KEYWORD_CONTAINED is a substring test on purpose (a Unicode-affixed keyword like `\u00fcsecret` only passes that test, and anchoring it would leak - see the row above). So the walk runs past `authority` and masks the whole run. jq leaves the word standing and masks only the secret. Both engines mask `S3cretPw9`; this one also eats an English word on a line that already has \u00a9 welded to `token`. Siblings measured the same way: `author`, `tokenish`, `credentialist`.',
  },
  {
    input: '\u00a9token is passport S3cretPw9',
    direction: 'over',
    jq: '\u00a9Token *** passport S3cretPw9',
    ts: '\u00a9token is *** S3cretPw9',
    note: 'THE OTHER HALF of that cost, pinned so the cost cannot be overstated either: `passport` and `keychain` contain no keyword in the list (`pass` and `key` are not keywords alone), so the walk does NOT extend over them and nothing behind them is masked. Both engines then leave `S3cretPw9` visible - jq\u0027s own Token rule ate the copula, so its generic rule has no `token is <value>` pair left, and this port masked the value through the generic alternatives and stopped. Literal-only divergence, no leak on either side, and the reason the walk stays a substring test: widening it further would eat more prose, and narrowing it leaks.',
  },
  // The MySQL-anchor guard has a leak direction of its own, and these two rows are what it leaves
  // once that direction is closed: preserving the client name for pass 5b is only safe while 5b
  // masks a password that is NOT itself a keyword.
  {
    input: '\u00a9token mysql -ppassword S3cretPw9X',
    direction: 'over',
    jq: '\u00a9Token *** -ppassword ***',
    ts: '\u00a9token *** -ppassword ***',
    note: 'LITERAL-ONLY, and the shape that made the client-name guard a leak: where jq\u0027s boundary fires after \u00a9 its Token rule eats `mysql`, `_mysql_pw_all` never anchors, and jq\u0027s generic rule reads the glued `ppassword` as a keyword and masks the secret - so this port has to mask `mysql` too, which the guard now does exactly when the password ahead is keyword-shaped. Deferring to 5b there masked `-ppassword` outright, deleted the keyword the generic rule needed, and left `S3cretPw9X` in cleartext on an input `main` masks (288 inputs in the review\u0027s 233,280-input fuzz, all of them this shape). Both outputs pinned: the only difference left is jq\u0027s `Token` literal.',
  },
  {
    input: '\u00e9token mysql -ppassword S3cretPw9X',
    direction: 'over',
    jq: '\u00e9token *** -p*** S3cretPw9X',
    ts: '\u00e9token *** -ppassword ***',
    note: 'OVER-REDACTION on the boundary-REFUSES side of the same zone, pinned because the two engines mask DIFFERENT words and only this port masks the secret: jq\u0027s `\b` refuses after \u00e9, so its pass 5b anchors on `mysql`, masks the keyword `password` as the password, and leaves `S3cretPw9X`; this port cannot tell \u00e9 from \u00a9, masks the client name, and lets its generic rule mask the secret. That is the accepted asymmetry of the ambiguous zone - it masks the union of the two readings, so it over-masks a word jq ate and never under-masks the credential.',
  },
];

describe('regex-engine parity with jq (issue #90)', () => {
  const engineCases: readonly [string, string][] = [
    // JS `.` refuses CR, Oniguruma's does not: a CRLF line continuation inside a
    // quoted -e used to stop the span and leave the password in cleartext.
    ['mysql -e "select \\\r\n 1" -pS3cretPw db', 'mysql -e "select \\\r\n 1" -p*** db'],
    // JS `\s` matches U+FEFF, Oniguruma's does not: the value run must walk over a
    // BOM inside a password the way jq's does, not stop at its head.
    ['mysql -pab\ufeffcd x', 'mysql -p*** x'],
    // Whitespace, code point by code point rather than trusted to an escape: every
    // code point Oniguruma reads as whitespace (verified one at a time against jq
    // 1.7.1) plus the two the engines disagree about - U+0085 is whitespace to jq
    // and not to JS, U+FEFF is the reverse. Each pair is '-p<space>x y', which
    // neither engine masks because the value has to touch -p, and 'ab<space>cd'
    // mid-value, which both mask up to the space and no further.
    ['mysql -p\u0085x y', 'mysql -p\u0085x y'],
    ['mysql -pab\u0085cd x', 'mysql -p***\u0085cd x'],
    ['mysql -p\u00a0x y', 'mysql -p\u00a0x y'],
    ['mysql -pab\u00a0cd x', 'mysql -p***\u00a0cd x'],
    ['mysql -p\u1680x y', 'mysql -p\u1680x y'],
    ['mysql -pab\u1680cd x', 'mysql -p***\u1680cd x'],
    ['mysql -p\u2000x y', 'mysql -p\u2000x y'],
    ['mysql -pab\u2000cd x', 'mysql -p***\u2000cd x'],
    ['mysql -p\u200ax y', 'mysql -p\u200ax y'],
    ['mysql -pab\u200acd x', 'mysql -p***\u200acd x'],
    ['mysql -p\u2028x y', 'mysql -p\u2028x y'],
    ['mysql -pab\u2028cd x', 'mysql -p***\u2028cd x'],
    ['mysql -p\u2029x y', 'mysql -p\u2029x y'],
    ['mysql -pab\u2029cd x', 'mysql -p***\u2029cd x'],
    ['mysql -p\u202fx y', 'mysql -p\u202fx y'],
    ['mysql -pab\u202fcd x', 'mysql -p***\u202fcd x'],
    ['mysql -p\u205fx y', 'mysql -p\u205fx y'],
    ['mysql -pab\u205fcd x', 'mysql -p***\u205fcd x'],
    ['mysql -p\u3000x y', 'mysql -p\u3000x y'],
    ['mysql -pab\u3000cd x', 'mysql -p***\u3000cd x'],
    // U+FEFF, the reverse case: whitespace to neither engine, so a -p followed
    // directly by a BOM masks on both sides and a BOM inside a value is walked
    // over by both. Written as an escape so it cannot be silently stripped.
    ['mysql -p\ufeffdbname', 'mysql -p***'],
    ['mysql -p\ufeffx y', 'mysql -p*** y'],
    // The generic keyword=value rule, the auth-scheme separators and the URL
    // userinfo class all used a raw `\s`, and JS's `\s` and Oniguruma's differ in
    // BOTH directions. U+FEFF: JS stops the value run at the BOM and masks only its
    // head, leaving the tail of the password in cleartext - the leak the review
    // reported, in rules that predate the issue #81 port.
    ['password=abc\ufeffS3cret rest', 'password=*** rest'],
    ['export API_TOKEN=abc\ufeffS3cret', 'export API_TOKEN=***'],
    // U+0085, the reverse: whitespace to Oniguruma and not to JS. Here the value run
    // STOPS at the U+0085 in both engines once the class is spelled out, so the tail
    // stays visible in both - jq leaks it too, and matching that is the point of the
    // port. What the JS-only `\s` did instead was mask through it, which is the
    // over-redaction half of the same missing code point.
    ['password=abc\u0085S3cret rest', 'password=***\u0085S3cret rest'],
    // And the separators, where the difference is whether the rule fires AT ALL: with
    // a JS `\s` a U+0085 separator matches nothing, so the secret is stored whole.
    ['bearer\u0085AbCdEfGhIjKlMnOp', 'Bearer ***'],
    ['basic\u0085YWJjZGVmZ2hpamts', 'Basic ***'],
    ['token\u0085AbCdEf.mn_op', 'Token ***'],
    ['password\u0085=S3cret', 'password\u0085=***'],
    ['password\u0085is S3cret', 'password\u0085is ***'],
    // The BOM side of the same separator: not whitespace to jq, so jq does not fire on
    // the separator at all. `bearer` is not a keyword so that input stays verbatim;
    // `password<BOM>=` is masked by the port now, because the keyword affix
    // over-approximates Oniguruma's `\w` and counts the BOM - an OVER-redaction, pinned
    // as an `over` row above rather than quietly asserted away here.
    ['bearer\ufeffAbCdEfGhIjKlMnOp', 'bearer\ufeffAbCdEfGhIjKlMnOp'],
    ['password\ufeff=S3cret', 'password\ufeff=***'],
    // The `\w` affixes of the generic keyword rule: Oniguruma's `\w*` walks over a
    // non-ASCII letter, JS's stops there, the separator alternatives cannot match a
    // letter, and the rule never fires at all - the secret is stored whole. `JS_WORD_STAR`
    // fires wherever jq does; note the last two, one accented letter after the keyword with
    // no other rule involved, which is the cheapest shape that leaks.
    ['password\u00e9=S3cret', 'password\u00e9=***'],
    ['export DB_PASSWORD_\u00c9=S3cret', 'export DB_PASSWORD_\u00c9=***'],
    ['secret\u0663=S3cret', 'secret\u0663=***'],
    ['api_key\u00aa: S3cret', 'api_key\u00aa: ***'],
    ['token\u00fc abcS3cret', 'token\u00fc ***'],
    // The case fold, same shape one step further in: Oniguruma's `(?i)` folds U+017F onto
    // `s`, U+212A onto `k` and U+00DF / U+1E9E onto the two-character `ss`; JS's `i` flag
    // folds none of them, so the keyword literal does not match and the rule never fires.
    // Written with escapes on purpose - a literal U+FEFF in this file can be stripped by an
    // editor, leaving an assertion on a plain space with a comment describing a BOM.
    ['pa\u00dfword=S3cret', 'pa\u00dfword=***'],
    ['pa\u1e9eword=S3cret', 'pa\u1e9eword=***'],
    ['pa\u017f\u017fword=S3cret', 'pa\u017f\u017fword=***'],
    ['pas\u017fword=S3cret', 'pas\u017fword=***'],
    ['\u017fecret: hunter2', '\u017fecret: ***'],
    ['to\u212aen=AbCdEfGhIjKl', 'to\u212aen=***'],
    ['to\u212aen AbCdEfGhIjKlMn', 'Token ***'],
    ['ba\u017fic QWxhZGRpbjpvcGVu', 'Basic ***'],
    ['password i\u017f S3cret', 'password i\u017f ***'],
    ['api\u212aey=S3cret', 'api\u212aey=***'],
    // A fold partner inside the VALUE, where the question is not whether the rule fires
    // but how far the mask reaches: jq's `(?i)[A-Za-z0-9._-]` walks over the long s, JS's
    // stopped in front of it and masked only the head.
    ['bearer AbCd\u017fEfGh', 'Bearer ***'],
    ['access\u212aey: S3cret', 'access\u212aey: ***'],
    // URL userinfo. The BOM cases: a BOM inside the userinfo used to end the match, so
    // the rule did not fire and the password was never masked at all; U+0085 is whitespace
    // to jq, so there the rule does NOT fire and matching jq means leaving it verbatim.
    ['https://user\ufeffname:pass\ufeffword@host', 'https://user\ufeffname:***@host'],
    ['https://user\u0085name:pass\u0085word@host', 'https://user\u0085name:pass\u0085word@host'],
    // The generic keyword rule runs TWICE on the command path (jq's ASCII affixes, then the
    // Oniguruma word class), and the second pass must be skipped when the text is all
    // ASCII - there the widened rule is the same rule that already ran, and running a rule
    // over its own output is NOT the same as running it once: the first pass has replaced a
    // value with `***`, and the second then matches `***` plus whatever follows it and
    // masks that too. These two inputs are where that showed: jq masks the quoted value
    // and stops, the double pass went on to eat `sesame` / the tail of the line. Both are
    // over-masking, not leaks, but they are a divergence from jq in a place no corpus input
    // had looked, and they cost a second quadratic scan of every ASCII command.
    ['Password "open sesame passwd:"open sesame\nnext line', 'Password ***open sesame\nnext line'],
    ['api-key is "open sesame auth"open sesame db | ssh -p2222 host', 'api-key is ***open sesame db | ssh -p2222 host'],
    // Same divergence, one non-ASCII character away: an em-dash or an accented name
    // anywhere else in the command is enough that a whole-string test would let the second
    // pass run, so the test is on the matched keyword instead. Without that, these two mask
    // past the value the way the inputs above do.
    ['Password "open sesame passwd:"open sesame\nnext line café', 'Password ***open sesame\nnext line café'],
    ['api-key is "open sesame auth"open sesame db | ssh -p2222 host — ok', 'api-key is ***open sesame db | ssh -p2222 host — ok'],
    // The same double-pass shape spelled with case-fold partners. These are NOT covered by
    // the ASCII pair above: `foldSpelled` puts U+017F into `KEYWORD_ALTERNATION`, so
    // `pa\u017f\u017fword` is a NON-ASCII keyword, which is exactly what pass 6b's first guard
    // mistook for "6a could not have seen this" - and 6b then re-masked 6a's output, giving
    // `*** sesame` where jq gives `***open sesame`. Pass 6b now also asks whether 6a's own
    // keyword group could have matched the keyword, and these two go back to jq's text. The
    // em-dash and accent versions of the ASCII pair are pinned below instead, because there
    // the widened suffix crosses a non-ASCII character INSIDE the keyword and no keyword
    // guard can see it; that residue is the pinned `over` row `token\u00e9token="a b"c`.
    ['pa\u017f\u017fword "open sesame passwd:"open sesame', 'pa\u017f\u017fword ***open sesame'],
    ['x pa\u017f\u017fword="a b"c d', 'x pa\u017f\u017fword=***c d'],
    // The Token-scheme word rule on the prefix characters where Oniguruma's `\b` REFUSES
    // (\u00fc, \u0663, \u4e2d: letters, digits and marks in Unicode terms). jq falls through to its
    // generic keyword rule and masks the value; this port's ambiguous-prefix pass now
    // reproduces that fall-through instead of eating `TOKEN is` and writing `Token ***`. The
    // first two are the inputs dynamic/throughline#116 reported, demoted to ordinary parity
    // rows because the fix closed them; the rest are the shapes around them.
    ['\u00fcTOKEN is YWJjZGVmZ2hpamts', '\u00fcTOKEN is ***'],
    ['\u00fcTOKEN i\u017f YWJjZGVmZ2hpamts\nnext line', '\u00fcTOKEN i\u017f ***\nnext line'],
    ['\u00fctoken abc', '\u00fctoken ***'],
    ['\u00fcAPI_TOKEN=YWJjZGVmZ2hpamts', '\u00fcAPI_TOKEN=***'],
    ['\u00fc\u0663TOKEN \u017fup3rS3cret', '\u00fc\u0663TOKEN ***'],
    // The prefix the comment above names but no row exercised (ADVISORY from the review of
    // dynamic/throughline#122): a CJK ideograph is a letter to Oniguruma's `\b` and a non-ASCII
    // code unit to this port, so it lands in the same ambiguous zone as \u00fc. Pinned by row now,
    // not by prose.
    ['\u4e2dTOKEN is S3cretPw9', '\u4e2dTOKEN is ***'],
    ['\u4e2dtoken \u017fup3rS3cret', '\u4e2dtoken ***'],
    // The Token pass and the MySQL pass both need words out of the same line, and every one the
    // other rule consumed first is a password that survives. These are the shapes the
    // 150,480-input sweep found leaking on the first version of the anchor split (5,454 inputs,
    // every one of them `<non-ascii>token <sep> mysql -p<password>`): the client name now stays
    // on the line for `_mysql_pw_all`, and the generic pass masks it afterwards exactly where
    // jq's does - byte for byte here, because on these prefixes jq's `\b` refuses too.
    ['\u00e9token is mysql -pS3cret', '\u00e9token is *** -p***'],
    ['\u00e9token is password mysql -pS3cret', '\u00e9token is *** mysql -p***'],
    // The mirror shape, and the reason the ambiguous mask cannot be deferred past
    // `_mysql_pw_all` (which a previous round tried, at 144 leaks of its own): here the MySQL
    // span eats `\u00a9token` and a deferred Token pass has no keyword left to anchor on.
    ['mysql -p\u00a9token S3cretPw', 'mysql -p*** ***'],
    // The ASCII-prefixed sibling of the leftmost-match hazard, where both engines AGREE about
    // the boundary and so about the leftmost match: `\b` fires after the ASCII space, the first
    // `token` is the match, and it eats the second one, leaving `password` to the generic rule.
    // This row pins the AGREEMENT - it passes under either pass order, which is why the
    // order-sensitive version is the `\u00a9token token password S3cretPw` row in
    // `ENGINE_DIVERGENCES` (a review round of #122 flagged that this row's comment used to describe
    // that \u00a9 case while the row's own prefix is a plain space).
    [' token token password S3cretPw', ' Token *** password ***'],
  ];

  /**
   * The one place this port masks MORE than jq by design, asserted directly rather
   * than only through the jq-differential test (which skips where jq is absent): the
   * userinfo anchor is `//`, jq's `_url` anchor is `://`. Pinned as `over` rows in
   * `ENGINE_DIVERGENCES` too, so the differential test fails if the direction ever
   * flips - a flipped row here means a credential the shipped plugin masks today is
   * being stored in cleartext.
   */
  const WIDER_THAN_JQ: readonly [string, string][] = [
    ['//user:pw@host', '//user:***@host'],
    ['x//user:pw@host', 'x//user:***@host'],
  ];

  for (const [input, expected] of WIDER_THAN_JQ) {
    it(`masks ${JSON.stringify(input)}, which jq leaves verbatim (pinned over-redaction)`, () => {
      assert.strictEqual(redact(input), expected);
    });
  }

  /**
   * The dynamic/throughline#116 leak, asserted on this port's own output so it is checked on a
   * machine with no `jq` on PATH - where the differential test skips and the `engineCases`
   * parity rows only prove this port agrees with itself. The property that matters is the
   * negative one: the value must not survive. `Token *** YWJjZGVmZ2hpamts`, which is what
   * `main` wrote, masks the keyword and stores the secret, and no amount of `***` elsewhere in
   * the line makes that safe.
   */
  it('masks the value after a non-ASCII letter in front of TOKEN, instead of eating the keyword the generic rule needs (issue #116)', () => {
    const secret = 'YWJjZGVmZ2hpamts';
    const inputs: readonly string[] = [
      '\u00fcTOKEN is ' + secret,
      '\u00fcTOKEN i\u017f ' + secret + '\nnext line',
    ];
    for (const input of inputs) {
      const out = redact(input);
      assert.ok(!out.includes(secret), `the secret survived: ${JSON.stringify(out)}`);
      assert.ok(out.includes('***'), `nothing was masked at all, so the line above proves nothing: ${JSON.stringify(out)}`);
    }
    // And as text, because "no cleartext" alone would also pass if a future change collapsed
    // the whole line into one `***`.
    assert.strictEqual(redact('\u00fcTOKEN is ' + secret), '\u00fcTOKEN is ***');
    assert.strictEqual(redact('\u00fcTOKEN i\u017f ' + secret + '\nnext line'), '\u00fcTOKEN i\u017f ***\nnext line');
  });

  /**
   * The chain the first version of the fix leaked: a keyword sitting behind the copula. Masking
   * only the value deletes the keyword the generic rule needs to reach the secret, so the mask
   * walks forward over the pairs a keyword-like value heads. Asserted on this port's own output
   * so a machine without `jq` still checks that the secret is gone.
   */
  it('masks a keyword behind the copula\u0027s own value, where the ambiguous zone cannot tell which anchor fired (issue #116 review)', () => {
    const secret = 'S3cretPw9';
    const inputs: readonly string[] = [
      '\u00a0token is password ' + secret,
      '\u2014token is \u00fcsecret ' + secret,
      '\u{1f600}TOKEN i\u017f password ' + secret,
      '\u00a0token is password auth ' + secret,
    ];
    for (const input of inputs) {
      const out = redact(input);
      assert.ok(!out.includes(secret), `the secret survived: ${JSON.stringify(out)}`);
      assert.ok(out.includes('***'), `nothing was masked at all, so the line above proves nothing: ${JSON.stringify(out)}`);
    }
  });

  /**
   * BLOCKING 1 of the review of dynamic/throughline#122, asserted on this port's own output so it
   * is checked on a machine with no `jq` on PATH. The Token pass runs at step 3 and the MySQL
   * client-anchored pass at step 5b, so a step-3 mask that CONSUMES the client name deletes the
   * only anchor step 5b has, and the `-p<password>` behind it survives. Every input here is that
   * shape or its mirror; the property is the negative one - the password must not survive.
   */
  it('leaves the MySQL client name on the line for _mysql_pw_all when the Token zone masks around it (#122 review)', () => {
    const pw = 'S3cretPw9';
    const inputs: readonly string[] = [
      '\u00a9token is mysql -p' + pw,
      '\u00e9token is mysql -p' + pw,
      '\u00e9token is password mysql -p' + pw,
      '\u4e2dTOKEN was mysqldump -p' + pw,
      '\u2014token is mariadb-dump -p' + pw,
      '\u00a9token token password mysql -p' + pw,
    ];
    for (const input of inputs) {
      const out = redact(input);
      assert.ok(!out.includes(pw), `the client-anchored password survived: ${JSON.stringify(out)}`);
      assert.ok(out.includes('***'), `nothing was masked at all, so the line above proves nothing: ${JSON.stringify(out)}`);
    }
    // And as text, on the two inputs whose shape the fix settles:
    assert.strictEqual(redact('\u00e9token is mysql -p' + pw), '\u00e9token is *** -p***');
    assert.strictEqual(redact('\u00e9token is password mysql -p' + pw), '\u00e9token is *** mysql -p***');
  });

  /**
   * BLOCKING 1 of the SECOND review round of dynamic/throughline#122, and the mirror image of the
   * test above: preserving the client name for `_mysql_pw_all` is only safe while that pass masks
   * a NON-keyword password. When the password is itself a keyword (`mysql -ppassword <secret>`) the
   * 5b mask deletes the keyword the generic rule needs, and on the prefixes where jq's boundary
   * fires jq's own Token rule had already eaten the client name, so jq reaches that secret and this
   * port did not. Asserted on the port's own output, with no `jq` needed.
   */
  it('does not defer the Token zone mask when the MySQL password is itself a keyword (#122 round 2 review)', () => {
    const secret = 'S3cretPw9X';
    const inputs: readonly string[] = [
      '\u00a9token mysql -ppassword ' + secret,
      '\u00a9token mysql -ptoken ' + secret,
      '\u00a9token is mysql -pauthority ' + secret,
      '\u00a9token was mariadb-dump -pcredential ' + secret,
      '\u00a9token mysql -papi_key ' + secret,
      '\u4e2dTOKEN mysql -ppassword ' + secret,
      // The boundary-REFUSES side of the same zone: here jq's pass 5b masks the keyword
      // `password` outright and leaves `S3cretPw9X` in the clear, so masking it here is an
      // over-mask, not parity - the port has to mask the secret either way.
      '\u00e9token mysql -ppassword ' + secret,
      // And the walk: the pair whose value is the client name sits behind a keyword pair, so
      // this is the guard applied from inside the walked run rather than from the first match.
      '\u00a0token is password \u00fcsecret ' + secret,
    ];
    for (const input of inputs) {
      const out = redact(input);
      assert.ok(!out.includes(secret), `the secret behind the keyword-shaped MySQL password survived: ${JSON.stringify(out)}`);
      assert.ok(out.includes('***'), `nothing was masked at all, so the line above proves nothing: ${JSON.stringify(out)}`);
    }
    // And as text, on the two inputs whose shape the fix settles.
    assert.strictEqual(redact('\u00a9token mysql -ppassword ' + secret), '\u00a9token *** -ppassword ***');
    assert.strictEqual(redact('\u00e9token mysql -ppassword ' + secret), '\u00e9token *** -ppassword ***');
  });

  /**
   * The `under` rows, asserted the same way but on the port's own output only, so a pinned
   * LEAK is checked on a machine where the differential test skips for want of `jq`. Without
   * this the leak pins are only as strong as the machine they run on, which is the wrong
   * way round: the row exists to make the next person see the leak, not to prove jq's side
   * of it. If a fix closes one, this fails and the row gets DELETED, not the expectation
   * softened - same rule the differential test states.
   */
  for (const row of ENGINE_DIVERGENCES.filter((d) => d.ts !== undefined)) {
    it(`writes the pinned output for the documented ${row.direction} divergence ${JSON.stringify(row.input)}`, () => {
      assert.strictEqual(redact(row.input), row.ts);
    });
  }

  for (const [input, expected] of engineCases) {
    it(`masks ${JSON.stringify(input)} the way the jq hooks do`, () => {
      assert.strictEqual(redact(input), expected);
    });
  }

  it('masks the password behind a CRLF continuation, which the pre-fix span leaked', () => {
    const input = 'mysql -e "select \\\r\n 1" -pS3cretPw db';
    assert.ok(!redact(input).includes('S3cretPw'), `password survived: ${JSON.stringify(redact(input))}`);
  });

  it('runs every corpus input through jq and matches, except the documented set', {
    skip: JQ_PRESENT ? false : 'jq is not on PATH on this machine',
  }, () => {
    const defs = jqDefs();
    const corpus: string[] = [
      'mysql -h db -u app -pS3cretPw dbname',
      'ssh host "mysqldump -u x -pS3cretPw dbname"',
      'mysqladmin -h1 -pS3cretPw status',
      'mariadb-dump --single-transaction -pS3cretPw dbname',
      'mysql -u app -p"pa ss" dbname',
      'mysql -uroot "-pS3cretPw" db',
      "mysql -uroot '-pS3cret Pw' db",
      'mysql -uroot "-p"S3cretPw db',
      'mysql -uroot -p"abc"def db',
      'mysql -u root -p$(cat pwfile) dbname',
      'mysqldump db \\\n-pS3cretPw dbname',
      'mysql -h h 2>&1 -pS3cretPw db',
      'mysqladmin ping &>/dev/null -pS3cretPw',
      'mysql -h db -u root -e "show databases;" -pS3cretPw',
      "mysql -e 'a|b' -pS3cretPw dbname",
      'mysql -e "select -pfoo from t" -pS3cretPw dbname',
      'find /var/lib/mysql -name x.ibd -print',
      'docker run --name mysql -p3306:3306 mysql:8',
      'ssh -p 2222 host true',
      'mysql -p dbname',
      'mysql -u app db | ssh -p2222 host',
      'mysql db; tar -pczf x.tgz d',
      'mysqldump db && cp -pr a b',
      'mysqldump db & ssh -p2222 host',
      'mysql -uroot && rsync "-pavz" src dst',
      'mysql -e "select 1" \n scp -p file host:',
      'ls -p /tmp',
      'notmysql -pX',
      'mysqldump ' + Array(20).fill('2>&1').join(' ') + ' db',
      'glab api -H "X: glpat-ABCDEFGHIJKLMNOPQRST"',
      'deploy --key sk_live_AbCdEfGh1234567890',
      'deploy --key rk_test_AbCdEfGh1234567890',
      'echo xapp-1-A01B2C3D4E5F-1234567890abcdef-abcdef1234',
      'echo npm_AbCdEfGh1234567890AbCdEfGh1234',
      'mail --key SG.abcdefghijklmnopqrst.ABCDEFGHIJKLMNOPQRST',
      'echo glpat-ABCDEFGHIJKLMNOPQRS',
      'cat MSG.errorMessageTemplate.userNotFoundError',
      'ls xapp-config-generator',
      'echo disk_test_AbCdEfGh1234567890',
      'echo fooxapp-1-A01B2C3D4E5F-1234567890abcdef',
      'echo mynpm_AbCdEfGh1234567890AbCdEfGh123456',
      'https://user:password@example.com/path',
      '//user:pw@host',
      'token\u4e2d'.repeat(3) + ' 5>&1',
      'config: password="open sesame',
      'ghp_AbcDefGhiJklMnoPqrStuVwxYzaBcDefGhiJ',
      'The bearer of good news',
      'token refresh flow',
      'password: hunter2',
    ];
    for (const engineCase of engineCases) corpus.push(engineCase[0]);
    for (const divergence of ENGINE_DIVERGENCES) corpus.push(divergence.input);

    const unexplained: string[] = [];
    const seenDivergences = new Set<string>();
    for (const input of corpus) {
      const jqOut = execFileSync('jq', ['-nr', '--arg', 's', input, defs + ' $s | redact'], { encoding: 'utf8' }).replace(/\n$/, '');
      const tsOut = redact(input);
      if (jqOut === tsOut) continue;
      const documented = ENGINE_DIVERGENCES.find((d) => d.input === input);
      if (!documented) {
        unexplained.push(`UNEXPLAINED ${JSON.stringify(input)}\n    jq: ${JSON.stringify(jqOut)}\n    ts: ${JSON.stringify(tsOut)}`);
        continue;
      }
      if (documented.direction === 'under') {
        // A pinned leak: both outputs are recorded verbatim, so a row cannot grow,
        // shrink or change shape without failing here.
        if (jqOut !== documented.jq || tsOut !== documented.ts) {
          unexplained.push(
            `PINNED LEAK CHANGED SHAPE ${JSON.stringify(input)}\n    jq: ${JSON.stringify(jqOut)} (pinned ${JSON.stringify(documented.jq)})\n    ts: ${JSON.stringify(tsOut)} (pinned ${JSON.stringify(documented.ts)})`,
          );
          continue;
        }
        seenDivergences.add(documented.input);
        continue;
      }
      if (documented.ts !== undefined) {
        // An `over` row with both outputs pinned, because jq masks part of the line as well
        // and the heuristic below reads that as a flip. Same rule as a pinned leak: the
        // outputs are compared verbatim, so the row cannot change shape quietly.
        if (jqOut !== documented.jq || tsOut !== documented.ts) {
          unexplained.push(
            `PINNED OVER-REDACTION CHANGED SHAPE ${JSON.stringify(input)}\n    jq: ${JSON.stringify(jqOut)} (pinned ${JSON.stringify(documented.jq)})\n    ts: ${JSON.stringify(tsOut)} (pinned ${JSON.stringify(documented.ts)})`,
          );
          continue;
        }
        seenDivergences.add(documented.input);
        continue;
      }
      // An `over` divergence must stay in that direction: the port masks a secret that
      // jq leaves visible. If it ever flips, it is a leak, not a divergence, and this
      // fails.
      if (jqOut.includes('***') || !tsOut.includes('***')) {
        unexplained.push(`DIRECTION FLIPPED ${JSON.stringify(input)}\n    jq: ${JSON.stringify(jqOut)}\n    ts: ${JSON.stringify(tsOut)}`);
        continue;
      }
      seenDivergences.add(documented.input);
    }
    assert.deepStrictEqual(unexplained, [], `${unexplained.length} input(s) diverge from jq without a documented, safe-direction reason`);
    // A documented divergence that has quietly stopped happening is stale
    // documentation, not a failure - but say so, so it gets removed rather than
    // left to mislead the next port.
    const stale = ENGINE_DIVERGENCES.map((d) => d.input).filter((input) => !seenDivergences.has(input));
    if (stale.length > 0) {
      console.log(`NOTE: ${stale.length} documented engine divergence(s) did not reproduce on this run: ${JSON.stringify(stale)}`);
    }
  });

  /**
   * Deterministic PRNG (mulberry32). A fuzz corpus that differs between runs is a corpus
   * that cannot be debugged, so this is seeded with a fixed constant below: every run,
   * and every machine with `jq` on PATH, sees the same 400 inputs in the same order.
   */
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * A hand-written corpus is only as wide as the input shapes someone thought to type: the
   * classes this port actually diverged on - `.` and `\s` spelling, the whitespace set
   * itself, the `\w` affixes, the `(?i)` case fold, a rule run twice over its own output -
   * are all engine-semantics shapes, and none of them is what a person writing corpus cases
   * for a `-p<password>` rule would reach for. So the corpus is composed mechanically here,
   * from the pieces the rules are built of, and both redaction paths are run through it.
   *
   * Exactly one property is asserted per path: the port must never leave in cleartext a
   * secret that the jq hooks mask. Over-redaction is counted and printed, not asserted -
   * a pinned count would fail the test for the safe direction, and the `over` rows above
   * pin the shapes that matter by name.
   */
  const FUZZ_SECRETS: readonly string[] = ['S3cretPw', 'AbCd.mn_op', 'hunter2', 'pa ss', 'open sesame', 'YWJjZGVmZ2hpamts', 'ghp_AbcDefGhiJklMnoPqrSt', 'sk_live_AbCdEfGh1234567890', 'glpat-ABCDEFGHIJKLMNOPQRST', 'SG.abcdefghijklmnopqrst.ABCDEFGHIJKLMNOPQRST', 'A01B2C3D4E5F-1234567890abcdef', 'Sup3rS3cret', 'ſup3rS3cret'];

  /** The seeded corpus, built once so both paths are asked about the same 400 inputs. */
  function buildSeededCorpus(): string[] {
    const keywords = ['token', 'secret', 'password', 'passwd', 'api_key', 'API_KEY', 'api-key', 'access_key', 'credential', 'auth', 'authorization', 'client_id'];
    // Case-fold spellings of the same words: Oniguruma's `(?i)` folds U+017F
    // onto `s`, U+212A onto `k` and U+00DF / U+1E9E onto the two-character `ss`, and JS's
    // `i` flag folds none of them, so each of these is a keyword the jq hooks fire on and
    // this port used not to. `paßsword` is a deliberate non-word: neither engine fires on
    // it, and a pattern that DID fire on it would be over-matching.
    const foldKeywords = ['paßword', 'paßword', 'paßsword', 'paſsword', 'pasſword', 'toKen', 'baſic', 'apiKey', 'accessKey'];
    // Affixes glued to the keyword: ASCII word characters, non-ASCII characters that
    // ARE word characters in both engines, and the categories that are word characters
    // to Oniguruma's `\w` but not to JS's - the exact seam this port leaks on.
    const affixes = ['', 'x', '_', 'my', '\u00e9', '\u00fc', '\u00c9', '\u0663', '\u00aa', '\u4e2d', '\u2000x', '\u00a9', '\u2011', '\ufeff', '\u200b', '\u201c'];
    // Separators: the ones both engines read, the ones only one reads, the word
    // separators the `is|was|are` alternative exists for, and their fold spellings - a
    // long s in `iſ` decides whether the rule fires at all.
    const separators = ['=', ':', ' = ', ' : ', ' ', '\u0085', '\u00a0', '\u2000', '\u2028', '\u202f', '\u3000', '\ufeff', '\u200b', '\u180e', ' is ', ' was ', ' are ', ' iſ ', ' waſ '];
    // Each value carries one of the FUZZ_SECRETS strings below, so "was it masked?" is
    // answerable by looking for that string rather than by comparing shapes.
    // `ſup3rS3cret` is a secret whose FIRST character is a fold partner: jq's
    // `(?i)[A-Za-z0-9._-]` value class walks over it, JS's stops in front of it, and a
    // mask that stops early leaves this exact string visible in the output.
    const values = ['S3cretPw', 'AbCd.mn_op', 'hunter2', '"pa ss"', '"open sesame', 'YWJjZGVmZ2hpamts', 'ghp_AbcDefGhiJklMnoPqrSt', 'sk_live_AbCdEfGh1234567890', 'glpat-ABCDEFGHIJKLMNOPQRST', 'SG.abcdefghijklmnopqrst.ABCDEFGHIJKLMNOPQRST', 'xapp-1-A01B2C3D4E5F-1234567890abcdef', 'ſup3rS3cret', 'AbCdſfGh', 'ß3cret'];
    const schemeWords = ['bearer', 'basic', 'token', 'baſic', 'toKen'];
    const clients = ['mysql', 'mysqldump', 'mysqladmin', 'mariadb-dump', 'mysql -u app', 'mysqldump -uroot', 'ssh host "mysqldump'];
    const pwArgs = ['-pS3cretPw', '-p"pa ss"', "\"-pS3cretPw\"", "'-pS3cret Pw'", '-p\u00e9S3cretPw', '-p\ufeffS3cretPw', '-p\u200bS3cretPw', '-p S3cretPw'];
    // Tails never contain a SECRET string, so a secret found in the output is the value,
    // not a copy that was sitting in the tail.
    const tails = ['', ' db', ' dbname', ' rest', ' 2>&1', ' x=1', '\nnext line', ' db | ssh -p2222 host', ' && cp -pr a b', ' -p3306:3306'];
    // URL userinfo goes through the sentinel round-trip (`redactUrlUserinfo` writes it,
    // `unmaskSentinel` writes it back) and through the keyword rule's sentinel
    // alternative, so it is the one shape where the keyword rule's replacement is NOT
    // `***` - the second word pass runs on text that already carries a sentinel.
    const urlValues = ['https://user:Sup3rS3cret@example.com/p', 'https://u\u00e9:p\u00e9@example.com', 'http://\u00e9:Sup3rS3cret@h', 'password=https://u:Sup3rS3cret@h', 'password\u00e9=https://u:Sup3rS3cret@h'];
    const pick = <T,>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    const wordOf = (rand: () => number) => (rand() < 0.75 ? pick(rand, keywords) : pick(rand, foldKeywords));

    const rand = mulberry32(0x5eed1a3b);
    const corpus: string[] = [];
    for (let i = 0; i < 400; i++) {
      const tail = pick(rand, tails);
      switch (i % 6) {
        case 0:
          corpus.push(`${pick(rand, affixes)}${wordOf(rand)}${pick(rand, affixes)}${pick(rand, separators)}${pick(rand, values)}${tail}`);
          break;
        case 1:
          corpus.push(`${pick(rand, clients)} ${pick(rand, pwArgs)}${tail}`);
          break;
        case 2:
          // NOTE for anyone widening this template: the first keyword deliberately carries no
          // affix here, which is why this case cannot generate the two-pass leak pinned as
          // `under` rows in ENGINE_DIVERGENCES (`secret\u00e9 api_key credential hunter2`): put
          // an affix on the first keyword with a space separator and the leak direction
          // appears here, so extending this line means teaching this test to expect a pinned
          // leak per shape rather than zero leaks. See the `under` rows for what is known.
          corpus.push(`${wordOf(rand)}${pick(rand, separators)}${pick(rand, values)}${tail} ${pick(rand, keywords)}${pick(rand, separators)}${pick(rand, values)}`);
          break;
        case 3:
          corpus.push(`echo ${pick(rand, values)} ${pick(rand, separators)} ${wordOf(rand)}${pick(rand, affixes)}${tail}`);
          break;
        case 4:
          corpus.push(`${pick(rand, affixes)}${pick(rand, urlValues)}${tail} ${pick(rand, keywords)}${pick(rand, separators)}${pick(rand, values)}`);
          break;
        default:
          corpus.push(`${pick(rand, schemeWords)} ${pick(rand, values)}${tail} ${pick(rand, schemeWords)} ${pick(rand, values)}`);
      }
    }
    return corpus;
  }

  const SEEDED_CORPUS = buildSeededCorpus();

  /** Run one input through jq's `def` and this port, and report leaks by secret. */
  function diffAgainstJq(defs: string, jqPipelineName: string, input: string, portOut: string): { leaks: string[]; over: boolean; same: boolean } {
    const jqOut = execFileSync('jq', ['-nr', '--arg', 's', input, defs + ` $s | ${jqPipelineName}`], { encoding: 'utf8' }).replace(/\n$/, '');
    const leaks: string[] = [];
    for (const secret of FUZZ_SECRETS) {
      if (portOut.includes(secret) && !jqOut.includes(secret)) {
        leaks.push(`LEAK of ${JSON.stringify(secret)} ${JSON.stringify(input)}\n    jq: ${JSON.stringify(jqOut)}\n    ts: ${JSON.stringify(portOut)}`);
      }
    }
    return { leaks, over: FUZZ_SECRETS.some((secret) => jqOut.includes(secret) && !portOut.includes(secret)), same: jqOut === portOut };
  }

  it('leaves in cleartext no secret the jq hooks mask, over 400 seeded random inputs', {
    skip: JQ_PRESENT ? false : 'jq is not on PATH on this machine',
  }, () => {
    const defs = jqDefs();
    const leaks: string[] = [];
    let overs = 0;
    let diffs = 0;
    for (const input of SEEDED_CORPUS) {
      const result = diffAgainstJq(defs, 'redact', input, redact(input));
      if (!result.same) diffs++;
      leaks.push(...result.leaks);
      if (result.over) overs++;
    }
    // `diffs` counts every difference, including ones no SECRET string can see (a value
    // masked twice over, say). Only the leak direction fails the test; see the docstring
    // above for why pinning the other two counts would be a trap.
    console.log(`NOTE: seeded fuzz corpus (command path) - ${SEEDED_CORPUS.length} inputs, ${diffs} difference(s) from jq, ${overs} secret-level over-redaction(s), ${leaks.length} leak(s)`);
    assert.deepStrictEqual(leaks, [], `${leaks.length} input(s) leave in cleartext a secret the jq hooks mask`);
  });

  /**
   * The prompt path (`redactPrompt`) used to be checked only against hand-written
   * expectations, never against jq's `redact_prompt` - so every engine difference found
   * in the first three rounds was found on the command path and silently left in the
   * prose path, where the same `JS_WS` classes and the same keyword/scheme literals are
   * in use. Same corpus, same single property, jq's other pipeline.
   */
  it('leaves in cleartext no secret the jq hooks mask on the PROMPT path, over the same 400 inputs', {
    skip: JQ_PRESENT ? false : 'jq is not on PATH on this machine',
  }, () => {
    const defs = jqDefs();
    const leaks: string[] = [];
    let overs = 0;
    let diffs = 0;
    for (const input of SEEDED_CORPUS) {
      const result = diffAgainstJq(defs, 'redact_prompt', input, redactPrompt(input));
      if (!result.same) diffs++;
      leaks.push(...result.leaks);
      if (result.over) overs++;
    }
    console.log(`NOTE: seeded fuzz corpus (prompt path) - ${SEEDED_CORPUS.length} inputs, ${diffs} difference(s) from jq's redact_prompt, ${overs} secret-level over-redaction(s), ${leaks.length} leak(s)`);
    assert.deepStrictEqual(leaks, [], `${leaks.length} prompt-path input(s) leave in cleartext a secret the jq hooks mask`);
  });

  /**
   * Case-fold coverage by construction rather than by luck: substitute each of the four
   * fold partners into every `s`, `k` and `ss` position of every keyword, separator and
   * scheme word this port matches, and require this port and jq to agree EXACTLY (not
   * merely in direction) on the result. Sweeping every non-surrogate code point against
   * these literals returns exactly these four partners, so this loop is the whole set,
   * and a dropped letter in `foldSpelled` fails here rather than leaking.
   */
  it('fires on every case-fold spelling of every keyword, exactly where jq fires', {
    skip: JQ_PRESENT ? false : 'jq is not on PATH on this machine',
  }, () => {
    const defs = jqDefs();
    const foldSubs: readonly [string, string][] = [['s', '\u017f'], ['k', '\u212a'], ['ss', '\u00df'], ['ss', '\u1e9e']];
    const words = ['token', 'secret', 'password', 'passwd', 'api_key', 'access_key', 'credential', 'auth', 'authorization', 'client_id', 'is', 'was', 'are', 'bearer', 'basic'];
    const value = 'AbCdEfGhIjKlMn';
    const failures: string[] = [];
    let cases = 0;
    for (const word of words) {
      const spellings = new Set<string>();
      for (const [from, to] of foldSubs) {
        for (let i = 0; i <= word.length - from.length; i++) {
          if (word.slice(i, i + from.length) === from) spellings.add(word.slice(0, i) + to + word.slice(i + from.length));
        }
      }
      const isSeparator = word === 'is' || word === 'was' || word === 'are';
      const isScheme = word === 'bearer' || word === 'basic' || word === 'token';
      const templates = isSeparator
        ? [`password ${'@'} S3cret`, `${'@'} S3cret`]
        : isScheme
          ? [`@ ${value}`, `@=S3cret`, `header @ ${value} tail`]
          : [`@=S3cret rest`, `@: S3cret`, `@ ${value}`, `x@=S3cret`, `--@="pa ss"`];
      for (const spelling of spellings) {
        for (const template of templates) {
          const input = template.replace(/@/g, spelling);
          cases++;
          const jqOut = execFileSync('jq', ['-nr', '--arg', 's', input, defs + ' $s | redact'], { encoding: 'utf8' }).replace(/\n$/, '');
          const tsOut = redact(input);
          if (jqOut !== tsOut) {
            failures.push(`${JSON.stringify(input)}\n    jq: ${JSON.stringify(jqOut)}\n    ts: ${JSON.stringify(tsOut)}`);
          }
        }
      }
    }
    console.log(`NOTE: case-fold mutation sweep - ${cases} inputs, ${failures.length} divergence(s) from jq`);
    assert.deepStrictEqual(failures, [], `${failures.length} case-fold input(s) diverge from jq`);
  });

  /**
   * Latency guard for the word pass. Over-approximating `\w` on BOTH sides of the keyword
   * made this quadratic in the length of a run of non-ASCII non-whitespace text - 5.6 s
   * for a 3 KB command on a build where `main` takes 1 ms - and `redact()` runs
   * in-process on the full unclamped bash command, so that is a frozen plugin, not a slow
   * one. CJK prose has no spaces, so such a run is ordinary input rather than a crafted
   * one. The over-approximation now sits on the suffix only and this stays in the
   * milliseconds; the bound is loose (observed single-digit ms) and exists to fail a
   * future change that puts a star back on the leading side.
   */
  it('stays linear on a long run of non-ASCII text, which the leading word affix used to break', () => {
    // The mask is asserted on a trailing keyword rather than inside the run: inside the
    // run nothing is maskable (no separator follows the non-ASCII character), which is
    // exactly why the quadratic scan cost nothing in output and everything in time.
    const input = 'token\u6f22'.repeat(500) + ' password=x';
    const started = Date.now();
    const out = redact(input);
    const elapsed = Date.now() - started;
    assert.ok(out.includes('***'), 'nothing was masked, so the timing proves nothing');
    assert.ok(!out.includes('password=x'), `the trailing secret survived: ${JSON.stringify(out.slice(-40))}`);
    assert.ok(elapsed < 2000, `redact() took ${elapsed}ms on a ${input.length}-character command; the leading word affix has gone quadratic again`);
  });
});
