# homelab-linkcheck — Handoff
**Last Updated:** 2026-08-29

## Resolved Issues
| Issue | Resolution | Date |
|---|---|---|
| `status.example.com` false FAIL every night since Aug 25 | Root cause: its load balancer 405s HEAD requests, GET-only. `check-links.sh` switched from `curl -I` to a GET-based check for all URLs. | 2026-08-27 |

## Pending Items
| Item | Priority | Tracking |
|---|---|---|
| Confirm the fix holds for a third consecutive clean run before calling this closed | Medium | logs/link-check.log |

## Current State
- Fix landed 2026-08-27 evening. Clean runs since: Aug 28, Aug 29. One more
  clean night (Aug 30) closes this out; anything else means the
  load-balancer theory was incomplete.
- `urls.txt` unchanged: 4 URLs, all on `example.com` / `status.example.com`.
- No other work in flight on this project.

## Recent Session Logs
1. [status.example.com false-FAIL root-caused and fixed](logs/handoff-2026-08-27-2140.md) — 2026-08-27
