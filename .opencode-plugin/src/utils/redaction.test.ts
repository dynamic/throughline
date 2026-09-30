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
// Regex-ENGINE parity, not just rule-text parity (issue #90, review round 1)
// ---------------------------------------------------------------------------

/**
 * The parity suite above compares pattern TEXT, which cannot see the case that
 * matters most: JS and Oniguruma read the *same* text differently. JS `.` also
 * refuses CR, JS `\s` additionally matches U+FEFF, and JS `\b` is not
 * Unicode-aware. The first two are fixed by spelling the rule out (see
 * `JS_NOT_WS` / the `[ ^\n]` step in `redaction.ts` and `ENGINE_SPELLINGS` here);
 * the third is left as a documented divergence. This suite pins all of it, and
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
 * fires wherever jq fires and leaves a residue only on the masking side - safe because
 * that rule is the last masking step, so a longer keyword group cannot eat a keyword a
 * later rule needed. The `over` rows below are that residue: a non-ASCII character
 * jq's `\w` refuses and the port's over-approximation accepts. `under` rows are all
 * `\b`-anchored.
 *
 * So each row below says which engine masks more, and the differential test asserts
 * that row rather than assuming a direction. `over` = the port masks a command jq
 * leaves visible (no secret escapes). `under` = jq masks a secret the port leaves in
 * cleartext: a LEAK, with both outputs pinned verbatim so it cannot grow quietly, in
 * shape or in count. A later round that closes one must DELETE its row, not soften it.
 */
const ENGINE_DIVERGENCES: readonly {
  input: string;
  direction: 'over' | 'under';
  note: string;
  /** `under` rows only: the two outputs, pinned. */
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
    // the extra mask swallows.
    input: '\u00e9SG.abcdefghijklmnopqrst.ABCDEFGHIJKLMNOPQRSTpassword=S3cret',
    direction: 'under',
    jq: '\u00e9SG.abcdefghijklmnopqrst.ABCDEFGHIJKLMNOPQRSTpassword=***',
    ts: '\u00e9SG.***=S3cret',
    note: 'LEAK: the port anchors on \u00e9 and the SendGrid token class swallows the following `password`, so the generic keyword rule never fires and `S3cret` survives. jq anchors nowhere and masks `password=S3cret` instead.',
  },
  {
    input: '\u00e9mysql -pxtoken abcS3cret',
    direction: 'under',
    jq: '\u00e9mysql -pxtoken ***',
    ts: '\u00e9mysql -p*** abcS3cret',
    note: 'LEAK: the port anchors on \u00e9 and the MySQL span eats `token`, so the token-word rule never fires and `abcS3cret` survives. Same mechanism as the row above, different rule order.',
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
];

function jqIsUsable(): boolean {
  try {
    execFileSync('jq', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const JQ_PRESENT = jqIsUsable();

describe('regex-engine parity with jq (issue #90 review round 1)', () => {
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
    // The `\w` affixes of the generic keyword rule (issue #90 review round 3, the
    // finding at head ef21e30): Oniguruma's `\w*` walks over a non-ASCII letter, JS's
    // stops there, the separator alternatives cannot match a letter, and the rule never
    // fires at all - the secret was stored whole. These are the review's minimal repros
    // with jq's own outputs; the affixes are now `JS_WORD_STAR`, which fires wherever
    // jq does. Note the last two: one accented letter after the keyword, no other rule
    // involved, and the previous round's record claimed no such leak existed.
    ['password\u00e9=S3cret', 'password\u00e9=***'],
    ['export DB_PASSWORD_\u00c9=S3cret', 'export DB_PASSWORD_\u00c9=***'],
    ['secret\u0663=S3cret', 'secret\u0663=***'],
    ['api_key\u00aa: S3cret', 'api_key\u00aa: ***'],
    ['token\u00fc abcS3cret', 'token\u00fc ***'],
    // URL userinfo: a BOM inside the userinfo used to end the match, so the rule did
    // not fire and the password was never masked at all.
    ['https://user\ufeffname:pass\ufeffword@host', 'https://user\ufeffname:***@host'],
    ['https://user\u0085name:pass\u0085word@host', 'https://user\u0085name:pass\u0085word@host'],
  ];

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
   * Every round of review on this port found a class the hand-written corpus did not
   * contain: round 1 the `.` and `\s` spellings, round 2 the whitespace set itself,
   * round 3 the `\w` affixes - in each case an input shape nobody had typed out by hand,
   * and in each case the corpus was the reason the previous round could claim parity.
   * So the corpus is composed mechanically here, from the pieces the rules are built of.
   *
   * Exactly one property is asserted: the port must never leave in cleartext a secret
   * that the jq hooks mask. Over-redaction is counted and printed, not asserted - a
   * pinned count would fail the test for the safe direction, and the `over` rows above
   * pin the shapes that matter by name.
   */
  it('leaves in cleartext no secret the jq hooks mask, over 400 seeded random inputs', {
    skip: JQ_PRESENT ? false : 'jq is not on PATH on this machine',
  }, () => {
    const defs = jqDefs();
    const keywords = ['token', 'secret', 'password', 'passwd', 'api_key', 'API_KEY', 'api-key', 'access_key', 'credential', 'auth', 'authorization', 'client_id'];
    // Affixes glued to the keyword: ASCII word characters, non-ASCII characters that
    // ARE word characters in both engines, and the categories that are word characters
    // to Oniguruma's `\w` but not to JS's - the exact seam this port leaks on.
    const affixes = ['', 'x', '_', 'my', '\u00e9', '\u00fc', '\u00c9', '\u0663', '\u00aa', '\u4e2d', '\u2000x', '\u00a9', '\u2011', '\ufeff', '\u200b', '\u201c'];
    // Separators: the ones both engines read, the ones only one reads, and the word
    // separators the `is|was|are` alternative exists for.
    const separators = ['=', ':', ' = ', ' : ', ' ', '\u0085', '\u00a0', '\u2000', '\u2028', '\u202f', '\u3000', '\ufeff', '\u200b', '\u180e', ' is ', ' was ', ' are '];
    // Each value carries one of the SECRET strings below, so "was it masked?" is
    // answerable by looking for that string rather than by comparing shapes.
    const values = ['S3cretPw', 'AbCd.mn_op', 'hunter2', '"pa ss"', '"open sesame', 'YWJjZGVmZ2hpamts', 'ghp_AbcDefGhiJklMnoPqrSt', 'sk_live_AbCdEfGh1234567890', 'glpat-ABCDEFGHIJKLMNOPQRST', 'SG.abcdefghijklmnopqrst.ABCDEFGHIJKLMNOPQRST', 'xapp-1-A01B2C3D4E5F-1234567890abcdef'];
    const secrets = ['S3cretPw', 'AbCd.mn_op', 'hunter2', 'pa ss', 'open sesame', 'YWJjZGVmZ2hpamts', 'ghp_AbcDefGhiJklMnoPqrSt', 'sk_live_AbCdEfGh1234567890', 'glpat-ABCDEFGHIJKLMNOPQRST', 'SG.abcdefghijklmnopqrst.ABCDEFGHIJKLMNOPQRST', 'A01B2C3D4E5F-1234567890abcdef', 'Sup3rS3cret'];
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

    const rand = mulberry32(0x5eed1a3b);
    const corpus: string[] = [];
    for (let i = 0; i < 400; i++) {
      const tail = pick(rand, tails);
      switch (i % 5) {
        case 0:
          corpus.push(`${pick(rand, affixes)}${pick(rand, keywords)}${pick(rand, affixes)}${pick(rand, separators)}${pick(rand, values)}${tail}`);
          break;
        case 1:
          corpus.push(`${pick(rand, clients)} ${pick(rand, pwArgs)}${tail}`);
          break;
        case 2:
          corpus.push(`${pick(rand, keywords)}${pick(rand, separators)}${pick(rand, values)}${tail} ${pick(rand, keywords)}${pick(rand, separators)}${pick(rand, values)}`);
          break;
        case 3:
          corpus.push(`echo ${pick(rand, values)} ${pick(rand, separators)} ${pick(rand, keywords)}${pick(rand, affixes)}${tail}`);
          break;
        default:
          corpus.push(`${pick(rand, affixes)}${pick(rand, urlValues)}${tail} ${pick(rand, keywords)}${pick(rand, separators)}${pick(rand, values)}`);
      }
    }

    const leaks: string[] = [];
    let overs = 0;
    let diffs = 0;
    for (const input of corpus) {
      const jqOut = execFileSync('jq', ['-nr', '--arg', 's', input, defs + ' $s | redact'], { encoding: 'utf8' }).replace(/\n$/, '');
      const tsOut = redact(input);
      if (jqOut === tsOut) continue;
      diffs++;
      for (const secret of secrets) {
        if (tsOut.includes(secret) && !jqOut.includes(secret)) {
          leaks.push(`LEAK of ${JSON.stringify(secret)} ${JSON.stringify(input)}\n    jq: ${JSON.stringify(jqOut)}\n    ts: ${JSON.stringify(tsOut)}`);
        }
      }
      if (secrets.some((secret) => jqOut.includes(secret) && !tsOut.includes(secret))) overs++;
    }
    // `diffs` counts every difference, including ones no SECRET string can see (a value
    // masked twice over, say). Only the leak direction fails the test; see the docstring
    // above for why pinning the other two counts would be a trap.
    console.log(`NOTE: seeded fuzz corpus - ${corpus.length} inputs, ${diffs} difference(s) from jq, ${overs} secret-level over-redaction(s), ${leaks.length} leak(s)`);
    assert.deepStrictEqual(leaks, [], `${leaks.length} input(s) leave in cleartext a secret the jq hooks mask`);
  });
});
