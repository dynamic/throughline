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
 *     is pinned by direction in `ENGINE_DIVERGENCES` in `redaction.test.ts`. The Token-scheme
 *     word rule is the one exception (issue #116): there the port cannot even say which side of
 *     the boundary it is on, so that rule splits at the seam and masks through the generic rule
 *     in the zone where the engines disagree - see TOKEN_ASCII_ANCHOR.
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
  // The anchor stays `//`, one character wider than jq's `_url`, which anchors on
  // `://`. That is deliberate: a scheme-relative reference still carries
  // `user:password@`, and a credential in userinfo position is a credential whether or
  // not a scheme precedes it. The two inputs this masks and jq leaves verbatim are
  // pinned as `over` rows in `ENGINE_DIVERGENCES` in `redaction.test.ts`. Widening the
  // anchor is a change for the jq hooks, so both engines agree on the wider rule; the
  // alternative - narrowing this port to `://` - masks LESS than the plugin ships today,
  // which is the leak direction wearing a parity costume.
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
 * The generic keyword rule's separator and value alternatives, hoisted to module scope so the
 * ambiguous-prefix Token pass can reuse the SAME shape (issue #116). Composed into
 * `keywordPattern` byte for byte as it was when both strings were inline there.
 *
 * The Token pass needs the generic separators rather than its own because of the copula:
 * in `\u00fctoken is S3cretPw` the Token rule's own `\s+[A-Za-z0-9._-]+` matches the word `is` as
 * the VALUE, so any replacement that deletes the value deletes the copula the generic rule
 * needs to reach the secret - which is the same "ate the keyword a later rule needed" leak
 * this function exists to stop, one character further left.
 */
const KEYWORD_SEPARATOR =
  JS_WS + "*[:=]" + JS_WS + "*|" + JS_WS + "+(?:" + SEPARATOR_ALTERNATION + ")" + JS_WS + "+|" + JS_WS + "+";
const KEYWORD_VALUE = "\"[^\"]*\"|" + REDACT_SENTINEL + "|\"[^\\r\\n]*|" + jsNotWs("\"") + "+";

/**
 * One `separator value` pair, matched STICKILY, for the chain walk in `redactTokenScheme`.
 * Same two alternatives as `KEYWORD_SEPARATOR` / `KEYWORD_VALUE`, so a pair this walk sees is
 * a pair the generic rule would have seen; the sticky flag is what keeps the walk from
 * searching ahead for a pair instead of extending over the next one.
 */
const KEYWORD_PAIR_STICKY = new RegExp("(?:" + KEYWORD_SEPARATOR + ")(" + KEYWORD_VALUE + ")", "iy");
/**
 * A keyword as pass 6a's ASCII keyword group could match it, anchored whole. Built from
 * `KEYWORD_ALTERNATION` at module scope so `redactTokenScheme`'s chain walk and pass 6b's
 * keyword guard ask the SAME question - `redact` used to build its own copy inline.
 */
const KEYWORD_HEAD = new RegExp("^\\w*(?:" + KEYWORD_ALTERNATION + ")\\w*$", "i");
/**
 * Does this value CONTAIN a keyword at all - the question the chain walk in
 * `redactTokenScheme` asks, which is wider than `KEYWORD_HEAD` on purpose. jq's generic keyword
 * group is Unicode-aware, so `üsecret` heads a pair for it and the secret behind that value has
 * to be masked by the walk too; anchoring on ASCII `\w` would stop the walk one pair short and
 * leak. Over-approximating here costs masking on a line that already has a non-ASCII character
 * glued in front of `token`, never a mask the hooks have.
 *
 * KNOWN COST of the substring test, named because it is real and measured (review of
 * dynamic/throughline#122 asked for it to be named, not fixed): the alternation is unanchored,
 * so an ORDINARY PROSE value that merely CONTAINS a keyword substring extends the walk. On this
 * build \u00a9token is authority S3cretPw9 and \u00a9token is author S3cretPw9 walk over both words and
 * write `\u00a9token is ***` where the hooks write `\u00a9Token *** authority ***` - `author`/`authority`
 * match the `auth(?:orization)?` keyword, `tokenish` matches `token`, `credentialist` matches
 * `credential`. Two of the words that review named do NOT extend it, and they are the safe half
 * of the class: `passport` and `keychain` contain no keyword in the list (`pass` and `key` are
 * not keywords on their own), so the walk stops there and nothing behind them gets masked -
 * which is what jq does too (`\u00a9Token *** passport S3cretPw9`, secret and all). The direction is
 * what makes this acceptable: every input in this class over-masks ordinary English on a line
 * that already carries a non-ASCII character welded to `token`, and none of them masks LESS than
 * the hooks do. Pinned as an `over` row in `ENGINE_DIVERGENCES` so the cost cannot grow silently.
 */
const KEYWORD_CONTAINED = new RegExp("(?:" + KEYWORD_ALTERNATION + ")", "i");
/**
 * Does this ambiguous-zone value carry a MySQL/MariaDB CLIENT NAME - the one word a LATER
 * pass (`_mysql_pw_all`, pass 5b) needs intact as its anchor? Searches rather than anchors
 * whole-word, and reuses `MYSQL_CLIENT` rather than a hand-copied list, for the same reason
 * the parity test reuses it: a client name added on the jq side must not have to be remembered
 * here too. Case-sensitive, like the rule it guards (jq's `_mysql_anchor` has no `(?i)`).
 *
 * This is the last of the "a mask deletes the word a later rule needs" family that issue #116
 * opened, and it is measured, not reasoned about: 5,454 of 150,480 generated inputs leaked on
 * the first version of this fix, every one of them shaped `<non-ascii>token <sep> mysql
 * -p<password>`. Masking `mysql` as `token`'s value deletes the only anchor `_mysql_pw_all`
 * has, so the client-anchored `-p<password>` behind it - a password this port masks on `main`
 * and in jq - survives. Deferring the whole ambiguous pass past 5b is not the fix either: in
 * the mirror shape (`mysql -p\u00a9token S3cretPw`) the span eats `\u00a9token` and the deferred pass
 * is left with no keyword to anchor on, which measured 144 leaks of its own. So the mask stays
 * at step 3 and stops in front of the client name instead.
 *
 * Stopping here costs nothing in masking: the generic keyword rule (pass 6) runs the SAME
 * separator and value alternatives over the SAME keyword, one pass later, and masks this value
 * then - which is exactly what jq's own generic rule does with it, since jq's Token rule either
 * ate the copula (boundary fires) or never fired (boundary refuses) and left the client name
 * standing for `_mysql_pw_all` to use. What it does NOT cover is a client name glued into a
 * longer word (`mysql-pw`, `xbmysql`): the search says yes, the real anchor may say no, and the
 * cost of that false positive is the mask waiting for pass 6 instead of happening at pass 3.
 */
const MYSQL_ANCHOR_IN_VALUE = new RegExp(MYSQL_CLIENT);

/**
 * Pass 5b's `-p` and the head of its value, enough to ask what that mask WOULD swallow. The lead is
 * part of the pattern rather than decoration: pass 5b anchors on `MYSQL_LEAD` + `-p`, so a `-p` with
 * no space or tab (or backslash-newline continuation) in front of it is part of a flag NAME, not a
 * password - `--port 3306`, `--skip-pager`, `--protocol`. Matching the bare `-p` text instead asked
 * the keyword question about `--port`'s `ort`, answered "not a keyword", left the client name for a
 * pass that then masked `-ppassword` outright, and kept the secret: `©token mysql --port 3306
 * -ppassword S3cretPw9X` leaked on the first version of this scanner while `jq` (with the hooks' own
 * defs) and a build of `main` both masked it. The value head stops at whitespace and at the span's
 * hard stops, so a captured value never reads past the argument `_mysql_pw_all` masks - a newline
 * included, since `\s` covers it.
 */
const MYSQL_PW_AHEAD = new RegExp(MYSQL_LEAD + "(-p[\"']?[^\\s\"'`;|&]+)");

/**
 * The characters that end the region pass 5b's span can reach from a client name: a shell command
 * separator or a newline. A `-p` behind one of those sits behind a mask 5b will never anchor on, so
 * answering the keyword question about it protects nothing - which is why the scanner stops here
 * instead of scanning on to the end of the string.
 */
const MYSQL_PW_STOP = /[;|&\r\n]/;

/**
 * Which of three things sits ahead of an ambiguous-zone client name, as seen from position `from`.
 * (Review of dynamic/throughline#122, second round wrote the first version of this as a two-valued
 * question - "would 5b swallow a keyword?" - as though preserving the client name were always the
 * safe move. It is not, in either of two directions.)
 *
 * `\u00a9token mysql -ppassword S3cretPw9X` is the input that made it three-valued-ish to begin with.
 * Where jq's boundary FIRES after \u00a9 its Token rule eats `mysql` outright, `_mysql_pw_all` never
 * anchors, and jq's generic keyword rule reads the glued `ppassword` as a keyword and masks the
 * secret behind it: `\u00a9Token *** -ppassword ***`. This port preserved `mysql` for pass 5b, pass 5b
 * masked `-ppassword` - a password that is also a keyword - and the generic rule was left with no
 * keyword to anchor on: `\u00a9token *** -p*** S3cretPw9X`, secret in cleartext, on an input `main`
 * masks. 288 such inputs in the review's 233,280-input fuzz, all of them this shape. So a
 * keyword-shaped password ahead is answered by MASKING the client name (`eats-keyword`), which is
 * what the boundary-fires reading masks and, on the boundary-refuses side, more than jq - the
 * accepted direction of this zone.
 *
 * `none` is the third answer, and it is a mask for the opposite reason: when no `-p` that pass 5b
 * could reach lies ahead (none before a `MYSQL_PW_STOP`, or none at all), keeping the client name
 * intact buys nothing - there is no 5b mask to protect - while the cost is real. `\u00e9token mysql `
 * repeated 26,000 times has no `-p` anywhere, so every `mysql` was left standing for pass 5b, which
 * retried its line-long span from each of the 26,000 client names: 155 s on this branch against
 * 3 ms on `main` (`redactMysqlPw` accounted for all of it; the same class shape `mysql ` repeated
 * 4,000 times costs 1.6 s on `main` too, so the span's cost predates this PR - what is new is this
 * branch routing a whole class of input into it). Masking the client name here is what `main`'s
 * single `\b` rule did at pass 3, so `none` goes back to the older, cheaper behaviour and masks no
 * less.
 *
 * THE SCAN IS BOUND BY AMORTISATION AND BY REACH, NOT BY A WINDOW, and the window it replaced
 * leaked. The first version sliced `source.slice(from, from + 4096)` per ambiguous match - that was
 * the O(matches x window) cost - and past 4096 code units the `-p` was invisible, so the guard
 * answered "5b will not swallow a keyword", the client name was preserved, and 5b masked a keyword
 * password: `\u00a9token mysql ` + 5,000 `x` + ` -ppassword S3cretPw9X` kept its secret, and so did the
 * same at 100,000 filler and at 4,100 (just past the bound), while `jq` and a build of `main` mask
 * all three. A bound that trades masking for time is not an option in this zone, so the bound is in
 * the work: one forward scan for the whole Token pass, resumed where the last scan stopped, because
 * the positions asked about only move right. A hit ahead of the question is cached and reused; a
 * region with nothing to find is scanned once and answered from the `exhausted` flag. Total regex
 * work is O(source) per Token pass instead of O(matches x window) - with the caveat that a STOP is
 * cached too (`stopPos`), because a stop that has to be rediscovered by every question behind it is
 * the same quadratic wearing a different hat: `\u00e9token mysql ` repeated 26,000 times with a trailing
 * `;` measured 6.1 s against `main`'s 15 ms before that cache existed, and about 5 ms with it.
 *
 * Two things this deliberately does NOT do. It does not restart the scan at a `MYSQL_PW_STOP` for a
 * question positioned BEFORE the stop (that question's own region really has no reachable flag, which
 * is the `none` answer), and it does not reset the `exhausted` flag at a stop, because a question
 * positioned past the stop rescans from its own position and can still find a flag in its own region
 * - so `exhausted` means "nothing ahead of the furthest point scanned", which is all the callers ask.
 *
 * A THIRD thing it does not do, stated as an open gap rather than a claim: `MYSQL_PW_STOP` is a
 * single-character class, and pass 5b's real span (`MYSQL_SPAN_STEPS`) walks past four things this
 * class stops at - a `;` or `|` inside quotes, a backslash-newline continuation, an `N>&M` redirect,
 * and an `&>` redirect. For a client name followed by one of those and then a password, the scanner
 * answers `none`, the client name is masked at pass 3, pass 5b loses its anchor, and the password
 * survives: `\u00e9token mysql -e "select 1;" -pS3cretPw9X`, `\u00e9token mysql db \` newline
 * `-pS3cretPw9X`, `\u00e9token mysql 2>&1 -pS3cretPw9X` and `\u00e9token mysql &>/dev/null -pS3cretPw9X`
 * all do this (review round 2 of dynamic/throughline#122, finding 2, verified against `jq` there).
 * `main` leaks all four too, so this is not a regression - it is the part of the class this round ran
 * out of budget on. Closing it means driving the scanner with `MYSQL_SPAN_STEP` itself, and that has
 * to be measured rather than assumed: 5b's own span is what makes `mysql ` repeated 4,000 times cost
 * 1.6 s on `main`, so asking 5b's question exactly re-buys 5b's cost and needs its own linearity
 * proof. The timing test below pins the two shapes that are covered, not these four.
 */
type MysqlPwAhead = 'none' | 'safe-to-defer' | 'eats-keyword';

function makeMysqlPwKeywordScanner(source: string): (from: number) => MysqlPwAhead {
  // One alternation, so "which comes first" is answered by the match itself rather than by two
  // searches that could disagree: either a flag pass 5b could anchor on, or the end of the region
  // that flag could reach.
  const scan = new RegExp(MYSQL_PW_AHEAD.source + "|[" + MYSQL_PW_STOP.source.slice(1, -1) + "]", "g");
  let hitPos = -1;
  let hitState: MysqlPwAhead = 'none';
  let stopPos = -1;
  let exhausted = false;
  return function mysqlPwAhead(from: number): MysqlPwAhead {
    // A cached flag still ahead of the question answers it. Neither alternative can match zero
    // width (the first carries its lead and the `-p`, the second is one character), so `exec`
    // always advances and a null result is final for every question asked from behind it.
    if (hitPos >= from && hitPos !== -1) return hitState;
    if (exhausted) return 'none';
    // The same answer for a cached STOP, and this one is load-bearing rather than a micro-optimisation:
    // without it every question asked from before the stop rescans the whole run to reach it again,
    // which put `\u00e9token mysql ` repeated 26,000 times plus a trailing `;` at 6.1 s (15 ms on `main`).
    // A stop ahead of `from` means the region this question could reach has already been walked and
    // held no flag, so the answer is `none` without a scan. Cached separately from `hitPos` because a
    // stop does not end the scan - a question positioned past it rescans and may well find a flag in
    // its own region.
    if (stopPos >= from && stopPos !== -1) return 'none';
    // Every path that gets here was asked from behind the last hit and behind the last stop, so the
    // scan resumes at the question's own position; nothing is re-walked, because the answers that
    // would have needed re-walking are the two caches above.
    scan.lastIndex = from;
    const m = scan.exec(source);
    if (m === null) {
      exhausted = true;
      hitPos = -1;
      hitState = 'none';
      return 'none';
    }
    if (m[1] === undefined) {
      // Reached the end of the region pass 5b can cover before reaching any flag. Reported as
      // `none`, which the caller answers with a mask, and remembered as `stopPos` so the questions
      // that sit behind the same stop do not walk back to it one at a time.
      stopPos = m.index;
      hitPos = -1;
      hitState = 'none';
      return 'none';
    }
    hitPos = m.index;
    // The capture carries its lead and the `-p` itself; the value is the part 5b would replace.
    hitState = KEYWORD_CONTAINED.test(m[1].replace(/^[ \t]?-p["']?/, '')) ? 'eats-keyword' : 'safe-to-defer';
    return hitState;
  };
}

/**
 * The two anchors the Token-scheme word rule is split across, and why one rule became two
 * (issue #116).
 *
 * `\b` is the one anchor this port cannot copy: Oniguruma reads it as Unicode-aware and JS
 * reads it as ASCII-only. That is not a boundary that shifts by one character, it is a rule
 * that fires on one engine and not the other, and a scheme rule that fires early EATS the
 * keyword a later rule needs: on `\u00fcTOKEN is <secret>` jq's `\b` refuses to anchor after \u00fc,
 * its Token rule never fires, and its GENERIC keyword rule masks the value; JS's `\b` does
 * fire, this rule ate `TOKEN is` and wrote `Token ***`, and the value survived in cleartext.
 * That is the leak dynamic/throughline#116 reports, and it is the third instance of the
 * mechanism the `\b` rows in `ENGINE_DIVERGENCES` pin for `SG.` and the MySQL client anchor.
 *
 * The obvious fix - refuse every non-ASCII code unit in front of `token`, over-approximating
 * Oniguruma's refusing side - was measured over 36,480 generated inputs and is WRONG: it
 * closed those 2,016 leaks and opened 1,008 new ones in the same sweep. Standing down is not
 * neutral either, because the generic rule can then read the whole `<non-ascii>token` as the
 * VALUE of an earlier keyword (`password \u00a9token S3cretPw`) and leave the real secret behind
 * it with no keyword in front of it at all. Firing too often eats a keyword; refusing too
 * often turns one into a value. Both leak.
 *
 * So the rule is split at the seam instead of being moved to one side of it:
 *   - TOKEN_ASCII_ANCHOR: where the two engines AGREE about the boundary (start of input, or
 *     an ASCII non-word character in front), this rule fires and writes jq's literal
 *     `Token ***`;
 *   - TOKEN_AMBIGUOUS_ANCHOR: where the character in front is non-ASCII, this port cannot
 *     know which side of `\b` jq lands on - no JS class reproduces Oniguruma's word set
 *     (`[\p{L}\p{N}\p{M}_]` disagrees on 583 of 19,979 probed code points, and `\p{...}` needs
 *     the `u` flag the identity escapes in this file's `\S`-spelled classes reject). It masks
 *     the value EITHER WAY, but through the GENERIC rule's separator and value alternatives
 *     (KEYWORD_SEPARATOR / KEYWORD_VALUE) and with the keyword and separator written back
 *     intact, so it deletes neither the keyword nor the copula a later pass needs.
 *
 * That ordering is what makes the ambiguous branch safe in both directions: it never masks
 * less than jq's Token rule (its separator alternatives are a superset of jq's `\s+`, its value
 * class a superset of jq's `[A-Za-z0-9._-]+`, so every value jq's rule masks gets masked), and it
 * stops in front of a word a later rule still needs - the copula, and the MySQL client name
 * `_mysql_pw_all` anchors on (`MYSQL_ANCHOR_IN_VALUE`). The client-name half of that sentence is
 * CONDITIONAL, and this comment used to state it unconditionally while the 288-input
 * keyword-password class disproved it: preserving the client name is only the safe move while pass
 * 5b masks a password that is not itself a keyword AND can reach it, so `makeMysqlPwKeywordScanner`
 * is asked which of three things lies ahead and the mask goes ahead over the client name both when
 * 5b would swallow a keyword and when 5b can reach no flag at all (see that function and the
 * `mysqlPwAhead` use sites below). Where jq's `\b` refuses (\u00fc, \u00e9, \u0663,
 * \u4e2d: letters and digits in Unicode terms) and the walked run stops at a pair the generic rule
 * can still reach, the output is jq's byte for byte. It is NOT byte for byte in general, and this
 * comment used to claim it was: when the value behind the copula is itself a keyword the mask
 * walks over the whole run (`\u00a0token is password S3cretPw9` \u2192 this port ` token is ***`, the
 * hooks ` Token *** password ***`), so ordinary words inside that run get masked here and left
 * visible by jq. Those over-masks are pinned row by row in `ENGINE_DIVERGENCES` (several `over`
 * rows, not one) and they are the accepted cost of a zone this port cannot resolve. Where jq's
 * `\b` fires (\u00a9, an em dash, an astral character - the port sees the low surrogate, which is
 * above ASCII either way, so the astral planes land on the safe side too) the port keeps the
 * keyword's own spelling where jq writes `Token ***`, a literal difference on a line where both
 * engines masked the value.
 *
 * The prompt path deliberately keeps a single `\b` rule (see `redactAuthSchemesProse`):
 * `redactPrompt` runs no generic keyword rule at all, so there is nothing to reproduce jq's
 * fall-through with - masking there is an over-mask in the safe direction, and splitting the
 * anchor would only remove a mask.
 */
const TOKEN_ASCII_ANCHOR = String.raw`(?<![A-Za-z0-9_\u0080-\uffff])`;
/** See TOKEN_ASCII_ANCHOR: the prefix characters where the two engines disagree about `\b`. */
const TOKEN_AMBIGUOUS_ANCHOR = String.raw`(?<=[\u0080-\uffff])`;

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
function maskAmbiguousTokenZone(source: string): string {
  const ambiguous = new RegExp(
    `(?<k>${TOKEN_AMBIGUOUS_ANCHOR}${foldSpelled("token")})(?<s>${KEYWORD_SEPARATOR})(?<v>${KEYWORD_VALUE})`,
    "gi",
  );
  /**
   * The ambiguous-zone mask, applied as an explicit scan rather than a `replace` callback
   * because of the one case the match cannot answer on its own: a value that is itself a
   * keyword (`<NBSP>token is password S3cretPw`). Under the reading where jq's boundary fires
   * there, jq's Token rule ate the copula, `password` survived as a keyword, and jq's generic
   * rule went on to mask `S3cretPw`. Masking only the value here deletes that keyword and leaks
   * the secret behind it - the same mistake the anchor change made in the other direction, one
   * word further right. So when the value is keyword-like the mask walks forward over the pairs
   * it heads and masks the whole run: a superset of what either reading masks, at the cost of a
   * few ordinary words on a line that already carries a non-ASCII character glued in front of
   * `token`. A `replace` callback cannot do this - it replaces its own match region and no
   * farther - hence the scan.
   *
   * The walk stops after the first pair whose value does not contain a keyword
   * (`KEYWORD_CONTAINED`, deliberately wider than the ASCII-anchored `KEYWORD_HEAD`: see its
   * comment), so it is linear and never runs past the pair that holds the secret - and it stops
   * BEFORE a pair whose value carries a MySQL client name, because that pair is pass 5b's
   * anchor and a run that swallowed it leaks the `-p<password>` behind it.
   *
   * The sentinel branch is unreachable today (`redactUrlUserinfo` runs after this pass, so no
   * user text can contain the sentinel) and is kept so this pass stays the same function of its
   * groups as `keywordReplacement`.
   */
  let out = "";
  let cursor = 0;
  // One forward `-p` scan for this whole pass, not one per question - see
  // `makeMysqlPwKeywordScanner` for why the bound can be neither a window nor unbounded work.
  const mysqlPwAhead = makeMysqlPwKeywordScanner(source);
  ambiguous.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ambiguous.exec(source)) !== null) {
    const { k, s, v } = match.groups as { k: string; s: string; v: string };
    if (v === REDACT_SENTINEL) continue;
    // The value is a later rule's anchor: mask nothing here and let `_mysql_pw_all` have it - but
    // only when that pass has something it can actually reach to mask, and only when what it masks
    // is not a keyword.
    let end = match.index + match[0].length;
    const clientName = MYSQL_ANCHOR_IN_VALUE.test(v);
    // Three answers, not two (see `makeMysqlPwKeywordScanner`): deferring is right only when pass
    // 5b has a REACHABLE, NON-keyword password in front of it. When it would swallow a keyword the
    // mask has to happen here, because deleting that keyword is what leaves the generic rule no
    // anchor - and the run behind it has to be walked too, because the same consumption problem
    // sits one word further right (`\u00a9token is mysql -ptoken password S3cretPw9X`: the generic rule
    // masks `-ptoken`'s value `password` and the real secret behind it survives, while jq masked
    // `-ptoken` at 5b and kept `password` intact as a keyword). When 5b can reach no flag at all
    // (`none`), deferring protects nothing and leaves the client name standing for 5b's span to
    // retry - which is the 155 s on `\u00e9token mysql ` repeated 26,000 times, where `main` masked the
    // name at pass 3 in milliseconds. So `none` masks here, like `main` did, and does not walk.
    const ahead = clientName ? mysqlPwAhead(end) : 'safe-to-defer';
    if (clientName && ahead === 'safe-to-defer') continue;
    const walksAsKeyword = KEYWORD_CONTAINED.test(v) || (clientName && ahead === 'eats-keyword');
    if (walksAsKeyword) {
      KEYWORD_PAIR_STICKY.lastIndex = end;
      let pair: RegExpExecArray | null;
      while ((pair = KEYWORD_PAIR_STICKY.exec(source)) !== null) {
        // Same guard one pair further right: the walk masks a RUN, and a run that swallows a
        // client name starves pass 5b exactly as the single-pair mask above would. It stops
        // BEFORE this pair rather than over it, so the client name stays on the line - but only
        // while 5b still has a reachable flag of its own to mask past here.
        if (MYSQL_ANCHOR_IN_VALUE.test(pair[1]) && mysqlPwAhead(KEYWORD_PAIR_STICKY.lastIndex) === 'safe-to-defer') break;
        end = KEYWORD_PAIR_STICKY.lastIndex;
        if (!KEYWORD_CONTAINED.test(pair[1])) break;
        KEYWORD_PAIR_STICKY.lastIndex = end;
      }
    }
    out += source.slice(cursor, match.index + k.length + s.length) + "***";
    cursor = end;
    // Never let the scan re-enter what the walk already masked: a second `token` inside the
    // walked run would otherwise emit its own `***` and rewind the cursor, duplicating text.
    if (ambiguous.lastIndex < cursor) ambiguous.lastIndex = cursor;
    if (ambiguous.lastIndex === match.index) ambiguous.lastIndex++;
  }
  return out + source.slice(cursor);
}

/**
 * The two-anchor Token pass, command path. The ambiguous zone is masked FIRST, over the
 * untouched input, and the ASCII-anchored rule runs over its output - not the other way round,
 * which is what leaked `\u00a9token token password S3cretPw` (found by the 150,480-input sweep that
 * was built to check the MySQL-anchor fix):
 *
 *   - jq's `\b` fires after \u00a9, so its leftmost match is the FIRST `token` and eats the second
 *     one as its value, leaving `password S3cretPw` for the generic rule to mask;
 *   - this port refused that first position (that is the whole point of the split), so an
 *     ASCII-anchored pass run afterwards found its leftmost match at the SECOND `token` and ate
 *     `password` - the keyword the generic rule needed - and `S3cretPw` survived.
 *
 * Masking the ambiguous zone first removes that mismatch: the zone's own scan already walks
 * past the pairs a refused earlier match would have left reachable, so anything the ASCII rule
 * can still see past the zone is text where the two engines agree about the match, and a
 * `***` written by the zone is not a keyword either anchor can re-match.
 */
function redactTokenScheme(str: string): string {
  // jq: the bare `\\btoken\\s+...` gsub in `redact`, command path, no length floor - split
  // into the two anchors above, whose comment carries the reason (issue #116).
  const agreed = new RegExp(`${TOKEN_ASCII_ANCHOR}${foldSpelled("token")}${JS_WS}+([${FOLD_ALNUM}._-]+)`, "gi");
  return maskAmbiguousTokenZone(str).replace(agreed, "Token ***");
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
  // `\b` stays here on purpose, where the command path split its anchor at the seam (see
  // TOKEN_ASCII_ANCHOR): this path has no generic keyword rule to fall through to, so a
  // non-ASCII letter in front of `TOKEN` is a case where jq's `\b` refuses, jq stores the value
  // whole, and this port masks it anyway. That is an over-mask in the safe direction; copying the lookbehind
  // here would turn it into a leak on both engines.
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
      "(" + KEYWORD_SEPARATOR + ")" +
      "(" + KEYWORD_VALUE + ")";
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
  const asciiKeywordSeenByPass6a = KEYWORD_HEAD;
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
