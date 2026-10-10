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
 * `redaction.test.ts` parses `hooks/_lib.sh` and fails if a rule it compares is
 * added, removed, reordered or edited on the jq side without being ported here.
 * What it covers, by name: every `_prefix_tokens` row, every `_mysql_pw*` rule, the
 * generic rule's keyword and copula lists, and the top-level def chain of both
 * pipelines in order - so a new `def` in `redact` or `redact_prompt`, or a keyword
 * added to the generic alternation, fails a test even when no corpus input mentions
 * it. What it does NOT cover: the arguments to `_basic_scheme`, the Token-word
 * value class, the generic rule's value class, and any step added inside
 * `_auth_scheme` or `_auth_scheme_prose`. An edit there is caught only if a corpus
 * input happens to exercise it. That test, not this comment, is what keeps the two
 * in step — the drift it exists
 * to catch is exactly what happened with the issue #81 rules: they landed on the
 * jq side and were not ported here at the same time, and for as long as both sets
 * sat unreleased the two files disagreed. They agree from this change on: the #81
 * rows are in `TOKEN_PREFIX_RULES` and `MYSQL_PW_RULES` and the parity test holds
 * them there. (Neither set had shipped a release of its own, so no released plugin
 * ever had the jq rule without the port - the drift was a maintenance hazard, not
 * a user-visible leak.)
 *
 * Oniguruma-to-JS differences the port has to work around. Each is noted again at the
 * rule that needs it, so the tables stay comparable line by line, and each is pinned by
 * a test rather than by this list:
 *   - JS has no atomic group `(?>…)`. The MySQL span emulates one with the
 *     standard `(?=(?<name>X))\k<name>` lookahead-and-backreference form, which
 *     commits each span step the same way and keeps a long run of `N>&M`
 *     redirects linear instead of exponential.
 *   - jq's `\(.name)` replacement interpolation is JS's `$<name>`.
 *   - `.` is not `.`: JS's also refuses CR, U+2028 and U+2029, so a span jq writes as
 *     `\.` is written `[^\n]` here. This one was a live leak, not a cosmetic one.
 *   - `\s` is not `\s`, in BOTH directions (JS has U+FEFF, JS lacks U+0085), so every
 *     whitespace class in this file is spelled out as `JS_WS_CHARS` / `JS_NOT_WS`.
 *   - `\w` is not `\w`: Oniguruma's is Unicode-aware and JS's is ASCII, which does not
 *     shift a boundary, it stops the generic keyword rule firing at all. Over-
 *     approximated as `JS_WORD_STAR`, run as the LAST masking pass so its residue cannot
 *     starve a later rule - which bounds what it can over-mask, but does not make this
 *     class leak-free: the ASCII pass that runs before it can eat a keyword jq's single
 *     Unicode-aware pass would have matched, and two `under` rows in `ENGINE_DIVERGENCES`
 *     are exactly that (both leak on `main` too).
 *   - `(?i)` is not `i`: Oniguruma folds U+017F onto `s`, U+212A onto `k` and U+00DF /
 *     U+1E9E onto `ss`, JS folds none of them, so the literals are spelled through
 *     `foldSpelled`.
 *   - `\b` IS left as a difference, not fixed: Oniguruma's is Unicode-aware and no
 *     approximation of it lands on the safe side, so each input where the two disagree
 *     is pinned by direction in `ENGINE_DIVERGENCES` in `redaction.test.ts`.
 *
 * `.omp-plugin` is NOT affected by any of this: its shim shells out to the same
 * `hooks/*.sh` scripts, so it inherits the jq rules directly.
 */

// --- Constants ---

/** Sentinel for URL userinfo redaction (prevents generic rules from over-masking) */
const REDACT_SENTINEL = "TLREDACTSENTINEL";

/**
 * The whitespace characters Oniguruma's `\s` matches. Verified one code point at a
 * time against jq 1.7.1 by sweeping EVERY non-surrogate code point (`test("[\\s]")`
 * over U+0000-U+10FFFF): the set is 25 code points - ASCII whitespace, U+0085, U+00A0,
 * U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F and U+3000 - and it does NOT
 * include U+FEFF, which JS's `\s` DOES match.
 *
 * This is a class BODY, and it is what every `\s` in this file is re-spelled into,
 * including the rules that predate issue #90. JS's `\s` and Oniguruma's disagree in
 * BOTH directions - JS has U+FEFF and lacks U+0085 - and each half of that difference
 * is a leak, not a cosmetic drift:
 *   - in a VALUE class, JS stops the run at a BOM inside a secret and masks only its
 *     head (`password=abc<U+FEFF>S3cret` -> `password=***<U+FEFF>S3cret` here, while
 *     jq masks the whole value);
 *   - in a SEPARATOR class, JS refuses to walk over a U+0085, so the rule never fires
 *     at all and the secret is not masked even in part (`bearer<U+0085>AbCd...` and
 *     `password<U+0085>=S3cret` are left verbatim here, masked by jq).
 * No ASCII-only test input can see either case.
 *
 * Braces are deliberately not used (`\u{00a0}`): outside the `u` flag JS reads
 * `\u{41}` as the character set {u,4,1}, which would put letters and digits in the
 * class and turn the rule into a sledgehammer.
 */
const JS_WS_CHARS = String.raw` \t\n\v\f\r\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;
/** A class matching exactly Oniguruma's `\s`. */
const JS_WS = "[" + JS_WS_CHARS + "]";
/** A class matching exactly Oniguruma's `\S`. */
const JS_NOT_WS = "[^" + JS_WS_CHARS + "]";
/** `[^$extras<Oniguruma \s>]` - a negated class that also excludes `$extras`. */
function jsNotWs(extras: string): string {
  return "[^" + extras + JS_WS_CHARS + "]";
}

/**
 * Oniguruma's `\w`, OVER-approximated, ready to quantify. JS reads `\w` as
 * `[0-9A-Za-z_]` and Oniguruma reads it as Unicode word characters, and unlike `\s`
 * that difference cannot be spelled out exactly: measured over 19,979 code points
 * against jq 1.7.1, the closest JS Unicode-property class (`[\p{L}\p{N}\p{M}_]`,
 * which needs the `u` flag this file's identity escapes cannot use) still disagrees on
 * 583 of them. So this matches an ASCII word character, or ANY non-ASCII
 * non-whitespace character - which fires wherever jq's `\w` fires, plus a residue on
 * the other side.
 *
 * The residue is deliberately on the masking side, and the rules that use this class run
 * as the LAST masking step of `redact` (pass 6b, after the ASCII pass) precisely so that
 * nothing runs after a longer keyword group that it could extend a mask over. That is
 * what the ordering buys, and it is NOT the same as "this class cannot leak" - an earlier
 * claim in this comment, withdrawn. Pass 6b cannot starve a later RULE, but pass 6a, whose
 * affixes are ASCII like jq's text, can eat a keyword that jq's single Unicode-aware pass
 * would have matched as the keyword rather than as a value, and then no pass reaches the
 * secret behind it. Two rows in `ENGINE_DIVERGENCES` are that mechanism (`under`, both
 * leaking on `main` as well); the other `under` rows there are earlier rules whose
 * over-match eats a later rule's keyword. The `over` residue of THIS class is pinned
 * alongside them, so a future change that turns one into a leak fails.
 *
 * `JS_WORD_CHAR` below is one character of this over-approximated set, ready to
 * quantify; `JS_WORD_STAR` is that class quantified with `*`.
 */
const JS_WORD_CHAR = "(?:\\w|[^\\x00-\\x7f" + JS_WS_CHARS + "])";
const JS_WORD_STAR = JS_WORD_CHAR + "*";
/**
 * ASCII `\w` by code point, for the scan in `redact`'s pass 6b that has to walk a keyword
 * occurrence back to the earliest start its ASCII lead could begin at. Same set as `\w`,
 * written as code-point ranges because it runs per character.
 */
function isAsciiWordChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) || code === 95;
}

/**
 * Oniguruma's case folding, spelled out, because `(?i)` in jq and the `i` flag in JS
 * are not the same fold. Measured over EVERY non-surrogate code point (1,112,064 probes
 * per pass, jq 1.7.1) against two pattern sets built from the literals these rules
 * match: the single characters, and every two-character substring of
 * `token/secret/password/passwd/api_key/access_key/credential/auth/authorization/client_id/is/was/are/bearer/basic`.
 * The single-character pass returns exactly two hits outside ASCII - U+017F (long s)
 * onto `s` and U+212A (Kelvin sign) onto `k`. The two-character pass, which is what a
 * one-to-two full-folding expansion needs to show up in, returns exactly two - U+00DF
 * and U+1E9E (sharp s, lower and upper), both onto `ss`. Nothing else in Unicode folds
 * onto a letter these keywords are spelled with, and no ligature (\u{fb00}-\u{fb06})
 * appears because no keyword contains `ff`, `fi`, `fl`, `ffi`, `ffl`, `fst` or `ft`.
 *
 * JS's `i` flag folds none of the four. A keyword written as plain ASCII therefore
 * never fires on them where jq does: `pa\u00dfword=S3cret`, `pa\u017f\u017fword=S3cret` and
 * `to\u212aen=abcdef` are each masked by the jq hooks and stored in cleartext here - the
 * "rule never fires" direction, the same class of leak as `\s` and `\w`, and invisible
 * to an ASCII-only test corpus.
 *
 * The value classes carry the two SINGLE-character partners only. `bearer \u00dfecret`
 * is left verbatim by jq as well, because a one-to-two expansion is not something a
 * bracket class matches, so spelling sharp s in there would over-match where jq does
 * not fire.
 */
const FOLD_S = "[s\\u017f]";
const FOLD_K = "[k\\u212a]";
/** A doubled `ss` in a keyword, which jq also matches as one sharp s in either case. */
const FOLD_SS = "(?:[s\\u017f][s\\u017f]|\\u00df|\\u1e9e)";
/** `A-Za-z0-9` plus the single-character fold partners, for jq's `(?i)` value classes. */
const FOLD_ALNUM = "A-Za-z\\u017f\\u212a0-9";

/**
 * Spell one keyword literal so JS's `i` flag matches exactly what jq's `(?i)` matches:
 * a lone `s` becomes `[s\u017f]`, a `k` becomes `[k\u212a]`, and a doubled `ss` additionally
 * becomes one sharp s in either case. Characters that are not `s` or `k` pass through
 * untouched, which is what lets the regex syntax inside these literals
 * (`api[_-]?key`, `auth(?:orization)?`, `client[_-]?id`) ride along - none of that syntax
 * contains an `s` or a `k`, so nothing structural gets folded.
 *
 * Built from the plain-ASCII words rather than hand-spelling each alternation branch,
 * for the mundane reason that hand-spelling is where a dropped letter hides: the parity
 * test in `redaction.test.ts` parses the keyword and copula alternations out of jq's own
 * `def redact`, asserts they equal `KEYWORD_WORDS` / `SEPARATOR_WORDS` in order, and then
 * runs a probe per keyword through both engines, so a word that is in the list but not in
 * the rule - or in jq but not in the list - fails.
 */
function foldSpelled(word: string): string {
  let out = "";
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    const next = i + 1 < word.length ? word[i + 1] : "";
    if (ch === "s" && next === "s") {
      out += FOLD_SS;
      i++;
    } else if (ch === "s") {
      out += FOLD_S;
    } else if (ch === "k") {
      out += FOLD_K;
    } else {
      out += ch;
    }
  }
  return out;
}

/** jq's generic keyword list, verbatim, before any fold spelling is applied.
 * Exported so redaction.test.ts can assert it against the alternation parsed out of
 * `hooks/_lib.sh` - the fold spelling below is applied to this list, so a word dropped
 * here is a keyword that stops being masked on both paths. */
export const KEYWORD_WORDS = ["token", "secret", "password", "passwd", "api[_-]?key", "access[_-]?key", "credential", "auth(?:orization)?", "client[_-]?id"];
/** jq's `is|was|are` separator words, verbatim. Exported for the same reason. */
export const SEPARATOR_WORDS = ["is", "was", "are"];
const KEYWORD_ALTERNATION = KEYWORD_WORDS.map(foldSpelled).join("|");
const SEPARATOR_ALTERNATION = SEPARATOR_WORDS.map(foldSpelled).join("|");

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
  // jq: `_url`, re-spelled for Oniguruma's `\s`. This one is the leak direction
  // rather than the cosmetic one: a BOM anywhere inside the userinfo or the password
  // ends the match in JS, the rule does not fire at all, and the password is stored
  // in cleartext - whereas jq masks it.
  // The anchor is `//`, not `://` - the same anchor jq's `_url` uses (issue #115): a
  // scheme-relative reference still carries `user:password@`, and a credential in
  // userinfo position is a credential whether or not a scheme precedes it. Narrowing
  // this back to `://` would mask LESS than the plugin has ever shipped, which is the
  // leak direction wearing a parity costume. `redaction.test.ts` asserts both the
  // scheme-relative and the scheme-ful spelling, on both engines.
  const regex = new RegExp("(\\/\\/" + jsNotWs(":@/") + "+):(" + jsNotWs("@/") + "+)@", "g");
  return str.replace(regex, `$1:${REDACT_SENTINEL}@`);
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
  {
    // jq's own text, kept verbatim. Note what that does NOT buy: Oniguruma reads
    // `\b` as Unicode-aware and JS reads it as ASCII-only, so a non-ASCII word
    // character before `SG.` anchors here and not there (over-redaction; jq leaves
    // such a token in cleartext). Rewriting it as a lookbehind would not fix that
    // either - `S` is itself an ASCII word character, so `(?<![A-Za-z0-9_])` means
    // exactly what `\b` means in JS. Pinned as a divergence by ENGINE_DIVERGENCES
    // in redaction.test.ts rather than papered over.
    name: "sendgrid",
    pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
    replacement: "SG.***",
  },
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
 * The whitespace set Oniguruma reads `\s` as, spelled out in `JS_WS_CHARS` at the top
 * of this file; `JS_NOT_WS` is its negation, used where jq writes `(?=\S)`.
 */

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
  String.raw`\\[^\n]`, // JS '.' also refuses CR/U+2028/U+2029; jq's '.' refuses only LF
  String.raw`[^|;&\r\n'"]`,
  String.raw`'[^']*'`,
  String.raw`"(?:[^"\\]|\\[^\n])*"`,
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
  RE_BS + DQ + String.raw`(?:[^"\\]|\\[^\n])*` + RE_BS + DQ,
  String.raw`\$\([^)]*\)`,
  BT + String.raw`[^` + BT + String.raw`]*` + BT,
  String.raw`'[^']*'`,
  String.raw`"[^"]*"`,
  String.raw`\\[^\r\n]`,
  String.raw`[^` + JS_WS_CHARS + String.raw`'\"\\]`,
];
const MYSQL_GLUE = "(?:" + MYSQL_GLUE_ALTS.join("|") + ")*";

/** Value body inside a whole-argument quoted value. jq: `_mysql_pw_body($q)`. */
const MYSQL_BODY_DOUBLE = String.raw`(?:[^"\\]|\\[^\n])*`;
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
        "-p)(?<pw>(?=" + JS_NOT_WS + ")" +
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
  // jq: `_bearer_scheme($min)`. `\\s` re-spelled for Oniguruma's: a U+0085 between the
  // scheme and the token means the JS rule never fires and the token is stored
  // verbatim, while jq masks the whole thing - the leak direction. The value class
  // carries the case-fold partners: jq's `(?i)[A-Za-z0-9._-]` matches a long s or a
  // Kelvin sign, JS's does not, so `bearer AbCd\u017fEfGh` used to mask only its head here.
  const regex = new RegExp(`${foldSpelled("bearer")}${JS_WS}+([${FOLD_ALNUM}._-]{${minLen},})`, "gi");
  return str.replace(regex, "Bearer ***");
}

/**
 * Basic scheme redaction (command path, min length 8).
 */
function redactBasicScheme(str: string, minLen: number): string {
  const regex = new RegExp(`\\b${foldSpelled("basic")}${JS_WS}+[${FOLD_ALNUM}+/=]{${minLen},}`, "gi");
  return str.replace(regex, "Basic ***");
}

/**
 * Token scheme redaction (command path).
 */
function redactTokenScheme(str: string): string {
  // jq: the bare `\\btoken\\s+...` gsub in `redact`, command path, no length floor.
  return str.replace(new RegExp(`\\b${foldSpelled("token")}${JS_WS}+([${FOLD_ALNUM}._-]+)`, "gi"), "Token ***");
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
  result = result.replace(new RegExp(`\\b${foldSpelled("token")}${JS_WS}+([${FOLD_ALNUM}._-]{16,})`, "gi"), "Token ***");
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
 * Steps 1-7 mirror jq's `redact` pipeline in order. The parity test asserts that
 * order by reading jq's own def bodies: `runs the MySQL rules in the command chain
 * only, exactly as jq does` parses `redact` / `redact_prompt` out of `hooks/_lib.sh`
 * and pins that `_mysql_pw_all` runs after `_prefix_tokens` and that no `_mysql*`
 * def reaches the prompt path, then checks this function's output mirrors it.
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
  // jq: the generic gsub at the end of `redact`. BOTH `\\s` sites are re-spelled for
  // Oniguruma's set: the separator class decides whether the rule fires at all and
  // the value class decides how far the mask reaches, so each is a leak in one of the
  // two directions.
  //
  // `\\w` is re-spelled as TWO passes rather than one widened rule, and the order is
  // the whole point of the shape:
  //   pass 6a - JS's own ASCII `\\w*` affixes, jq's text, DRIVEN from one left-to-right
  //             scan of the word runs for latency (see `asciiWordPass` below,
  //             dynamic/throughline#114 and dynamic/throughline#129);
  //   pass 6b - the same rule with Oniguruma's word set over-approximated on the
  //             SUFFIX only (`JS_WORD_STAR`), so `password\u00e9=S3cret`, where jq's `\\w*`
  //             walks over the accent but JS's stops, the separator alternatives cannot
  //             match a letter and the rule never fires at all, is masked here too.
  //             The LEADING affix stays ASCII, and that is a latency decision, not an
  //             oversight: a star that matches any non-ASCII non-whitespace character on
  //             both sides of the keyword costs O(run length) work at every position
  //             inside a run of such text, which is quadratic on the CJK prose that has
  //             no spaces - measured at 5.6 s for a 3 KB command where `main` takes 1 ms,
  //             and `redact()` runs in-process on the full unclamped bash command. The
  //             leading affix only moves where a match starts, and whatever it matches is
  //             written back verbatim by the replacement, so dropping it costs no mask:
  //             `\u4e2dAPI_KEY\u4e2d  S3cretPw` is still masked, the match just starts at the
  //             keyword instead of at the character before it.
  // Widening the single rule instead is shorter and WRONG for the MASKING-ORDER case, and
  // the seeded fuzz test in redaction.test.ts pins why: a keyword group that runs
  // longer also MATCHES EARLIER, and an earlier match can consume the keyword a later
  // match needed - the same mechanism as the `under` rows in ENGINE_DIVERGENCES. As one
  // widened rule this port leaked `api-key<U+180E>YWJjZGVmZ2hpamts api_key "pa ss"`,
  // masking `api_key` as the first keyword's value and leaving the quoted password in
  // cleartext while jq masks the quoted value. Putting the over-approximation LAST means it
  // has no later RULE to starve, so most of its residue sits on the masking side - but NOT
  // all of it, and this comment used to claim otherwise. Pass 6a, the ASCII affixes, can
  // itself consume a keyword that jq's single Unicode-aware pass would have matched as the
  // KEYWORD rather than as a value, and then the secret behind it is unreachable to both
  // passes: `export DB_PASSWORD_\u00c9 SECRET PASSWORD S3cret` masks `PASSWORD` (6a, as `SECRET`'s
  // value) where jq masks `SECRET` (as `DB_PASSWORD_\u00c9`'s value) and still has `PASSWORD S3cret`
  // left to mask. Those inputs are pinned as `under` rows in ENGINE_DIVERGENCES; both leak
  // on `main` too, so they are not regressions, but "the second pass can only over-mask"
  // was false as written and the seeded corpus cannot generate the shape (its two-keyword
  // template puts no affix on the first keyword). The `\\b` of the OTHER rules is a
  // different class of difference: there even an over-approximation can land on the leaking
  // side, so those stay pinned as divergences too - see ENGINE_DIVERGENCES in
  // redaction.test.ts.
  // Pass 6a is DRIVEN from one scan of the word runs rather than handed to `String.replace`,
  // which is the latency fix for dynamic/throughline#114 and its follow-up
  // dynamic/throughline#129 - see `asciiWordPass` below. What the driving depends on, and
  // what a rewrite of this rule has to keep:
  //   - the attempt is anchored at the run START, never at the keyword. A lookbehind at the
  //     KEYWORD position cannot see how far the lead got, so it blocks a mid-run keyword
  //     that no run-start keyword can grow into (`xtoken=v`: `x` is not a keyword, and
  //     `(?<=..)` at `token` sees the `x` the lead just consumed as if the match started
  //     there), and would mask LESS than the jq hooks. Anchoring at the run start costs no
  //     mask for the same reason the lead costs no mask: every start inside one word run
  //     that can complete produces the SAME masked output, because the keyword group's
  //     suffix always runs to the end of the run (each separator alternative starts with
  //     whitespace, `:` or `=`, none of which is a word character, so the separator can
  //     only match at the run end) and the replacement writes the keyword group back
  //     verbatim - so the run start reproduces exactly what a mid-run start would write,
  //     and no mid-run start can complete where the run start fails, because the run start
  //     reaches whatever a mid-run lead reached.
  // The one resume position that is NOT a run start: the value alternative can match
  // `REDACT_SENTINEL` exactly, and the sentinel is all word characters, so a scan that
  // only ever restarted at run starts would end a match mid-run and never look at what
  // followed (`password=TLREDACTSENTINELtoken=x` -> `password=***token=***` on BOTH
  // engines). `asciiWordPass` below re-admits it by resuming its own scan at the end of
  // each match, which for that input is the character right after the sentinel. Pass 6b
  // bounds its scan the same way it always has, by DRIVING the attempts rather than by
  // anchoring the lead - see `widenedWordPass` below (dynamic/throughline#118) - and its
  // fast-path gate means ASCII input never pays for it.
  // The two tail groups of the generic rule, split out of the single expression below;
  // the concatenation is byte-identical to what this used to be.
  const keywordSeparatorGroup =
    "(" + JS_WS + "*[:=]" + JS_WS + "*|" + JS_WS + "+(?:" + SEPARATOR_ALTERNATION + ")" + JS_WS + "+|" + JS_WS + "+)";
  const keywordValueGroup =
    "(\"[^\"]*\"|" + REDACT_SENTINEL + "|\"[^\\r\\n]*|" + jsNotWs("\"") + "+)";
  const keywordPattern = (lead: string, suffix: string) =>
    "(" + lead + "(?:" + KEYWORD_ALTERNATION + ")" + suffix + ")" + keywordSeparatorGroup + keywordValueGroup;
  const keywordReplacement = (_match: string, keyword: string, sep: string, value: string) => {
    // If value is the sentinel, keep it as-is (will be unmasked later)
    if (value === REDACT_SENTINEL) {
      return `${keyword}${sep}${value}`;
    }
    // Otherwise, replace with ***
    return `${keyword}${sep}***`;
  };

  /**
   * Pass 6a, driven from one left-to-right scan of the word runs instead of handed to
   * `String.replace` (dynamic/throughline#129, the remaining path of #114). Handed to one
   * global `replace` the rule is quadratic in the length of a single unbroken word run:
   * one start per run costs (keyword hits in the run) x (run length), because the lead
   * `\\w*` runs to the run end and gives back one character at a time, and at each keyword
   * hit the suffix `\\w*` runs to the run end and gives back one character at a time too -
   * in-process, on the full unclamped bash command, and worst where a resume position
   * recurs (a `REDACT_SENTINEL` value re-admits a start after every sentinel). Driving the
   * attempts removes both factors; the mask produced is byte-identical to the global
   * replace's, only the cost changes. Pre/post measurements are in dynamic/throughline#129.
   *
   * Why one attempt per (run, keyword-group end) is enough. Inside one maximal `\\w` run
   * [rs, re), take any start the rule would attempt there (the run start, or the resume
   * position right after a `REDACT_SENTINEL` value):
   *   1. the keyword group always ends at a run end. Its suffix `\\w*` runs to the end of
   *      the run its KEYWORD END falls in: giving it back a character puts the next
   *      position on a character the suffix itself matched, and no separator alternative
   *      can match such a character (`[:=]` and the whitespace classes are all outside the
   *      class), so every backtracking step of the suffix is doomed;
   *   2. so whether that start completes at all depends only on what starts at that run
   *      end, and the text a completing match writes - the keyword group verbatim, the
   *      separator, and `***` - plus where the scan resumes, are the same for every start
   *      that shares that run end;
   *   3. so the only thing that distinguishes the attempts is WHICH run end they ask, and
   *      a run has at most two candidates: its own end `re`, and the end of the run that
   *      the run's RIGHTMOST crossing keyword ends in - usually the run right after, but
   *      further on when the keyword itself crosses more than one run-splitting character
   *      (`acce\u017fs_\u212aey` crosses U+017F and U+212A and its group ends in the third run).
   *      A keyword leaves its run only through a character that ASCII `\w` does not
   *      match - the hyphen of `api[_-]?key`, `access[_-]?key` and `client[_-]?id` (underscore
   *      is a word character and never splits a run), or one of the case-fold spellings the
   *      keyword classes carry (U+017F, U+212A, U+00DF, U+1E9E) - and whatever it matches
   *      past the run end is word characters up to that end, so all crossing keywords of one
   *      run share that second candidate (only the rightmost one's walk is ever performed,
   *      see the `crossEnd` update below). Skipping it leaks in the direction that
   *      matters, twice over: `tokenaapi-key=S3cret` has no separator at the first run end,
   *      so the mask is reachable only from the `api-key` keyword's end, and
   *      `secreto\u212aen=x` - `secret` and `to\u212aen` (Kelvin sign) sharing one character - only
   *      reaches its separator through the second, crossing keyword, which is why the keyword
   *      scan resumes one character after each hit rather than after each whole keyword.
   * The engine's own preference between those two is by keyword position - it tries the
   * longest lead first, i.e. the RIGHTMOST keyword - so the driver asks the later run end
   * first and the earlier one only if that fails. Both answers write the same bytes for a
   * given run end, so this is a cost decision, not a masking one.
   *
   * Two positions are not inside a `\\w` run and cannot be reached from one, and the scan
   * gives each its own attempt: a resume position after a match, and any keyword occurrence
   * that OPENS on a character no `\\w` run holds. The second is the leak direction: JS's
   * non-`u` `\\w` is ASCII-only, so `KEYWORD_ALTERNATION`'s case-fold spellings can start a
   * keyword on a character outside every run (`\\u017f` opening `secret`) and a driver that
   * walked runs only would hand `\\u017fecret=x` back in cleartext where both engines mask it.
   * Keyword occurrences are enumerated once, left to right, and the walk to a run end only
   * runs for an end that is still unset, so many keywords in one run stay O(1) per run
   * rather than O(keywords x run length).
   */
  const asciiWordPass = (text: string): string => {
    // The rule's own two tail groups, anchored. `y` on top of `g` makes `lastIndex` an
    // ANCHOR rather than a hint: the attempt either completes at exactly that run end or
    // reports nothing, so a failed attempt can never be read as "nothing here, but one
    // further along" and skip work still owed.
    const tail = new RegExp(keywordSeparatorGroup + keywordValueGroup, "giy");
    const runs = new RegExp("\\w" + "+", "g");
    const keywords = new RegExp("(?:" + KEYWORD_ALTERNATION + ")", "gi");
    // Where the keyword group ends when the keyword ENDS at `from`: the suffix `\\w*` runs
    // to the end of the `\\w` run containing that position.
    const groupEndAt = (from: number): number => {
      let end = from;
      while (end < text.length && isAsciiWordChar(text.charCodeAt(end))) end += 1;
      return end;
    };
    // The rule's own start test (`(?<!\\w)`, plus the `REDACT_SENTINEL` resume) as a
    // predicate, for the positions that are not run starts. The resume carries the rule's
    // own case-insensitivity: the undriven lookbehind ran under `gi`, so a value ending in
    // ANY case spelling of the sentinel admitted the position right after it there and must
    // here - a case-SENSITIVE compare leaks `password=tlredactsentinel\u017fecret=hunter2`
    // (the keyword after the sentinel opens on U+017F, so no ASCII `\\w` run reaches it and
    // this test is the only thing admitting it) where both engines mask it. Folding with
    // `toUpperCase()` is not equivalent either: U+017F folds to `S`, so a case-folded
    // compare would admit positions the rule's own lookbehind does not. A sticky lookaround
    // asks the regex engine the same question the lookbehind asked, with the same flags.
    const afterSentinel = new RegExp("(?<=" + REDACT_SENTINEL + ")", "iy");
    const isStartPosition = (at: number): boolean =>
      at === 0 ||
      !isAsciiWordChar(text.charCodeAt(at - 1)) ||
      (at >= REDACT_SENTINEL.length &&
        ((afterSentinel.lastIndex = at), afterSentinel.test(text)));
    // The leftmost keyword occurrence at or after the search start, plus a `null` remembered
    // as "the scan reached the end". Both only move right (every search start is a `pos` or
    // a `runStart`, and both only advance), so the scan costs O(text) for the pass. Two
    // memories keep that bound, one per direction the scan can run out of work: the
    // remembered `null` stops a text with NO keywords from being re-searched from every gap,
    // and the remembered HIT is reused until a search start moves PAST it - the alternation
    // has no lookarounds, so a hit at or after the new start is still the leftmost one
    // there. Dropping a still-valid hit whenever the start advances is its own quadratic:
    // every run in front of the next keyword re-scans the whole gap to it (a 100 KB command
    // whose secret sits at the end - the most common shape there is - pays 1.7 s that way,
    // against 1.3 ms undriven).
    let occurrence: RegExpExecArray | null = null;
    let scannedTo = 0;
    let scanDone = false;
    const nextOccurrence = (from: number): RegExpExecArray | null => {
      if (scanDone) return null;
      const start = from > scannedTo ? from : scannedTo;
      if (occurrence === null || occurrence.index < start) {
        keywords.lastIndex = start;
        occurrence = keywords.exec(text);
        if (occurrence === null) scanDone = true;
      }
      return occurrence;
    };
    const consumeOccurrence = (found: RegExpExecArray): void => {
      // `+ 1`, not `+ found[0].length`. The keyword alternation is scanned non-overlapping,
      // but the rule's own backtracking reaches a keyword that STARTS inside an earlier one,
      // and such a keyword can be the only one whose group end carries the separator:
      // `secreto\u212aen=x` holds `secret` and `to\u212aen` (Kelvin sign) sharing the `t`, the first
      // ends inside the run and the second crosses the Kelvin character, and only the second
      // one's end has the `=` after it. Advancing past the whole occurrence never enumerates
      // it and the secret stays in cleartext. Keywords are at most one character apart in
      // that overlap, so this stays O(text).
      scannedTo = found.index + 1;
      occurrence = null;
    };
    let out = "";
    let pos = 0;
    for (;;) {
      if (pos >= text.length) return out;
      runs.lastIndex = pos;
      const run = runs.exec(text);
      // Nothing maskable is left: every match of this rule contains a keyword, and every
      // keyword sits inside a word run.
      if (run === null) return out + text.slice(pos);
      const runStart = run.index;
      const runEnd = runStart + run[0].length;
      // An anchored attempt whose keyword group is `text.slice(start, end)`, the way the
      // undriven rule would have written it: group verbatim, separator verbatim, value
      // masked (or kept, when the value is the sentinel that step 7 unmasks).
      const attempt = (start: number, end: number): number => {
        if (end < 0) return -1;
        tail.lastIndex = end;
        const found = tail.exec(text);
        if (found === null) return -1;
        const group = text.slice(start, end);
        out += text.slice(pos, start) + keywordReplacement(group + found[0], group, found[1], found[2]);
        return end + found[0].length;
      };
      // Starts in the gap before this run: not run starts, not reachable by an ASCII lead,
      // and only maskable if the rule's own start test admits them.
      if (runStart > pos) {
        let resumed = -1;
        for (;;) {
          const gap = nextOccurrence(pos);
          if (gap === null || gap.index >= runStart) break;
          if (isStartPosition(gap.index)) {
            resumed = attempt(gap.index, groupEndAt(gap.index + gap[0].length));
            if (resumed >= 0) break;
          }
          consumeOccurrence(gap);
        }
        if (resumed >= 0) {
          pos = resumed;
          scannedTo = resumed;
          occurrence = null;
          continue;
        }
      }
      // This run's candidate keyword-group ends. A keyword that ends inside the run gives
      // `runEnd`; a keyword gives anything else only by crossing a character ASCII `\\w`
      // does not match - the hyphen of `api[_-]?key`, `access[_-]?key` and `client[_-]?id`,
      // or one of the case-fold spellings the keyword classes carry (U+017F, U+212A, U+00DF,
      // U+1E9E) - and whatever it matches past the run end is word characters, so ONE walk
      // (and one attempt) covers all of them - walking per keyword is the O(keywords x run
      // length) this pass exists to remove. `lastCrosses` records which kind the LAST
      // keyword of the run is, because that is the one the engine reaches with the longest
      // lead and therefore answers first.
      let endsInRun = false;
      let lastCrosses = false;
      let crossEnd = -1;
      for (;;) {
        const hit = nextOccurrence(runStart);
        // `<= runEnd`, not `<`: the lead can cover the WHOLE run, so a keyword that opens on
        // the first non-word character after it (`\u017f` again) is still this run's keyword.
        if (hit === null || hit.index > runEnd) break;
        const keywordEnd = hit.index + hit[0].length;
        if (keywordEnd <= runEnd) {
          endsInRun = true;
          lastCrosses = false;
        } else {
          lastCrosses = true;
          // Only walk for an end that is still ahead of the one already walked: keyword
          // ends arrive in ascending order, so this is O(text) for the pass instead of
          // O(crossing keywords x next run length).
          if (keywordEnd > crossEnd) crossEnd = groupEndAt(keywordEnd);
        }
        consumeOccurrence(hit);
      }
      const first = lastCrosses ? crossEnd : endsInRun ? runEnd : -1;
      // The engine's order between the two candidate ends: the longest lead first, which is
      // the RIGHTMOST keyword, so a crossing keyword answers before one ending inside the
      // run. `second` is the other candidate. It never wins here - a crossing keyword's own
      // non-`\\w` character sits exactly AT `runEnd` (a run is maximal, and a keyword only
      // crosses through such a character), so when `lastCrosses` the run's own end cannot
      // start any separator arm and `attempt(runStart, runEnd)` is doomed; and when
      // `lastCrosses` is false the last processed keyword ends inside the run, which - its
      // search having resumed one character after a crossing keyword that already covered
      // `runEnd` - no keyword in the current list can do while a crossing keyword set
      // `crossEnd`, so `crossEnd` arrives only as `first` and the `crossEnd`-as-`second`
      // arm is dead too. It is kept as the rule's own backtracking order rather than
      // deleted: a future keyword that overlaps a crossing one differently pays one
      // doomed sticky attempt, never a missed mask.
      const second = lastCrosses ? (endsInRun ? runEnd : -1) : crossEnd;
      let resumed = attempt(runStart, first);
      if (resumed < 0) resumed = attempt(runStart, second);
      if (resumed >= 0) {
        pos = resumed;
        scannedTo = resumed;
        occurrence = null;
        continue;
      }
      // Neither candidate end can start a separator, so no start in this run completes and
      // the run is emitted verbatim in one slice.
      out += text.slice(pos, runEnd);
      pos = runEnd;
    }
  };

  result = asciiWordPass(result);
  /**
   * Pass 6b's guard: mask a match only where the keyword is one pass 6a's keyword group
   * COULD NOT have matched. Two tests, because one is not enough:
   *   1. the keyword carries a non-ASCII character at all - otherwise the two passes'
   *      keyword groups are the same set, since `JS_WORD_STAR` only ever widens past
   *      non-ASCII, and every separator and class in the pattern is identical; and
   *   2. the keyword is not one of the CASE-FOLD SPELLINGS pass 6a already carries.
   *      `foldSpelled` puts U+017F, U+212A, U+00DF and U+1E9E INTO `KEYWORD_ALTERNATION`, so
   *      `pa\u017f\u017fword` is non-ASCII and was still fully visible to pass 6a - test 1 alone
   *      re-masks its own output, which is how `pa\u017f\u017fword "open sesame passwd:"open sesame`
   *      came to be written `*** sesame` here against jq's `***open sesame`.
   * What is deliberately NOT here is a guard on the VALUE, e.g. "skip when the value starts
   * with `***`", which is the other shape of this problem (`token\u00e9token="a b"c`, where 6a
   * masks the second `token` and 6b then masks 6a's `***` plus the `c` glued to it). Such a
   * guard cannot tell 6a's own `***` from three asterisks a user pasted, and
   * `password\u00e9=***S3cretPw` is a value this port must mask and that guard would hand back
   * in cleartext - a leak direction, bought to fix an over-mask. `token\u00e9token="a b"c` is
   * pinned as an `over` row in `ENGINE_DIVERGENCES` instead, so it cannot get worse silently.
   * Applying the rule twice to its own output is never the same as applying it once: pass 6a
   * has replaced a value with `***`, and a second match that runs past it eats text jq
   * leaves visible. The over-mask those two pins cover is over-masking, never a leak, but it
   * is a divergence from the hooks on ordinary-looking text.
   */
  const asciiKeywordSeenByPass6a = new RegExp("^\\w*(?:" + KEYWORD_ALTERNATION + ")\\w*$", "i");
  const widenedKeywordReplacement = (match: string, keyword: string, sep: string, value: string) =>
    /[^\x00-\x7f]/.test(keyword) && !asciiKeywordSeenByPass6a.test(keyword)
      ? keywordReplacement(match, keyword, sep, value)
      : match;
  /**
   * Pass 6b, driven so it cannot re-scan a word run it has already stepped over
   * (dynamic/throughline#118). Handed to `String.replace` as one global `replace`, the
   * rule was quadratic in the length of a long word run that carries a keyword and no
   * separator - a ~16x scaling ratio for a 4x-longer input on the issue's two shapes;
   * the machine-specific timings, before and after, are recorded once, beside the
   * latency guard in `redaction.test.ts`, so the two copies cannot drift apart.
   * Quadratic, and `redact()` runs this in-process on the full unclamped bash command.
   * The mask this produces is byte-identical to what the global replace produced, by the
   * two arguments below; only the cost changes.
   *
   * Why the old shape was quadratic. The suffix `JS_WORD_STAR` matches any word character
   * plus any non-ASCII non-whitespace character, so from any start inside a long run of such
   * text - CJK prose, or a base64-ish blob with an accent in it - it walks to the end of that
   * run, then the separator alternatives - which all need a whitespace, `:` or `=` - fail, and
   * the engine gives the suffix back one character at a time, re-trying the separator at each
   * step. Every start whose lead can reach a keyword pays that, and a start can be reached
   * O(run length) places away from the run end, so a run with no separator inside it costs
   * O(run length)^2. Which is what the issue's two inputs are: CJK prose has no spaces, and a
   * base64-ish blob that happens to carry `token` has no separator either.
   *
   * Why skipping the rest of a run after a failed attempt cannot change the output.
   * Inside one maximal `JS_WORD_CHAR` run [rs, re), take any start whose lead reaches a
   * keyword:
   *   1. the suffix always ends at the end of the run that its KEYWORD END falls in. Giving
   *      it back a character puts the next position on a character the suffix itself matched,
   *      and no separator alternative can match such a character (`[:=]` and the whitespace
   *      classes are all outside the class), so every backtracking step of the suffix is
   *      doomed;
   *   2. so whether that start completes at all depends only on what starts at that run end,
   *      and the text a completing match writes, and where the scan resumes (end of the
   *      value), are the same for every start that shares that run end. The earliest such
   *      start only decides which equivalent match the engine reports;
   *   3. so a failed attempt adjudicates every start that shares its keyword-end run, and
   *      once each distinct run end in the run has been attempted, the driver emits the run
   *      verbatim and resumes at `re`.
   * How many distinct keyword-end runs a run can hold is what bounds the attempts, and it is
   * two. A keyword leaves its run only through the `[-_]` of `api[_-]?key`, `access[_-]?key`
   * and `client[_-]?id`: underscore is a word character and never splits a run, and a hyphen
   * inside one of those three is exactly the character that ends the run - so a start whose
   * keyword crosses the boundary always ends in the run after `re`, and every other start
   * ends at `re` itself. Two anchors, constant work per run. Without the second one the pass
   * leaks in the direction that matters: `token\u6f22api-key\u6f22=S3cret` has no separator at the hyphen,
   * so the `token` attempt fails there, and the secret is reachable only from the `api-key`
   * start - skipping the run on the first failure leaves it in cleartext where both the jq
   * hooks and the pre-#118 port mask it.
   * Neither anchor is pinned to `rs`, and that is the other place a naive linearisation
   * would leak: the
   * lead is ASCII `\\w*`, so a run like `\u4e2d\u4e2dtoken=x` has no match at its own first character
   * (the lead cannot step over `\u4e2d` and no keyword starts there) while the start at `token`
   * does complete - about the 6b rule on its own; end to end, pass 6a's lookbehind already
   * masks that input. So the driver first asks whether the run holds a keyword occurrence at all
   * - one failure from that scan means none is left anywhere in the text, because every match
   * of the rule contains a keyword - and anchors each attempt where that keyword's ASCII word
   * prefix starts, the earliest start that could reach it. Both scans move strictly left to
   * right and the walk-back runs only for an anchor that is still unset, so the DRIVER costs
   * O(text).
   * What it does not buy is linearity of the anchored attempt itself. The rule keeps jq's
   * unbounded `\\w*` lead, and on one long ASCII word run carrying many keywords that lead still
   * backs off character by character with the suffix re-walking the run at each hit - the cost
   * pass 6a has too, and the reason `('token').repeat(k) + '\u00e9'` (the trailing character is what
   * lets pass 6b run at all) takes 59ms at 10,001 characters and 917ms at 40,001 here against
   * 29ms / 457ms for pass 6a alone. That is issue #114's remaining territory, not this
   * issue's quadratic: the driver removes the second, non-ASCII quadratic that the
   * undriven rule added on top of 6a; what remains is #114's own, shared with 6a.
   */
  const widenedWordPass = (text: string): string => {
    // `y` on top of `g` makes `lastIndex` an ANCHOR rather than a hint: the attempt either
    // completes at exactly `start` or reports nothing, so a failed attempt can never be
    // read as "nothing here, but there is one further along" and skip work still owed.
    const rule = new RegExp(keywordPattern("\\w*", JS_WORD_STAR), "giy");
    // Word runs and keyword occurrences, each enumerated once, left to right.
    const runs = new RegExp(JS_WORD_CHAR + "+", "g");
    const keywords = new RegExp("(?:" + KEYWORD_ALTERNATION + ")", "gi");
    let out = "";
    let pos = 0;
    let run: RegExpExecArray | null = null;
    let runEnd = -1;
    let keyword: RegExpExecArray | null = null;
    let scannedTo = 0;
    for (;;) {
      if (pos >= text.length) return out;
      if (run === null || runEnd <= pos) {
        runs.lastIndex = pos;
        run = runs.exec(text);
        if (run === null) return out + text.slice(pos);
        runEnd = run.index + run[0].length;
      }
      const runStart = Math.max(run.index, pos);
      if (keyword !== null && keyword.index < runStart) keyword = null;
      if (keyword === null) {
        keywords.lastIndex = Math.max(runStart, scannedTo);
        keyword = keywords.exec(text);
        // Every match of the rule contains a keyword, so with none left in the text at or
        // after this point there is nothing left to mask either.
        if (keyword === null) return out + text.slice(pos);
      }
      // This run's anchors: the earliest start whose keyword ends inside the run, and the
      // earliest start whose keyword ends past it. Two, because the fate of a start is the
      // separator at the end of the run its KEYWORD END falls in, and a keyword can leave its
      // own run only through the `[-_]` of `api[_-]?key`, `access[_-]?key`, `client[_-]?id` -
      // underscore is a word character so it never splits a run, and a hyphen inside one of
      // those three is exactly the character that ends the run. Both anchors therefore see
      // the same two run ends, whatever the text, and one attempt per anchor is still
      // constant work per run.
      let inRunStart = -1;
      let acrossStart = -1;
      let scan: RegExpExecArray | null = keyword;
      while (scan !== null && scan.index < runEnd) {
        const keywordEnd = scan.index + scan[0].length;
        const wantIn = keywordEnd <= runEnd;
        // Walk back only for the anchor that is still missing. The walk-back is as long as
        // the keyword's ASCII word prefix, so doing it at every occurrence of a long run
        // would cost O(occurrences x run length) - quadratic again, and this loop is the one
        // place in the pass that sees every occurrence. Occurrence order and walk-back order
        // agree (a later occurrence's prefix starts no earlier than an earlier one's), so the
        // FIRST occurrence of each kind is the earliest start of that kind.
        if (wantIn ? inRunStart < 0 : acrossStart < 0) {
          let start = scan.index;
          while (start > runStart && isAsciiWordChar(text.charCodeAt(start - 1))) start -= 1;
          if (wantIn) inRunStart = start; else acrossStart = start;
          if (inRunStart >= 0 && acrossStart >= 0) break;
        }
        scan = keywords.exec(text);
      }
      // `scan` is the last occurrence examined if both anchors were filled, and the first
      // occurrence past the run otherwise; either way the next run resumes the scan from
      // where it left off, and `scannedTo` keeps that resume from walking back over text
      // whose occurrences were already adjudicated.
      scannedTo = scan === null ? text.length : scan.index + scan[0].length;
      keyword = scan;
      const anchors = acrossStart < 0 ? [inRunStart] : inRunStart < 0 ? [acrossStart] :
        inRunStart < acrossStart ? [inRunStart, acrossStart] : [acrossStart, inRunStart];
      let matched = false;
      for (const start of anchors) {
        if (start < 0) continue;
        rule.lastIndex = start;
        const match = rule.exec(text);
        if (match !== null) {
          out += text.slice(pos, start);
          out += widenedKeywordReplacement(match[0], match[1], match[2], match[3]);
          pos = start + match[0].length;
          run = null;
          runEnd = -1;
          keyword = null;
          scannedTo = pos;
          matched = true;
          break;
        }
      }
      if (matched) continue;
      out += text.slice(pos, runEnd);
      pos = runEnd;
    }
  };
  // And the whole-string test is a fast path over that same rule rather than a second
  // condition: with no non-ASCII character in the text, no keyword group can carry one, so
  // every match pass 6b could see would be returned unchanged. It is here for cost - the
  // WIDENED rule is quadratic in the length of a long unbroken non-ASCII run on both
  // engines when handed to `String.replace` (dynamic/throughline#118, which
  // `widenedWordPass` above now bounds; the ASCII side of that measurement,
  // dynamic/throughline#114, was fixed by anchoring pass 6a's lead above), the command
  // path runs it on the full unclamped bash command,
  // and a pasted base64 blob is ASCII, so running the widened pass at all would double the
  // cost of the common case for an output that cannot differ.
  if (/[^\x00-\x7f]/.test(result)) {
    result = widenedWordPass(result);
  }

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
