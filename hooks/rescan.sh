#!/bin/sh
# throughline — re-apply the current redaction rules to existing files (issue #176).
#
# Capture masks secrets as it writes, but a rule added later only protects later
# captures: buffers, archived buffers and HANDOFF/log drafts written before it keep
# whatever leaked then. This is the re-scan the handoff skill runs (issue #177), so a
# leak that predates a rule is masked and, just as important, reported.
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
# never read as a value (older buffers used an em-dash there). Every other line (headings,
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
  # A change is real when the line differs once masks, truncation markers and case are
  # set aside: a case change (the Token rule writes `Token`) or a mask that only moved
  # is cosmetic and is neither rewritten nor counted. Anything else - including a
  # secret also present elsewhere on the line, or one with no long alphanumeric run -
  # is a real change.
  def norm: gsub("\\*\\*\\*"; "") | gsub("…\\[(line )?truncated\\]"; "") | ascii_downcase;
  # Capture appends the outcome marker (`[failed]`, `[interrupted]`) after redacting,
  # so it is never part of a value: split it off, redact the rest, put it back.
  def body(f):
    if test(" `\\[(failed|interrupted)\\]`$") then
      capture("^(?<x>.*?)(?<o> `\\[(failed|interrupted)\\]`)$") | (.x | f) + .o
    else f end;
  # A value captured inside backticks (a grep pattern) is redacted inside them, so the
  # closing backtick is never read as part of the value.
  def ticked(f):
    if test("^ `.*`$") then capture("^ `(?<x>.*)`$") | " `" + (.x | f) + "`" else f end;
  def rec_core:
    if test("^- `[^`]*` \\*\\*[^*]+\\*\\*") then
      capture("^(?<head>- `[^`]*` \\*\\*(?<type>[^*]+)\\*\\*)(?<rest>.*)$") as $m
      | if ($m.type | IN(prose_types[])) then $m.head + ($m.rest | body(keep | redact_prompt))
        elif $m.type == "bash" and ($m.rest | test(" (-|—) `.*`$")) then
          ($m.rest | capture("^(?<d>.*?)(?<sep> (-|—) `)(?<c>.*)`$")) as $b
          | $m.head + ($b.d | body(keep | redact)) + $b.sep + ($b.c | keep | redact) + "`"
        else $m.head + ($m.rest | body(ticked(keep | redact))) end
    else keep | redact_prompt end;
  # CRLF lines: match without the trailing CR, then put it back.
  def rec_fix: if endswith("\r") then (.[0:-1] | rec_core) + "\r" else rec_core end;
  def classes:
    . as $l
    | [ (if ($l | _prefix_tokens) != $l then "prefix" else empty end),
        (if ($l | _url | _unmask) != $l then "url" else empty end),
        (if ($l | _mysql_pw_all) != $l then "mysql" else empty end),
        (if ($l | _auth_scheme) != $l then "scheme" else empty end) ]
    | if length == 0 then ["keyword"] else . end;
  # A private key spans lines in a draft, so the PEM rule runs over the whole text
  # before it is split into lines.
  (_pem) as $p
  | ($p != .) as $pem
  | ($p | split("\n")) as $lines
  | [ $lines[] | . as $o | (rec_fix) as $n
      | {old: $o, new: (if ($o | norm) != ($n | norm) then $n else $o end)} ] as $rows
  | ([ $rows[] | select(.old != .new) | (.old | classes[]) ] + (if $pem then ["pem"] else [] end)) as $cls
  | { text: ($rows | map(.new) | join("\n")),
      changed: (([ $rows[] | select(.old != .new) ] | length) + (if $pem then 1 else 0 end)),
      classes: ($cls | group_by(.) | map("\(.[0]) \(length)") | join(", ")) }
'

rc=0
for f in "$@"; do
  # A symlink would be replaced by a plain file while its target kept the secret.
  if [ -L "$f" ]; then
    echo "rescan: $f is a symlink; run it on the file it points to" >&2; rc=1; continue
  fi
  if [ ! -f "$f" ] || [ ! -r "$f" ]; then
    echo "rescan: cannot read $f" >&2; rc=1; continue
  fi
  # Work from a snapshot and remember its size: capture may append to a live buffer
  # while this runs, and those bytes must not be lost when the rewrite lands.
  snap="$f.rescan-snap.$$"
  cp -p -- "$f" "$snap" 2>/dev/null || { echo "rescan: cannot read $f" >&2; rc=1; continue; }
  size=$(wc -c < "$snap" | tr -d ' ')
  if ! out=$(jq -n --rawfile s "$snap" "\$s | $prog" 2>&1); then
    rm -f -- "$snap"
    echo "rescan: could not process $f: $(printf '%s' "$out" | head -n 1)" >&2; rc=1; continue
  fi
  changed=$(printf '%s' "$out" | jq -r '.changed' 2>/dev/null)
  case "$changed" in ''|*[!0-9]*)
    rm -f -- "$snap"; echo "rescan: could not process $f" >&2; rc=1; continue ;;
  esac
  if [ "$changed" -eq 0 ]; then rm -f -- "$snap"; continue; fi
  # The snapshot copy keeps the file's mode; its content is replaced with the result.
  tmp=$snap
  if printf '%s' "$out" | jq -j '.text' > "$tmp" 2>/dev/null; then
    # Carry over anything appended since the snapshot, then swap in the result. A
    # record written in the instant between the last size check and the rename can
    # still be lost; rescan files nothing is writing to (archives, drafts) where you can.
    while :; do
      now=$(wc -c < "$f" 2>/dev/null | tr -d ' ')
      [ -n "$now" ] && [ "$now" -gt "$size" ] || break
      tail -c +"$((size + 1))" -- "$f" | head -c "$((now - size))" >> "$tmp" 2>/dev/null
      size=$now
    done
    if mv -- "$tmp" "$f" 2>/dev/null; then
      echo "rescan: $changed line(s) masked in $f ($(printf '%s' "$out" | jq -r '.classes'))"
      continue
    fi
  fi
  rm -f -- "$tmp" 2>/dev/null
  echo "rescan: could not rewrite $f" >&2; rc=1
done
exit "$rc"
