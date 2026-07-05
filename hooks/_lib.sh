#!/bin/sh
# throughline — shared helpers for hook scripts.
#
# Resolves the data directory where session state lives. Precedence:
#   1. $THROUGHLINE_DATA_DIR (absolute, or relative to the project root)
#   2. .claude/throughline/   (default — universal Claude Code workspace dir)
#
# Set THROUGHLINE_DATA_DIR=.agent/handoff in your environment to unify with a
# portable .agent/ handoff convention used by other harnesses.

tl_root() {
  printf '%s' "${CLAUDE_PROJECT_DIR:-$PWD}"
}

# Machine-wide kill switch: THROUGHLINE_DISABLE set to anything but "0" turns
# every hook into a no-op, everywhere, regardless of per-project state or
# .throughlineignore. This is the "off on this whole machine" knob the
# per-project marker file can't provide (auto-activation would otherwise
# require dropping .throughlineignore into every project). Checked by all four
# hooks directly (not only via tl_active): a kill switch that still printed
# orientation or stamped buffers would not read as "off."
tl_disabled() {
  [ -n "${THROUGHLINE_DISABLE:-}" ] && [ "$THROUGHLINE_DISABLE" != "0" ]
}

# POSIX sh has no `local`; helpers prefix their temporaries with `_tl_` so they do
# not clobber a same-named variable in the sourcing hook.
tl_data_dir() {
  _tl_root=$(tl_root)
  if [ -n "$THROUGHLINE_DATA_DIR" ]; then
    case "$THROUGHLINE_DATA_DIR" in
      /*) printf '%s' "$THROUGHLINE_DATA_DIR" ;;
      *)  printf '%s/%s' "$_tl_root" "$THROUGHLINE_DATA_DIR" ;;
    esac
  else
    printf '%s/.claude/throughline' "$_tl_root"
  fi
}

# True when a data dir already exists for this project, or a HANDOFF.md is
# present in it - independent of .throughlineignore. Kept separate from
# tl_active (which also decides whether to bootstrap and honors the opt-out)
# because two different needs already required a query without the mutation:
# session-flush.sh/session-precompact.sh need to finalize bookkeeping for a
# buffer that already exists regardless of a mid-session opt-out, and
# session-onboard.sh needs to keep orienting toward EXISTING content (a
# HANDOFF.md pointer, unconsumed buffers) even when .throughlineignore is
# present - the opt-out means "stop adding new content," not "stop telling me
# what already exists." A prior version bundled both into tl_active alone,
# which forced those callers to re-derive this check inline with a comment
# explaining why they could not just call tl_active - a future caller reaching
# for tl_active by name (it reads as a plain predicate) could easily miss the
# bootstrap side effect and reintroduce that exact bug.
tl_data_exists() {
  _tl_d=$(tl_data_dir)
  [ -d "$_tl_d" ] || [ -f "$_tl_d/HANDOFF.md" ]
}

# Activation decision for this project, in strict precedence:
#   0. THROUGHLINE_DISABLE (tl_disabled) -> OFF machine-wide, unconditionally.
#   1. .throughlineignore at the project root -> OFF for NEW tracking
#      unconditionally (existing data, per tl_data_exists, is unaffected).
#   2. data dir already exists, or a HANDOFF.md is present -> already active.
#   3. otherwise auto-activate: bootstrap the data dir. Every project touched by
#      Claude Code with throughline installed activates on the first hook fire.
# Returns non-zero (stay silent) if the opt-out marker is present, or if the
# bootstrap mkdir fails - so any hook that proceeds past this call is guaranteed
# a data dir on disk (session-capture.sh's breadcrumb path depends on that).
#
# Also sets $_tl_active_reason to "disabled", "ignored", or "bootstrap-failed" on the
# non-zero paths (unset/stale on the zero path - callers that care check it
# immediately after calling tl_active, before any other _tl_-prefixed call
# might overwrite it). A failed bootstrap must never look identical to a
# deliberate opt-out: onboard is the one hook with a visible voice and uses
# this to warn when auto-activation itself failed (permissions, disk full),
# so that failure doesn't silently masquerade as "user opted out."
tl_active() {
  unset _tl_active_reason
  if tl_disabled; then
    _tl_active_reason="disabled"
    return 1
  fi
  if [ -f "$(tl_root)/.throughlineignore" ]; then
    _tl_active_reason="ignored"
    return 1
  fi
  tl_data_exists && return 0
  _tl_d=$(tl_data_dir)
  if mkdir -p "$_tl_d" 2>/dev/null; then
    return 0
  fi
  _tl_active_reason="bootstrap-failed"
  return 1
}

# jq is a hard dependency for capture (it parses the hook payload). When it is
# missing, capture cannot record anything; the onboard hook surfaces a visible
# warning so the failure is never silent.
tl_have_jq() {
  command -v jq >/dev/null 2>&1
}

# Sanitize a session id for safe use as a filename: keep only [A-Za-z0-9._-],
# collapsing everything else to '_'. Rejects empty / '.' / '..' by printing
# nothing (callers treat empty output as "no usable id"). Prevents slashes in a
# session_id from creating stray subdirectories or escaping the buffer dir.
# Known tradeoff: this collapse is lossy, so two different ids that disagree
# only in disallowed characters (e.g. "abc/def" vs "abc:def") sanitize to the
# same filename. Currently unreachable: Claude Code session_ids are UUIDs,
# which already consist entirely of allowed characters and pass through
# unchanged. Revisit if session_ids ever stop being UUID-shaped.
tl_safe_sid() {
  _tl_s=$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')
  case "$_tl_s" in ''|.|..) printf '' ;; *) printf '%s' "$_tl_s" ;; esac
}

# Resolve and sanitize the session_id from a hook's raw JSON stdin payload in
# one step. Shared by session-capture.sh, session-flush.sh, and
# session-precompact.sh, which all key their buffer filename off this exact
# derivation - letting it drift between them once already desynced filenames
# for a session_id containing a tab (capture used to extract it differently
# than the other three). Prints "" if jq is unavailable or session_id is
# absent/unsafe; safe to call even where the caller has not separately
# checked tl_have_jq.
tl_resolve_sid() {
  tl_have_jq || { printf ''; return; }
  _tl_raw=$(printf '%s' "$1" | jq -r '.session_id // ""' 2>/dev/null)
  tl_safe_sid "$_tl_raw"
}

# Replace control characters (including newlines) with a space. Shared by
# session-flush.sh and session-precompact.sh so their reason/trigger fields
# can't break the `<!-- ... -->` marker they're embedded in. (The jq `clean` def in
# tl_jq_redact_defs below duplicates this rule rather than calling it: the
# capture-side hooks apply control-char
# AND backtick stripping together, per-field, inside one jq pipeline that also
# does redaction — pulling just the control-char half out to a separate shell
# call there would mean an extra process per field for no real safety gain.)
tl_clean_ctrl() {
  printf '%s' "$1" | tr '[:cntrl:]' ' '
}

# Best-effort breadcrumb for the swallowed-failure paths in the capture-side
# hooks (session-capture.sh, session-prompt.sh): capture must never block a
# tool or a prompt, so every failure there still exits 0, but a write failure
# (full disk, lost permissions) would otherwise drop a record with zero trace.
# onboard surfaces this file's presence so the loss isn't silent forever.
# Lives at the data-dir root, NOT under buffer/: tl_active guarantees the data
# dir exists before any caller reaches an error path, but buffer/ may not
# (its mkdir can be the very failure being reported) - if the breadcrumb's own
# target depended on buffer/, the one failure mode this exists to report
# (buffer/ uncreatable) would silently defeat the breadcrumb along with it.
tl_err() {
  printf -- '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$(tl_data_dir)/.capture-errors" 2>/dev/null
}

# Append one timestamped record line to a session buffer, breadcrumbing on write
# failure. Shared by the capture-side hooks (session-capture.sh,
# session-prompt.sh) so the on-disk line format ("- `<ts>` <content>") and the
# write-failure handling live in exactly one place - a prior version spelled
# this sequence out identically in both hooks, the same hand-duplicated drift
# class tl_resolve_sid and the redact defs exist to prevent.
# Args: $1 = buffer dir, $2 = sanitized session id, $3 = formatted content.
tl_append_line() {
  _tl_ts=$(date '+%Y-%m-%d %H:%M:%S')
  # Backticks are literal markdown; %s are printf specifiers; the format string
  # is intentionally not shell-expanded.
  # shellcheck disable=SC2016
  printf -- '- `%s` %s\n' "$_tl_ts" "$3" >> "$1/session-$2.md" 2>/dev/null \
    || tl_err "write failed for session-$2"
}

# Shared jq redaction/cleaning defs for the capture-side hooks. Printed as jq
# program text and prepended to each hook's tool-specific jq body, so every
# hook stays a single jq invocation (the hot-path constraint) while the rule
# set itself cannot drift between hooks - the same consolidation reasoning as
# tl_resolve_sid, which exists because a hand-duplicated derivation already
# caused one real desync bug. Quoted heredoc: the def text passes through
# with no shell expansion of its backslashes or quotes.
tl_jq_redact_defs() {
  cat <<'TL_JQ_DEFS'
  # Mask common secret shapes so raw credentials never sit in the buffer. The
  # buffer is gitignored, but a later handoff distills it into committed logs;
  # this is defense-in-depth, not the only barrier (the skill scrubs too).
  # Best-effort: this is pattern/keyword matching, not entropy analysis, so a
  # bare opaque token with no recognizable shape or keyword will not be caught.
  # Known gap, not fixable here without a high false-positive cost: a
  # credential attached to a bare single-letter CLI flag with no keyword at all
  # (mysql -p<password>, curl -u user:pass) has no keyword for this rule to
  # anchor on, and flags like -u/-p are too overloaded across tools (docker run
  # -u uid:gid, ssh -p <port>) to redact generically. The handoff skill re-scan
  # is the second barrier for exactly this shape.
  #
  # Internal sentinel for one specific hand-off: the URL-userinfo rule below is
  # the only shape rule whose replacement abuts a non-whitespace character (the
  # @ that starts the host). Every other shape rule replacement is naturally
  # whitespace-bounded, so the generic catch-all further down can never run
  # past it by accident. The userinfo rule alone needs to mark its output as
  # "already redacted" so the generic value-capture stops there instead
  # of continuing past the @ into the host/path - this used to be inferred from
  # boundary characters (first @, then briefly /) instead of stated directly,
  # and each version of that inference either deleted real trailing context or
  # under-redacted a genuine secret that happened to contain the same boundary
  # character. The sentinel removes the inference: the generic rule recognizes
  # it explicitly, and the final gsub converts it (and any sentinel a URL with
  # no nearby keyword never reached the generic rule to convert) to the
  # user-facing *** mark.
  def M: "TLREDACTSENTINEL";
  # Structural credential formats factored out so BOTH the command path
  # (`redact`) and the prompt path (`redact_prompt`) share them without
  # duplication. These are the rules that match distinctive shapes - PEM
  # blocks, URL userinfo, and the well-known token PREFIXES (ghp_, sk-, AKIA,
  # ...) - and therefore never fire on ordinary English. They are the ONLY
  # rules safe to run over natural-language prompt text (see redact_prompt).
  # _pem and _prefix_tokens are order-independent; _url sets the sentinel M so
  # it must run before any generic value-capture and before the final _unmask.
  def _pem:
    gsub("-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----"; "***private-key-redacted***")
    | gsub("-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*"; "***private-key-redacted***");
  def _url:
    gsub("(?<pfx>://[^:@/\\s]+):(?<pw>[^@/\\s]+)@"; "\(.pfx):\(M)@");
  def _prefix_tokens:
    gsub("ghp_[A-Za-z0-9]{10,}"; "ghp_***")
    | gsub("github_pat_[A-Za-z0-9_]{10,}"; "github_pat_***")
    | gsub("gh[oprsu]_[A-Za-z0-9]{10,}"; "gh_***")
    | gsub("xox[baprs]-[A-Za-z0-9-]{6,}"; "xox-***")
    | gsub("sk-[A-Za-z0-9_-]{10,}"; "sk-***")
    | gsub("AKIA[0-9A-Z]{12,}"; "AKIA***")
    | gsub("AIza[0-9A-Za-z_\\-]{35}"; "AIza***");
  def _unmask: gsub("\(M)"; "***");
  # Authorization SCHEME rules (Bearer/Basic) - COMMAND-PATH version, used only
  # by `redact`. No length minimum on the bearer value and only an 8-char floor
  # on Basic's base64 run: commands aren't natural language, so "bearer X" /
  # "Basic <8+ chars>" essentially never appears as an innocent phrase there,
  # unlike in prose (see _auth_scheme_prose below, which `redact_prompt` uses
  # instead - the two are deliberately NOT shared, because the constraint that
  # makes one safe would either under-redact the other's real shapes or
  # false-positive on the other's ordinary text).
  def _auth_scheme:
    gsub("(?i)bearer\\s+(?<t>[A-Za-z0-9._\\-]+)"; "Bearer ***")
    | gsub("(?i)\\bbasic\\s+[A-Za-z0-9+/=]{8,}"; "Basic ***");
  # Authorization SCHEME rules - PROSE-SAFE version, used only by
  # `redact_prompt`. A bare 8-char base64-alphabet floor or an unbounded bearer
  # value both false-positive constantly on ordinary English: "bearer of good
  # news" (any following word matches the bearer value's char class), "basic
  # authentication support" / "basic documentation" (English words are a
  # subset of the base64 alphabet, and words like "authentication" clear an
  # 8-char floor easily). A real Authorization value - JWT, opaque API token,
  # or a base64-encoded "user:pass" - is reliably much longer than a single
  # English word in a sentence (single English words average ~5 chars; JWTs
  # and opaque tokens commonly run 20-100+); requiring 16+ contiguous
  # non-whitespace chars keeps the false-positive rate low without requiring a
  # digit/mixed-case heuristic that would itself have real-credential misses.
  # Known tradeoff, same class as `redact`'s documented gaps: a real credential
  # shorter than 16 chars slips through this rule (the generic key:value rule
  # below still catches it if pasted with an explicit "password: xxx" shape;
  # otherwise the handoff skill's human re-scan is the backstop).
  def _auth_scheme_prose:
    gsub("(?i)bearer\\s+(?<t>[A-Za-z0-9._\\-]{16,})"; "Bearer ***")
    | gsub("(?i)\\bbasic\\s+[A-Za-z0-9+/=]{16,}"; "Basic ***");
  # Full command-path redaction. Shape-specific patterns run BEFORE the generic
  # keyword=value catch-all, so e.g. "Authorization:Basic <base64>" is fully
  # consumed by the Basic-auth rule rather than the generic auth keyword rule
  # eating just the Basic token and leaving the base64 payload exposed. Same
  # reasoning for the dedicated Token rule (DRF/GitLab-style "Authorization:
  # Token <value>" headers): without it, the generic rule treats the scheme
  # word "Token" itself as the value to mask and leaves the real key in
  # plaintext right after it. The bearer/token word rules run BEFORE
  # _prefix_tokens so a "bearer ghp_..." is consumed whole rather than the
  # prefix rule masking the ghp_ body first and the bearer rule then re-masking
  # the leftover. The generic keyword group has trailing \w* too (not just
  # leading) so compound names like SECRET_KEY= or API_KEY_VALUE= still match.
  # Its separator group accepts a copula (is/was/are) and bare whitespace in
  # addition to :/= so command descriptions phrased as "password is X" / bare
  # "password X" still mask X. That aggressiveness is CORRECT for commands but
  # WRONG for prose (it eats the word after any keyword+copula, inverting
  # "password is not the problem" -> "password is ***"), which is exactly why
  # prompts use redact_prompt below instead. Value group has no @ or /
  # exclusion - it matches the sentinel when present, else the unbounded run up
  # to whitespace/quote - so a secret containing either char is fully masked.
  def redact:
    _pem
    | _auth_scheme
    | gsub("(?i)\\btoken\\s+(?<t>[A-Za-z0-9._\\-]+)"; "Token ***")
    | _url
    | _prefix_tokens
    | gsub("(?i)(?<k>\\w*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|credential|auth(?:orization)?|client[_-]?id)\\w*)(?<s>\\s*[:=]\\s*|\\s+(?:is|was|are)\\s+|\\s+)(?<v>\"?(?:\(M)|[^\\s\"]+))"; "\(.k)\(.s)***")
    | _unmask;
  # Prose-safe redaction for user prompts (issue #5). Prompts are natural
  # language, not commands: running them through `redact` corrupts and can
  # invert ordinary English (the copula/bare-space generic rule and the bare
  # "token" WORD rule both fire on prose - "token refresh flow" -> "Token ***
  # flow"), destroying the very intent the feature exists to preserve. So this
  # path keeps ONLY the structural formats that never match English
  # (_pem/_url/_prefix_tokens/_auth_scheme_prose - see that def for why Basic/
  # Bearer need their OWN length-gated variant here, not the command one)
  # plus a generic keyword rule RESTRICTED to explicit key:value / key=value
  # separators - which still catches a credential pasted as "password: hunter2"
  # or "API_KEY=xxx" while leaving "the password is not the problem" untouched.
  #
  # The keyword group is bounded by a LETTER lookaround here (unlike redact's
  # `\w*...\w*`-affixed version), matching each keyword only when no LETTER
  # touches either side: "auth"/"authorization" as whole words never match as
  # a substring of "author"/"authority"; "token" never matches inside
  # "tokens". But unlike a literal `\b` boundary, an adjacent UNDERSCORE still
  # counts as a match boundary, so SCREAMING_SNAKE_CASE compounds
  # (CLIENT_SECRET, ACCESS_TOKEN, DB_PASSWORD) - the standard real-world
  # credential-naming convention, and exactly what a pasted .env file or curl
  # command uses - still redact correctly. redact's looser `\w*...\w*` affixes
  # exist for the same compound-name reason on the command path; prompts are
  # prose by definition, so a `\w*` (which also treats letters as valid
  # boundary-crossers) would additionally match inside "author"/"tokens" -
  # hence the tighter letter-only lookaround here instead of reusing it.
  #
  # A pasted secret with no recognizable prefix/scheme AND no colon/equals
  # (e.g. a bare word after "password is") is deliberately NOT masked here;
  # the handoff skill's human re-scan is the second barrier, same as for the
  # bare-CLI-flag gap `redact` documents.
  #
  # The keyword group is bounded by LETTER lookaround, not `\b`: `\b` is a
  # transition between a \w char and a non-\w char, and underscore IS a \w
  # char, so `\bsecret\b` does NOT match "secret" inside "client_secret" or
  # "SECRET" inside "DB_PASSWORD"'s sibling "PASSWORD" - it would silently fail
  # to redact the single most common real-world credential-naming convention
  # (SCREAMING_SNAKE_CASE: CLIENT_SECRET, ACCESS_TOKEN, DB_PASSWORD, ...),
  # exactly the compounds a pasted .env file or curl command uses. Lookaround
  # on "not a letter" instead of "not a word char" treats the underscore as a
  # valid boundary (so the compound still matches) while still rejecting a
  # letter on either side (so "author"/"authority"/"tokens" still don't match
  # "auth"/"auth"/"token" as a prefix - the false-positive `\b` was tightened
  # for in the first place). Digits are deliberately left out of the boundary
  # class too (neither excluded nor required): a keyword directly touching a
  # digit is rare enough in both prose and real credential names not to be
  # worth the extra rule complexity either way.
  def redact_prompt:
    _pem
    | _auth_scheme_prose
    | _url
    | _prefix_tokens
    | gsub("(?i)(?<k>(?<![A-Za-z])(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|credential|auth(?:orization)?|client[_-]?id)(?![A-Za-z]))(?<s>\\s*[:=]\\s*)(?<v>\"?(?:\(M)|[^\\s\"]+))"; "\(.k)\(.s)***")
    | _unmask;
  # Neutralize control chars (incl. newlines) and backticks so a captured
  # command or prompt cannot break the markdown list / code span it is
  # embedded in. The control-char half mirrors the shared `tl_clean_ctrl`
  # shell helper (used by session-flush.sh / session-precompact.sh for their
  # reason/trigger fields) but stays a jq def: it runs per-field inside the
  # same jq pipeline as redaction, so factoring it out to a shell call would
  # mean an extra subprocess per field.
  def clean: gsub("[[:cntrl:]]"; " ") | gsub("`"; " ");
  # Clamp a string to $n chars, appending $ell only when it was actually
  # longer. Single-sources the "redact | clean | truncate" tail shared by every
  # capture surface (the read-side tool branches and the prompt hook) so the
  # truncation idiom can't drift between them.
  def clamp($n; $ell): .[0:$n] + (if length > $n then $ell else "" end);
TL_JQ_DEFS
}
