---
name: dsh-mcp-manager
description: Use when the user wants to manage MCP servers in DeepSeek Harness (DSH) — list or probe registered servers, install a new one from a pasted project address (npm package, GitHub repo, MCP endpoint URL, or JSON config), enable/disable or remove a server, or rotate a server credential. Also use when the user reports an MCP tool is missing or failing.
---

# DSH MCP Manager

Manage MCP servers registered in `~/.dsh/cordis.patch.yml` through the
`mcp_manager_*` tools (installed bundle) or the bundled CLI at
`<bundle-dir>/cli/mcp.js`. Follow this exact workflow — every write is guarded by
validation against DSH's own loader, and every mutation needs explicit user
confirmation.

## Workflow

1. **Survey**: call `mcp_manager_list`. Report id / transport / command-url /
   enabled state. Credential values are already masked — never try to reveal them.
2. **Install from a pasted address**: call `mcp_manager_add` with the user's
   input. It dry-runs: show the returned entry preview and wait for the user's
   explicit approval. Only then re-run with `confirm: true`. The tool validates
   the candidate against the official mcp-client rules and probes the new server
   afterwards — report probe result (tool count, or the exact failure reason).
3. **Toggle / remove**: always confirm intent in conversation first, then call
   `mcp_manager_toggle` / `mcp_manager_remove` with `confirm: true`.
4. **Diagnose**: `mcp_manager_probe --id <id>` gives the real handshake outcome
   (spawn failure / timeout / HTTP status / tool list). Fix the entry (toggle,
   re-add with corrected input) rather than guessing.
5. **Report**: new tools are `mcp__<serverName>__<tool>` and appear in **new**
   sessions; tell the user so if the current session cannot see them yet.

## Rules

- Never write credentials into the patch. Use `mcp_manager_credential` +
  `!!js readFileSync` credential files (official pattern).
- Never hand-edit the patch file while this bundle manages it — the guarded
  pipeline keeps comments intact and validates every candidate; hand edits can
  break DSH's config reload.
- A failing install is fixed in place; never create duplicate entries for the
  same serverName (the official loader rejects duplicate names in one scope).
- `serverName` must match `[A-Za-z0-9_-]{1,32}`; the official transport values
  are `stdio` and `streamable-http` only.
