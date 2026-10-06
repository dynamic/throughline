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
 */
const JS_WORD_STAR = "(?:\\w|[^\\x00-\\x7f" + JS_WS_CHARS + "])*";

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
  // The anchor is `//`, and since issue #115 so is jq's: a scheme-relative reference
  // still carries `user:password@`, and a credential in userinfo position is a
  // credential whether or not a scheme precedes it. This port always had the wide
  // anchor; the hooks used to anchor on `://` and left `//user:pw@host` verbatim, a
  // divergence that is now closed rather than pinned - the two inputs are asserted
  // directly (and against jq) in `redaction.test.ts`. Narrowing this back to `://` would
  // mask LESS than the plugin has always shipped, which is the leak direction wearing a
  // parity costume.
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
  //   pass 6a - JS's own ASCII `\\w*` affixes, which is jq's text verbatim;
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
  const keywordPattern = (lead: string, suffix: string) =>
    "(" + lead + "(?:" + KEYWORD_ALTERNATION + ")" + suffix + ")" +
      "(" + JS_WS + "*[:=]" + JS_WS + "*|" + JS_WS + "+(?:" + SEPARATOR_ALTERNATION + ")" + JS_WS + "+|" + JS_WS + "+)" +
      "(\"[^\"]*\"|" + REDACT_SENTINEL + "|\"[^\\r\\n]*|" + jsNotWs("\"") + "+)";
  const keywordReplacement = (_match: string, keyword: string, sep: string, value: string) => {
    // If value is the sentinel, keep it as-is (will be unmasked later)
    if (value === REDACT_SENTINEL) {
      return `${keyword}${sep}${value}`;
    }
    // Otherwise, replace with ***
    return `${keyword}${sep}***`;
  };

  result = result.replace(new RegExp(keywordPattern("\\w*", "\\w*"), "gi"), keywordReplacement);
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
  // And the whole-string test is a fast path over that same rule rather than a second
  // condition: with no non-ASCII character in the text, no keyword group can carry one, so
  // every match pass 6b could see would be returned unchanged. It is here for cost - this
  // rule is quadratic in the length of a long unbroken run on both engines
  // (dynamic/throughline#114), the command path runs it on the full unclamped bash command,
  // and a pasted base64 blob is ASCII, so running the widened pass at all would double the
  // cost of the common case for an output that cannot differ.
  if (/[^\x00-\x7f]/.test(result)) {
    result = result.replace(new RegExp(keywordPattern("\\w*", JS_WORD_STAR), "gi"), widenedKeywordReplacement);
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
