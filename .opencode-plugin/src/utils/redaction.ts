/**
 * throughline — redaction logic for OpenCode plugin.
 *
 * This file is a HAND PORT of the jq redaction defs in `hooks/_lib.sh`
 * (`tl_jq_redact_defs`). Two modes:
 *   - redact(): command-path redaction (aggressive, for tool outputs)
 *   - redactPrompt(): prose-safe redaction (conservative, for user prompts)
 *
 * The command path uses aggressive keyword matching that can corrupt natural
 * language (e.g., "bearer of good news" → "Bearer ***"). The prompt path
 * uses only structural patterns that never false-positive on English.
 *
 * SYNC IS MECHANICAL, NOT HONESTY-BASED (issue #90): the rule tables below are
 * ordered and spelled to match their jq counterparts one row at a time, and
 * `redaction.test.ts` parses `hooks/_lib.sh` and fails if a rule is added,
 * removed, reordered or edited on the jq side without being ported here. That
 * test, not this comment, is what keeps the two in step — the drift it exists
 * to catch is exactly what happened with the issue #81 rules, which landed on
 * the jq side and sat unported here for a whole release.
 *
 * Oniguruma-to-JS differences the port has to work around (both noted at the
 * rule that needs them, so the tables stay comparable line by line):
 *   - JS has no atomic group `(?>…)`. The MySQL span emulates one with the
 *     standard `(?=(?<name>X))\k<name>` lookahead-and-backreference form, which
 *     commits each span step the same way and keeps a long run of `N>&M`
 *     redirects linear instead of exponential.
 *   - jq's `\(.name)` replacement interpolation is JS's `$<name>`.
 *
 * `.omp-plugin` is NOT affected by any of this: its shim shells out to the same
 * `hooks/*.sh` scripts, so it inherits the jq rules directly.
 */

// --- Constants ---

/** Sentinel for URL userinfo redaction (prevents generic rules from over-masking) */
const REDACT_SENTINEL = "TLREDACTSENTINEL";

// --- Structural patterns (safe for both command and prompt paths) ---

/**
 * Match PEM private keys.
 */
const PEM_REGEX = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const PEM_INCOMPLETE_REGEX = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g;

/**
 * Match URL userinfo (user:pass@host).
 * Sets sentinel to prevent generic rules from consuming past the @.
 */
function redactUrlUserinfo(str: string): string {
  return str.replace(/(\/\/[^:@/\s]+):([^@/\s]+)@/g, `$1:${REDACT_SENTINEL}@`);
}

/**
 * One redaction rule: a pattern plus the replacement text it maps to. This is
 * the smallest shape that can be compared row-by-row against the jq `gsub` defs
 * in `_lib.sh`, which is what the parity test in `redaction.test.ts` does — the
 * previous shape (an array of patterns with the replacement strings hard-coded
 * at each call site) could not be diffed against jq at all.
 */
export interface RedactionRule {
  /** Short name matching the jq `def` name, for test output. */
  name: string;
  pattern: RegExp;
  replacement: string;
}

/**
 * Well-known vendor token prefixes. One row per `gsub` in jq's `_prefix_tokens`,
 * IN THE SAME ORDER and with the SAME pattern text — the parity test asserts
 * that. Order matters: `xox` before `xapp`, and the plain `sk-` rule before the
 * `sk_live_`/`rk_test_` rule, so a token is consumed by the narrowest rule that
 * jq would let match it.
 *
 * The #81 additions are LEFT-ANCHORED with `(?<![A-Za-z0-9_])` rather than `\b`
 * (underscore is a word character, so `\b` gives no boundary between `disk` and
 * `_test_`, which is how `disk_test_…` used to read as a Stripe key) except
 * `SG.`, which can use `\b` because it starts with a letter followed by a dot —
 * that is what keeps `MSG.errorMessageTemplate.userNotFoundError` intact.
 */
export const TOKEN_PREFIX_RULES: readonly RedactionRule[] = [
  { name: "ghp", pattern: /ghp_[A-Za-z0-9]{10,}/g, replacement: "ghp_***" },
  { name: "github_pat", pattern: /github_pat_[A-Za-z0-9_]{10,}/g, replacement: "github_pat_***" },
  { name: "gh_app", pattern: /gh[oprsu]_[A-Za-z0-9]{10,}/g, replacement: "gh_***" },
  { name: "xox", pattern: /xox[baprs]-[A-Za-z0-9-]{6,}/g, replacement: "xox-***" },
  { name: "xapp", pattern: /(?<![A-Za-z0-9_])xapp-[0-9]{1,2}-[A-Za-z0-9-]{10,}/g, replacement: "xapp-***" },
  { name: "sk_dash", pattern: /sk-[A-Za-z0-9_-]{10,}/g, replacement: "sk-***" },
  {
    name: "sk_underscore",
    pattern: /(?<t>(?<![A-Za-z0-9_])(?:sk|rk)_(?:live|test)_)[A-Za-z0-9]{16,}/g,
    // jq: "\(.t)***" — keeps the vendor prefix visible in the buffer.
    replacement: "$<t>***",
  },
  { name: "akia", pattern: /AKIA[0-9A-Z]{12,}/g, replacement: "AKIA***" },
  { name: "aiza", pattern: /AIza[0-9A-Za-z_\-]{35}/g, replacement: "AIza***" },
  { name: "glpat", pattern: /(?<![A-Za-z0-9_])glpat-[A-Za-z0-9_-]{20,}/g, replacement: "glpat-***" },
  { name: "npm", pattern: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{30,}/g, replacement: "npm_***" },
  { name: "sendgrid", pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, replacement: "SG.***" },
];

/**
 * Apply all token prefix redactions, in table order.
 */
function redactTokenPrefixes(str: string): string {
  let result = str;
  for (const rule of TOKEN_PREFIX_RULES) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}

// --- MySQL/MariaDB client-anchored `-p<password>` (command path only) ---

/**
 * Port of jq's `_mysql_anchor` / `_mysql_pw_*` defs (issue #81): `-p` is far too
 * overloaded to redact generically (a port, a parallel flag, a print flag), so
 * the rule is anchored on a MySQL/MariaDB CLIENT NAME earlier on the same line,
 * and the client-to-flag span may not cross an unquoted `|`, `;`, `&`, LF or CR.
 * Ported verbatim, including the documented false positives (`find /var/lib/mysql
 * … -print` and `docker run --name mysql -p3306:3306 …` do get masked) — those
 * are pinned by tests on the jq side precisely so a port cannot quietly "fix"
 * them into a leak. See the comments in `hooks/_lib.sh` for the reasoning; this
 * file deliberately does not restate it a second time to keep drifting.
 *
 * Command path ONLY, same as jq: `redactPrompt` does not run these, because a
 * span like this would swallow ordinary words after any sentence mentioning
 * mysql.
 */

/**
 * Characters that need no escaping inside a regex but would have to be escaped (or
 * would read as a template-literal terminator) in the JS string literals around
 * them: a backtick and a double quote. Spelled as escapes so the regex text below
 * contains the bare character exactly once and stays textually comparable to the
 * jq def it ports.
 */
const BT = "\u0060";
const DQ = '"';

/** Regex TEXT matching one literal backslash, for the alternative that steps over `\"`. */
const RE_BS = String.raw`\\`;

/**
 * Client-name anchor. jq: the head of `_mysql_anchor`. A client name that is not a
 * standalone word does not anchor (`notmysql -pX`), and neither does a versioned
 * name (`mysql5.7`); `mariadb-<suffix>` anchors as a prefix family, which is the
 * documented asymmetric over-match (`mariadb-10.6` does anchor).
 */
const MYSQL_CLIENT =
  String.raw`\b(?:` +
  String.raw`mysql(?:dump|admin|import|check|show|pump|binlog|slap|sh|_upgrade)?` +
  String.raw`|mariadb(?:-[a-z]+)?)\b`;

/**
 * One span step, one alternative per entry, in jq's order: a backslash-newline
 * continuation, bash's `&>`/`&>>` combined redirect (never a bare `&` or `&&`), an
 * `N>&M` fd redirect, any backslash-escaped char, an ordinary char that is not an
 * unquoted separator, a single-quoted run, and a double-quoted run that may carry
 * `\"`. Quoted runs are consumed WHOLE, which is what lets a `;` or `|` sitting
 * inside `-e "show databases;"` through while an unquoted one stays a hard stop.
 * jq: the atomic-group alternation inside `_mysql_anchor`.
 */
const MYSQL_SPAN_STEPS: readonly string[] = [
  String.raw`\\\r?\n`,
  String.raw`(?<!&)&>>?`,
  String.raw`[0-9]*>&[0-9]*`,
  String.raw`\\.`,
  String.raw`[^|;&\r\n'"]`,
  String.raw`'[^']*'`,
  String.raw`"(?:[^"\\]|\\.)*"`,
];
const MYSQL_SPAN_STEP = MYSQL_SPAN_STEPS.join("|");

/**
 * The span: `*?` over ATOMIC steps. jq writes this as an atomic group; JS has
 * none, so each step is a lookahead that commits to one alternative plus a
 * backreference consuming exactly what it committed to, which the outer `*?` can
 * never re-split. This is load-bearing, not decoration: every `N>&M` token has
 * several parses, and when no `-p` follows (the common case) a non-atomic span
 * tries them all - jq 1.7.1 hits Oniguruma's retry limit at 12 such tokens, and
 * `redaction.test.ts` pins the same shape here at 20.
 */
const MYSQL_SPAN = String.raw`(?:(?=(?<tlspan>` + MYSQL_SPAN_STEP + String.raw`))\k<tlspan>` + String.raw`)*?`;

/** Opens the `pre` group and the span; every pattern using it closes `pre`. */
const MYSQL_ANCHOR = String.raw`(?<pre>` + MYSQL_CLIENT + MYSQL_SPAN;

/**
 * Whitespace allowed between the span and the flag. jq: `_mysql_pw_lead`.
 * `[ \t]` and not `\s` on purpose: `\s` includes the newline itself, which let the
 * lead swallow a plain newline and mask a `-p` starting the NEXT line - the
 * opposite of the "a newline that does not continue the line is a hard stop" rule
 * the jq side pins. The two lookbehinds say "the span just stepped over a
 * backslash-newline", so a continuation line starting at column 0 still reaches
 * the flag (`mysqldump db \` newline `-p<pw> db`).
 */
const MYSQL_LEAD = String.raw`(?:[ \t]|(?<=\\\n)|(?<=\\\r\n))`;

/**
 * One compound value run: an alternation of the pieces that glue together into a
 * single shell argument, in jq's order - an escaped-quoted run (listed first so it
 * wins the backslash before the generic escaped-char alternative can eat it), a
 * `$(...)` substitution, a backtick run, a single- or double-quoted run, an escaped
 * char, an ordinary char. A RUN and not an alternation of whole values, because
 * these shapes glue together in real shells (`-p'abc'def`, `-p"pa ss"word`):
 * masking only the quoted part leaves the rest of the password in cleartext right
 * after the `***`, which is worse than an unmasked line because the mask makes the
 * line look handled. jq: `_mysql_pw_glue`.
 */
const MYSQL_GLUE_ALTS: readonly string[] = [
  RE_BS + DQ + String.raw`(?:[^"\\]|\\.)*` + RE_BS + DQ,
  String.raw`\$\([^)]*\)`,
  BT + String.raw`[^` + BT + String.raw`]*` + BT,
  String.raw`'[^']*'`,
  String.raw`"[^"]*"`,
  String.raw`\\[^\r\n]`,
  String.raw`[^\s'\"\\]`,
];
const MYSQL_GLUE = "(?:" + MYSQL_GLUE_ALTS.join("|") + ")*";

/** Value body inside a whole-argument quoted value. jq: `_mysql_pw_body($q)`. */
const MYSQL_BODY_DOUBLE = String.raw`(?:[^"\\]|\\.)*`;
const MYSQL_BODY_SINGLE = String.raw`[^']*`;

/** jq `_mysql_pw_quoted($q; $esc)`, built for one quote char + quote-escaping pair. */
function mysqlQuotedRule(quote: string, body: string, esc: string, name: string): RedactionRule {
  return {
    name,
    pattern: new RegExp(
      MYSQL_ANCHOR +
        MYSQL_LEAD +
        esc +
        quote +
        "-p)(?<pw>" +
        body +
        ")(?<close>" +
        esc +
        quote +
        ")" +
        MYSQL_GLUE,
      "g",
    ),
    replacement: "$<pre>***$<close>",
  };
}

/**
 * The four whole-argument quoted shapes, then the span rule — same order as jq's
 * `_mysql_pw_pre | _mysql_pw` (`_mysql_pw_all`).
 */
export const MYSQL_PW_RULES: readonly RedactionRule[] = [
  mysqlQuotedRule('"', MYSQL_BODY_DOUBLE, "", "mysql_pw_quoted_double"),
  mysqlQuotedRule("'", MYSQL_BODY_SINGLE, "", "mysql_pw_quoted_single"),
  mysqlQuotedRule('"', MYSQL_BODY_DOUBLE, String.raw`\\`, "mysql_pw_quoted_double_escaped"),
  mysqlQuotedRule("'", MYSQL_BODY_SINGLE, String.raw`\\`, "mysql_pw_quoted_single_escaped"),
  {
    name: "mysql_pw_span",
    pattern: new RegExp(
      MYSQL_ANCHOR +
        MYSQL_LEAD +
        "-p)(?<pw>(?=\\S)" +
        MYSQL_GLUE +
        String.raw`(?:'[^\r\n]*|"[^\r\n]*)?` + String.raw`)`, // the trailing ) closes the `pre` group opened by MYSQL_ANCHOR, same as jq's $tail
      "g",
    ),
    replacement: "$<pre>***",
  },
];

/**
 * Mask every client-anchored MySQL/MariaDB `-p<password>`. Command path only.
 */
export function redactMysqlPw(str: string): string {
  let result = str;
  for (const rule of MYSQL_PW_RULES) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}

/**
 * Unmask sentinel to final redaction marker.
 */
function unmaskSentinel(str: string): string {
  return str.replace(new RegExp(REDACT_SENTINEL, "g"), "***");
}

// --- Auth scheme patterns ---

/**
 * Bearer scheme redaction (command path, min length 1).
 */
function redactBearerScheme(str: string, minLen: number): string {
  const regex = new RegExp(`bearer\\s+([A-Za-z0-9._-]{${minLen},})`, "gi");
  return str.replace(regex, "Bearer ***");
}

/**
 * Basic scheme redaction (command path, min length 8).
 */
function redactBasicScheme(str: string, minLen: number): string {
  const regex = new RegExp(`\\bbasic\\s+[A-Za-z0-9+/=]{${minLen},}`, "gi");
  return str.replace(regex, "Basic ***");
}

/**
 * Token scheme redaction (command path).
 */
function redactTokenScheme(str: string): string {
  return str.replace(/\btoken\s+([A-Za-z0-9._-]+)/gi, "Token ***");
}

/**
 * Auth scheme redaction for command path (aggressive).
 */
function redactAuthSchemes(str: string): string {
  let result = str;
  result = redactBearerScheme(result, 1);
  result = redactBasicScheme(result, 8);
  return result;
}

/**
 * Auth scheme redaction for prompt path (prose-safe, length-gated).
 */
function redactAuthSchemesProse(str: string): string {
  let result = str;
  result = redactBearerScheme(result, 16);
  result = result.replace(/\btoken\s+([A-Za-z0-9._-]{16,})/gi, "Token ***");
  result = redactBasicScheme(result, 16);
  return result;
}

// --- Command-path redaction (aggressive) ---

/**
 * Full command-path redaction. Uses aggressive keyword matching that can
 * corrupt natural language. Safe for tool outputs and commands.
 *
 * Order matters:
 * 1. PEM keys (structural, unambiguous)
 * 2. Auth schemes (Bearer/Basic)
 * 3. Token word (DRF/GitLab-style)
 * 4. URL userinfo (sets sentinel)
 * 5. Token prefixes (ghp_, sk-, etc.)
 * 5b. Client-anchored MySQL/MariaDB -p<password>
 * 6. Generic keyword=value (catch-all)
 * 7. Unmask sentinel
 *
 * Steps 1-7 mirror jq's `redact` pipeline in order; the parity test checks the
 * two rule tables inside it, and the ordering comment above is part of what it
 * checks structurally by assertion on this function's output.
 */
export function redact(str: string): string {
  let result = str;

  // 1. PEM private keys
  result = result.replace(PEM_REGEX, "***private-key-redacted***");
  result = result.replace(PEM_INCOMPLETE_REGEX, "***private-key-redacted***");

  // 2. Auth schemes
  result = redactAuthSchemes(result);

  // 3. Token word
  result = redactTokenScheme(result);

  // 4. URL userinfo
  result = redactUrlUserinfo(result);

  // 5. Token prefixes
  result = redactTokenPrefixes(result);

  // 5b. Client-anchored MySQL/MariaDB -p<password> (jq: _mysql_pw_all)
  result = redactMysqlPw(result);

  // 6. Generic keyword=value (aggressive)
  // Matches: token, secret, password, passwd, api_key, access_key, credential, auth, authorization, client_id
  // With separators: :, =, " is ", " was ", " are ", or whitespace
  // Values: balanced quotes, sentinel, unterminated quotes, or bare unquoted
  const keywordRegex =
    /(\w*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|credential|auth(?:orization)?|client[_-]?id)\w*)(\s*[:=]\s*|\s+(?:is|was|are)\s+|\s+)("[^"]*"|TLREDACTSENTINEL|"[^\r\n]*|[^\s"]+)/gi;

  result = result.replace(keywordRegex, (match, keyword, sep, value) => {
    // If value is the sentinel, keep it as-is (will be unmasked later)
    if (value === REDACT_SENTINEL) {
      return `${keyword}${sep}${value}`;
    }
    // Otherwise, replace with ***
    return `${keyword}${sep}***`;
  });

  // 7. Unmask sentinel
  result = unmaskSentinel(result);

  return result;
}

// --- Prompt-path redaction (prose-safe) ---

/**
 * Prose-safe redaction for user prompts. Uses only structural patterns
 * that never false-positive on natural language.
 *
 * Deliberately excludes generic keyword matching (which corrupts English).
 * A pasted secret with no recognizable prefix/scheme will NOT be masked
 * by this function.
 */
export function redactPrompt(str: string): string {
  let result = str;

  // 1. PEM private keys
  result = result.replace(PEM_REGEX, "***private-key-redacted***");
  result = result.replace(PEM_INCOMPLETE_REGEX, "***private-key-redacted***");

  // 2. Auth schemes (prose-safe, length-gated)
  result = redactAuthSchemesProse(result);

  // 3. URL userinfo
  result = redactUrlUserinfo(result);

  // 4. Token prefixes
  result = redactTokenPrefixes(result);

  // No MySQL `-p` rule here, same as jq's `redact_prompt`: prompts are natural
  // language, and this span would swallow ordinary words after any sentence
  // that happens to mention mysql.

  // 5. Unmask sentinel
  result = unmaskSentinel(result);

  return result;
}

// --- Utility ---

/**
 * Clean control characters and backticks from a string.
 * Prevents breaking markdown formatting.
 */
export function clean(str: string): string {
  return str.replace(/[\x00-\x1F\x7F`]/g, " ");
}

/**
 * Clamp a string to n characters, appending ellipsis if truncated.
 */
export function clamp(str: string, maxLen: number, ellipsis = "…"): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + ellipsis;
}

/**
 * Combined pipeline: redact → clean → clamp.
 */
export function redactCleanClamp(str: string, maxLen: number, promptSafe = false): string {
  const redacted = promptSafe ? redactPrompt(str) : redact(str);
  const cleaned = clean(redacted);
  return clamp(cleaned, maxLen);
}
