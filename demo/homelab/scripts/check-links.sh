#!/usr/bin/env bash
#
# Nightly link check. Reads urls.txt, GET-requests each URL, appends one
# result line per URL to logs/link-check.log. Run from cron at 2:30am.
# GET, not HEAD: status.example.com's load balancer 405s HEAD requests
# (see .claude/throughline/HANDOFF.md).

set -uo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
urls="$here/urls.txt"
log="$here/logs/link-check.log"

while IFS= read -r url; do
  [ -n "$url" ] || continue
  code=$(curl -s -o /dev/null -w '%{http_code}' "$url")
  ts=$(date '+%Y-%m-%d %H:%M:%S')
  if [ "$code" = "200" ]; then
    printf '%s OK   %s (%s)\n' "$ts" "$url" "$code" >> "$log"
  else
    printf '%s FAIL %s (%s)\n' "$ts" "$url" "$code" >> "$log"
  fi
done < "$urls"
