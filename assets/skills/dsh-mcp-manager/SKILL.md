---
name: dsh-mcp-manager
description: Use when the user wants to manage MCP servers in DeepSeek Harness (DSH) — discover one in the official MCP Registry, list or probe registered servers, install a new one from a pasted project address (npm package, GitHub repo, MCP endpoint URL, or JSON config) or from a registry name, change an existing server's configuration, enable/disable or remove a server, or rotate a server credential. Also use when the user reports an MCP tool is missing or failing.
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
2. **Discover**: when the user asks for a capability rather than an address
   ("find me an MCP server that reads PDFs"), call `mcp_manager_search` with a
   NAME — the registry matches names only, not descriptions, so search by package
   or server name and expect noise. Each hit prints the exact command line it
   would run, whether an equivalent server is already registered, and any
   credentials still missing. Entries this plugin cannot run (`sse`, `cargo`,
   `nuget`, `mcpb`) are filtered out silently — say so if the user asks why
   something is absent.
3. **Install from a pasted address, or from a registry name**: call
   `mcp_manager_add` with the user's input, plus `source: "registry"` when the
   input is a registry name such as `ai.ankimcp/anki-mcp-server`. It dry-runs:
   show the returned entry preview and wait for the user's explicit approval.
   Only then re-run with `confirm: true`. The tool validates the candidate against
   the official mcp-client rules and probes the new server afterwards — report the
   probe result (tool count, or the exact failure reason).
   Entries that need credentials install **without** them: the secret fields are
   deliberately omitted rather than filled with a placeholder, so the first probe
   returns 401 until `mcp_manager_credential` sets the value. That 401 is the
   expected signal, not a bug.
4. **Change an existing server's config**: call `mcp_manager_update` with `id` and
   the new `config` subtree as YAML. It dry-runs too: show the normalized text and
   the rule/secret/uniqueness checks, then re-run with `confirm: true`. Get the
   current subtree first — `mcp_manager_list` gives ids, and the CLI's
   `show <id>` prints the exact text to edit (verbatim, so it can be piped back).
   The tool may write `!!js` expressions (it is as trusted as hand-editing the
   patch); the Web panel may not — it only ever sees `!!js «k»` placeholders that
   the host refills. Say so if the user asks to change a credential reference.
5. **Toggle / remove**: always confirm intent in conversation first, then call
   `mcp_manager_toggle` / `mcp_manager_remove` with `confirm: true`.
6. **Diagnose**: `mcp_manager_probe --id <id>` gives the real handshake outcome
   (spawn failure / timeout / HTTP status / tool list). Fix the entry (toggle,
   re-add with corrected input, `mcp_manager_update` the config) rather than
   guessing.
7. **Report**: new tools are `mcp__<serverName>__<tool>`. DSH hot-reloads the
   patch, so a running session picks them up with no restart — measured against a
   live install; do not tell the user to start a new session.

## Rules

- Never write credentials into the patch. Use `mcp_manager_credential` +
  `!!js readFileSync` credential files (official pattern).
- Never hand-edit the patch file while this bundle manages it — the guarded
  pipeline keeps comments intact and validates every candidate; hand edits can
  break DSH's config reload.
- An edit replaces only the entry's `config:` subtree: `id`, `name` and
  `disabled` are not editable there (use `mcp_manager_toggle` for the last one).
  A candidate that fails the official rules, carries a hardcoded secret, or
  duplicates a `serverName` is refused before it reaches the file.
- A failing install is fixed in place; never create duplicate entries for the
  same serverName (the official loader rejects duplicate names in one scope).
  Installing a registry entry that is already registered is refused for exactly
  this reason — recognise it by the `already registered as <id>` note instead of
  retrying.
- `serverName` must match `[A-Za-z0-9_-]{1,32}`; the official transport values
  are `stdio` and `streamable-http` only.
- Version drift is only decidable for rows that pin a version. Market installs
  pin one; a bare `npx -y <pkg>` does not, and reports "installed without a
  pinned version, so it cannot be compared" rather than guessing.
- The registry is a third party and its search endpoint is slow and occasionally
  returns 500 (measured: 1.2s–30s, one 500 in four calls). A `registry
  unreachable` result is not a bug in this bundle; retry, or work from a pasted
  address instead.
