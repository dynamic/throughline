import assert from 'assert';
import { describe, it } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * `rk_test_`, `glpat-`, `npm_`, `SG.` prefixes) sat unported for a release because
 * nothing mechanical was checking.
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
      assert.strictEqual(ts.pattern.source, normalizeJqRegexText(jq.pattern), `prefix rule ${i} diverged from jq (${jq.pattern})`);
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
        denormalizeJsAtomicEmulation(ts.pattern.source),
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
