# Multi-hop VPN Audit Prompt (for Claude Code)

## Role
You are acting as a senior VPN security engineer and app architect conducting
a code audit.

## Objective
Audit the Multi-hop feature in this codebase (VPN client built on the Sentinel
Network backend). Multi-hop routes traffic through two or more VPN servers in
sequence instead of one. Find bugs, security weaknesses, and workflow/UI/UX
issues in how this feature is implemented.

## Phase 1 — Map the feature (do this first, report back before going deeper)
Search the codebase and identify every file/module involved in multi-hop, including:
- Server/hop selection logic (client-side and any config/API calls)
- Tunnel establishment and key exchange for each hop
- Connection state management (connecting, connected, reconnecting, failed)
- Failover / retry logic if one hop drops
- Kill switch / leak protection interaction with multi-hop specifically
- Any DNS handling between hops
- UI screens and components for choosing/displaying hops
- Logging (check whether sensitive data — IPs, hop order, keys — gets logged)

List the relevant files and give a one-paragraph summary of how the flow
currently works before proceeding to Phase 2.

## Phase 2 — Deep audit
For each area above, examine the code and flag issues in these categories:

1. **Correctness / bugs** — race conditions, unhandled errors, incorrect
   state transitions, edge cases (e.g. one hop's server going down mid-session,
   app backgrounded during hop negotiation, network switch from WiFi to
   cellular mid-tunnel).
2. **Security** — traffic/DNS leak risk between hops, whether the second hop
   only ever learns the first hop's identity (not the origin device's),
   certificate/key validation per hop, whether kill switch actually blocks
   traffic if hop 2 fails but hop 1 is still up, insecure logging of
   hop metadata.
3. **Performance** — unnecessary reconnects, redundant handshakes, latency
   from hop selection logic.
4. **UX / workflow** — clarity of hop status to the user, error messaging
   when a hop fails, whether users can tell which servers they're routed
   through, onboarding/explanation of what multi-hop does, loading/connecting
   states, recovery flow if setup fails.

## Output format
For each finding provide:
- **Title**
- **Severity**: Critical / High / Medium / Low
- **Location**: file + line reference
- **Description**: what's wrong and why it matters
- **Suggested fix**: concrete, not vague

Group findings by category (Bugs / Security / Performance / UX). End with a
short prioritized "fix first" list of the top 5 issues.

## Constraints
- Do NOT modify any code yet — this is a read-only audit. Propose fixes;
  don't apply them.
- If something is ambiguous (e.g. intended behavior unclear from code alone),
  flag it as a question rather than guessing.
- If useful, you may reference how established multi-hop implementations
  (e.g. double-hop/cascading VPN architectures) typically handle hop
  isolation and failover, for comparison.
