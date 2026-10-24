#!/bin/sh
# throughline — re-apply the current redaction rules to existing files (issue #176).
#
# Capture masks secrets as it writes, but a rule added later only protects later
# captures: buffers, archived buffers and HANDOFF/log drafts written before it keep
# whatever leaked then. The handoff skill runs this before distilling, so a leak that
# predates a rule is masked and, just as important, reported.
#
# Usage: sh hooks/rescan.sh FILE [...]
# Each FILE is rewritten in place only when a line changes. Prints one summary line
# per file that changed, naming how many lines were masked and in which classes:
#   rescan: 3 line(s) masked in buffer/session-X.md (keyword 2, prefix 1)
# It never prints a matched value or any part of one. Exit 0 unless a file could not
# be read or written (reported on stderr).
#
# Record lines (`- `<ts>` **TYPE** ...`) are re-redacted the way capture wrote them:
# prompt, websearch and agent records hold prose and get the prose-safe rules
# (`redact_prompt`); every other record gets the command rules (`redact`), applied to
# a bash record's description and command separately so the ` - ` between them is
# never read as a value (older buffers used ` \u2014 ` there). Every other line (headings,
# markers, HANDOFF/log prose) gets the prose-safe rules. Existing `***` masks are kept as
# they are, and a line is rewritten only when it would lose a word: a change that is only
# cosmetic (case, a truncation marker) is left alone and not counted.

DIR=$(unset CDPATH; cd -- "$(dirname -- "$0")" && pwd)
. "${CLAUDE_PLUGIN_ROOT:-$DIR/..}/hooks/_lib.sh" 2>/dev/null || . "$DIR/_lib.sh"

[ "$#" -gt 0 ] || { echo "usage: rescan.sh FILE [...]" >&2; exit 2; }
tl_have_jq || { echo "rescan: jq is required" >&2; exit 2; }

defs=$(tl_jq_redact_defs)
# Classes are attributed per line by applying each structural rule family on its own
# to the original line; a change no family explains alone is the keyword rules'.
# shellcheck disable=SC2016
prog="$defs"'
  def prose_types: ["prompt", "websearch", "agent"];
  # Existing masks become the pipeline sentinel first, which the generic rule takes
  # as a whole value and _unmask turns back into ***: without it, `GH_TOKEN=***;`
  # re-masked as `GH_TOKEN=***` (the `;` eaten) and counted as a leak.
  def keep: gsub("\\*\\*\\*"; M);
  # Words a line lost: alphanumeric runs of 3+ in the old line that no longer occur in
  # the new one, compared case-insensitively (the Token rule capitalizes `token`) and
  # ignoring the truncation marker. A line whose only changes are cosmetic is neither
  # counted nor rewritten - the point is to surface secrets, not churn old archives.
  def words: [scan("[A-Za-z0-9_]{3,}") | ascii_downcase] - ["truncated", "line"];
  def lost($new): (words - ($new | words)) | length > 0;
  # Capture appends the outcome marker (`[failed]`, `[interrupted]`) after redacting,
  # so it is never part of a value: split it off, redact the rest, put it back.
  def body(f):
    if test(" `\\[(failed|interrupted)\\]`$") then
      capture("^(?<x>.*?)(?<o> `\\[(failed|interrupted)\\]`)$") | (.x | f) + .o
    else f end;
  def rec_fix:
    if test("^- `[^`]*` \\*\\*[^*]+\\*\\*") then
      capture("^(?<head>- `[^`]*` \\*\\*(?<type>[^*]+)\\*\\*)(?<rest>.*)$") as $m
      | if ($m.type | IN(prose_types[])) then $m.head + ($m.rest | body(keep | redact_prompt))
        elif $m.type == "bash" and ($m.rest | test(" (-|\u2014) `.*`$")) then
          ($m.rest | capture("^(?<d>.*?)(?<sep> (-|\u2014) `)(?<c>.*)`$")) as $b
          | $m.head + ($b.d | body(keep | redact)) + $b.sep + ($b.c | keep | redact) + "`"
        else $m.head + ($m.rest | body(keep | redact)) end
    else keep | redact_prompt end;
  def classes:
    . as $l
    | [ (if ($l | _pem | _prefix_tokens) != $l then "prefix" else empty end),
        (if ($l | _url | _unmask) != $l then "url" else empty end),
        (if ($l | _mysql_pw_all) != $l then "mysql" else empty end),
        (if ($l | _auth_scheme) != $l then "scheme" else empty end) ]
    | if length == 0 then ["keyword"] else . end;
  split("\n") as $lines
  | [ $lines[] | . as $o | (rec_fix) as $n
      | {old: $o, new: (if ($o | lost($n)) then $n else $o end)} ] as $rows
  | [ $rows[] | select(.old != .new) | (.old | classes[]) ] as $cls
  | { text: ($rows | map(.new) | join("\n")),
      changed: ([ $rows[] | select(.old != .new) ] | length),
      classes: ($cls | group_by(.) | map("\(.[0]) \(length)") | join(", ")) }
'

rc=0
for f in "$@"; do
  if [ ! -f "$f" ] || [ ! -r "$f" ]; then
    echo "rescan: cannot read $f" >&2; rc=1; continue
  fi
  out=$(jq -n --rawfile s "$f" "\$s | $prog" 2>/dev/null) || {
    echo "rescan: could not process $f" >&2; rc=1; continue
  }
  changed=$(printf '%s' "$out" | jq -r '.changed')
  [ "$changed" -gt 0 ] 2>/dev/null || continue
  tmp="$f.rescan.$$"
  if printf '%s' "$out" | jq -j '.text' > "$tmp" 2>/dev/null && mv "$tmp" "$f" 2>/dev/null; then
    echo "rescan: $changed line(s) masked in $f ($(printf '%s' "$out" | jq -r '.classes'))"
  else
    rm -f "$tmp" 2>/dev/null
    echo "rescan: could not rewrite $f" >&2; rc=1
  fi
done
exit "$rc"
