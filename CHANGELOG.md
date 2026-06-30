# Changelog

All notable changes to throughline are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project uses semantic versioning.

## [0.2.0]

A robustness, privacy, and compaction-survival pass driven by a four-lens review
(see `docs/REVIEW-v0.1.0.md`), hardened by a follow-up adversarial pass against
the PR itself (general code review plus silent-failure, test-coverage, and
comment-accuracy specialists) before merge.

### Added (hardening pass)
- **Redaction now covers every captured field**, not just the Bash command:
  the Bash `description` and the Edit/Write/NotebookEdit `file_path` previously
  bypassed `redact` entirely (only control-char cleanup ran), so a credential in
  either field was stored verbatim. Both are now redacted.
- **`buffer/.capture-errors` breadcrumb**: the `mkdir`, `jq` filter, and final
  buffer-write failure paths in capture were silently swallowed with zero trace
  (a known gap called out, but not fixed, in the original v0.1.0 review). Each
  now best-effort appends a one-line breadcrumb; onboard surfaces its presence
  and count so a run of silent capture loss is no longer invisible.
- **Broader redaction coverage**: the GitHub token class now includes `ghr_`
  refresh tokens (was missing the `r` prefix); the generic keyword alternation
  now also matches `credential`, `auth`/`authorization`, and `client_id`; PEM
  private-key redaction now also catches a key body with no `-----END...-----`
  marker (a truncated or streamed key). Documented limitation, unchanged: this
  is pattern/keyword matching, not entropy analysis: a bare opaque token with
  no recognizable shape still passes through.
- **`[failed]` outcome marking scoped to verified schema**: the `exit_code` /
  `error` / `code` heuristics were only ever validated against the real Bash
  `tool_response` shape; they are now applied only when `tool_name == "Bash"`,
  so an unverified field on Edit/Write/NotebookEdit's response can't
  false-positive a `[failed]` marker onto completed work. `is_error` /
  `interrupted` are still checked for every tool type.
- **onboard's "unconsumed buffer" check distinguishes ended from unsure**: a
  buffer carrying the `session-ended` stamp is reported as a confirmed,
  undistilled, ended session; a buffer with no stamp (could be a session still
  live in another terminal, or one that exited without a clean shutdown) now
  gets hedged wording instead of being asserted as "ended" when that wasn't
  actually known.
- **Session id is derived consistently across all four hooks**: capture
  previously tab-split a combined jq output to recover the session id, which
  could desync from how flush/onboard/precompact derive it (e.g. for a
  session_id containing a tab). Capture now resolves the session id via its own
  dedicated jq call, identical to the other hooks.
- **`.capture-errors` lives at the data-dir root, not under `buffer/`**: a
  second review pass found that the breadcrumb's own write target depended on
  `buffer/` already existing, so the one failure mode it most needs to report
  (the `mkdir -p` that creates `buffer/` failing) silently defeated the
  breadcrumb along with it. `tl_active` already guarantees the data dir itself
  exists before any hook proceeds, so the breadcrumb now targets that instead.
  README's gitignore guidance updated to match.
- **`[failed]` no longer false-positives on a benign empty-string `error`**: a
  third review pass found that jq's `//` operator only treats `null`/`false` as
  "absent": a Bash `tool_response` with `exit_code:0` and `error:""` (a
  genuinely successful run) was matched by `(.error? // null) != null` and
  permanently mismarked `[failed]`, exactly the false-positive the prior fix's
  Bash-only scoping was meant to rule out. Now checked as `(.error? // "") !=
  ""`, so only a non-empty error string counts.
- **Control-char stripping shared via a real helper, not just a comment**:
  `session-flush.sh` and `session-precompact.sh` now call a new `tl_clean_ctrl`
  in `_lib.sh` instead of duplicating the same inline jq `gsub`, removing two of
  the three places that rule had to be kept in sync by hand. `session-capture.sh`
  keeps its own inline version (it applies control-char and backtick stripping
  together, per-field, inside the same jq pass that also redacts).
- **Compound credential variable names are now redacted**: a fourth review
  pass found that the generic keyword=value rule only matched when the keyword
  was immediately followed by `:`/`=`/whitespace, so `SECRET_KEY=`,
  `API_KEY_VALUE=`, and similar compound names fell through completely
  unredacted (the keyword group had `\w*` before it but not after). Fixed by
  adding a trailing `\w*` to the keyword group.
- **The same rule no longer deletes trailing URL content past a credential**:
  its value-capture group was unbounded except for whitespace/quotes, so when
  a "token"/"secret" substring appeared inside a URL username (e.g.
  `x-access-token` in a clone URL), the rule re-matched text the
  URL-userinfo rule upstream had already safely redacted and then greedily
  consumed everything through `@` and the rest of the path, replacing the
  whole tail with `***` instead of just the credential. The value group now
  also stops at `@`/`/`.
- **`tl_safe_sid`'s lossy-collapse tradeoff is now documented**: two session
  ids differing only in disallowed punctuation sanitize to the same filename.
  Noted as currently unreachable (Claude Code session_ids are UUIDs, already
  all-allowed characters) rather than restructured, since a collision-resistant
  encoding would cost the human-readable filenames for no live attack path.
- **Fixed an over-correction from the previous fix**: bounding the
  keyword=value value-capture at `/` (to stop it re-consuming a URL path past
  an already-redacted credential) also truncated genuine slash-containing
  secrets (e.g. a realistic AWS-shaped key) after their first `/`, leaving most
  of the value exposed. The URL case only ever needed the boundary at `@` -
  the URL-userinfo rule upstream always leaves `***@` right before the
  host/path, so excluding only `@` (not `/`) fixes both cases at once.
- **`sk-` key redaction now covers dashed multi-segment formats** (Anthropic's
  `sk-ant-api03-...`, OpenAI's `sk-proj-...`): the body character class was
  alnum-only, so the first internal dash in these current real-world key
  formats stopped the match entirely and the whole key passed through
  unredacted.
- **Dropped no-session-id actions now breadcrumb too**, for the same
  visibility reason as the mkdir/jq/write failures - currently unreachable
  (Claude Code always supplies a UUID session_id) but no longer untraceable if
  that assumption ever breaks.
- **Handoff skill's re-scan checklist now names two shapes capture's own
  redaction cannot catch mechanically**: a credential attached to a bare CLI
  flag with no keyword (`mysql -p<password>`, `curl -u user:pass` - flags like
  `-u`/`-p` are too overloaded across tools, e.g. `docker run -u uid:gid`, to
  redact generically without false positives), and the fact that seeing a
  `***` in a captured line doesn't guarantee the *whole* secret was masked.
- **The generic rule now masks the real secret, not an intervening word**: a
  seventh review pass found two more ways the actual credential could survive
  in plaintext. First, natural-language phrasing like `password is X` masked
  the linking word `is` instead of `X` (the separator group only recognized
  `:`/`=`/bare whitespace) - now also accepts `is`/`was`/`are`. Second,
  `Authorization: Token <key>` (a common DRF/GitLab auth-header style) masked
  the scheme word `Token` itself, leaving the real key exposed right after it
  - now has its own dedicated rule alongside the existing Bearer/Basic ones.
- **Fixed another `@`-boundary over-correction**: the value-capture group
  excluded `@` outright to stop the URL-userinfo edge case, which also
  under-redacted a literal secret that happens to contain `@` (a common shape
  for human-chosen passwords). It now only treats `@` as a boundary when it
  immediately follows an already-redacted `***` (the exact mark the
  URL-userinfo rule leaves), so a genuine `@`-containing secret with no
  preceding `***` still falls through to the fully-masked general case.
- **`[failed]` no longer mis-fires on a string-valued `exit_code`**: jq's `!=`
  never considers a string equal to a number, so `exit_code: "0"` (e.g. from a
  wrapper that JSON-stringifies fields) compared unequal to `0` and falsely
  marked a successful command failed. Both sides are now normalized through
  `tostring` before comparing.
- **24 additional test cases** (68 total) covering the above, plus
  previously-uncovered branches: the `tl_active` silent-exit/opt-in-silence
  path, Write/NotebookEdit capture (only Edit was tested), `tl_safe_sid`'s
  `.`/`..` rejection, `THROUGHLINE_DATA_DIR`'s absolute-path branch, command
  truncation, and the breadcrumb surviving a `buffer/`-creation failure.
- **Structural rework of the URL/generic-rule hand-off, replacing the
  boundary-character guessing game**: across rounds five through seven, the
  generic keyword=value rule's relationship to the URL-userinfo rule was
  patched three times by inferring "already redacted" from a boundary
  character right after the `***` mark - first `@`+`/`, reverted to just `@`,
  each version either deleting real trailing URL content or under-redacting a
  genuine secret that happened to contain that same character. The
  URL-userinfo rule now marks its own output with an internal sentinel
  (`TLREDACTSENTINEL`, never written to the buffer) instead of the literal
  `***`; the generic rule recognizes that sentinel explicitly instead of
  inferring it from context, and a final pass converts any sentinel - whether
  the generic rule touched it or not - to the user-facing `***`. The value
  group is now fully unbounded except whitespace/quote in every other case, so
  this removes the `@`-vs-`/` tradeoff entirely rather than picking a side.
- **3 additional test cases** (71 total): a URL credential with no nearby
  keyword at all (proving the final sentinel-to-`***` pass works
  independently of the generic rule), plus a check that the internal sentinel
  itself never leaks into the buffer.

### Added
- **PreCompact hook** (`session-precompact.sh`): stamps a `compaction-boundary`
  marker into the live buffer just before a context compaction, so a later
  handoff knows the seam and distills above-the-line actions from the buffer
  text rather than from lost conversation recall.
- **Compaction recovery in onboard**: on `source=compact`, onboard now reads the
  session id and points Claude back at the surviving on-disk buffer for the
  current session.
- **Missing-jq warning**: when `jq` is absent, capture is impossible; onboard now
  says so loudly instead of letting capture no-op in silence.
- **Tool outcome capture**: interrupted actions are marked `[interrupted]` in
  the buffer (from `tool_response.interrupted`); explicit error flags / non-zero
  exit codes are marked `[failed]` where a tool surfaces them. Note: the Claude
  Code Bash result exposes no exit code, so a plain non-zero command exit is not
  markable from a hook and is left for the handoff to cross-reference against the
  conversation. (Found during review: the original synthetic test asserted an
  `is_error` field that the real payload does not have.)
- **Capture-time secret redaction**: common credential shapes (KEY=VALUE tokens,
  `Bearer` tokens, URL userinfo passwords, `ghp_`/`github_pat_`/`xox`/`sk-`/`AKIA`,
  Google `AIza` keys, `Basic` auth payloads, and inline PEM private-key blocks) are
  masked before anything is written to the buffer. Defense in depth alongside the
  handoff skill's "key names only" rule.
- **Test harness** (`tests/run.sh`) and **CI** (`.github/workflows/ci.yml`):
  shellcheck plus fixture-driven hook tests on every push and PR.

### Changed
- **session_id is sanitized** to a safe, flat filename in capture and flush
  (no path traversal, no stray subdirectories).
- **Edit/Write paths are relativized** to the project root before capture, so
  committed logs no longer leak absolute paths or the OS username.
- **Captured commands are sanitized**: control characters and backticks are
  neutralized so a command can never break the buffer's markdown.
- **Long commands** are marked `…[truncated]` instead of being silently cut.
- **onboard "unconsumed buffer" warning** no longer counts the current session
  (which previously made a mid-session compaction look like "a prior session
  ended without a handoff"); wording clarified.
- **flush end-stamp guard** is anchored to the start of a line, so captured text
  containing the marker cannot suppress a real stamp.
- README "compaction-proof" wording qualified: the raw action buffer survives
  compaction; the reasoning behind it survives only if a handoff ran first.

### Fixed
- **Missing session_id no longer poisons** a shared `session-nosession.md` that
  flush never stamped and onboard re-warned about forever. Such records are now
  dropped.
- onboard root-prefix stripping uses POSIX parameter expansion instead of `sed`,
  fixing breakage when the project path contains regex-special characters.

## [0.1.0]

- Initial release: continuous PostToolUse capture, judged handoff skill,
  SessionStart orientation, SessionEnd safety-net flush, onboard skill.
