# dsh-mcp-manager for DSH

A [DeepSeek Harness](https://github.com/topics/dsh-plugin) bundle that manages MCP
servers registered in your DSH patch files: list, real-handshake probe, add from a
pasted project reference, enable/disable, remove, and credential rotation —
following the official `@deepseek-ai/dsh-mcp-client` configuration contract.

## Install

**Option A — agent tool (Creator mode):** ask your agent:

```
plugin_manager install_bundle https://github.com/<owner>/dsh-mcp
```

**Option B — Web UI:** open the sidebar **Plugins** page in the DSH Web app and
install from the GitHub URL above.

Both official channels run pnpm, validate the bundle manifest, and select the
bundle automatically. After installation, seven tools become available to agents:

| Tool | Purpose |
|---|---|
| `mcp_manager_list` | List registered MCP servers (credential values masked) |
| `mcp_manager_probe` | Real MCP handshake (`initialize` + `tools/list`) against one or all servers |
| `mcp_manager_add` | Paste an npm package / GitHub repo URL / MCP endpoint URL / JSON config; dry-run by default, `confirm: true` writes it |
| `mcp_manager_remove` | Remove an entry (`confirm: true` required) |
| `mcp_manager_toggle` | Enable/disable an entry (`confirm: true` required) |
| `mcp_manager_credential` | Locate / mask-display / rotate the `!!js`-referenced credential file |
| `mcp_manager_validate` | Check an entry against the official mcp-client rules |

Verify after installation: the tool call returns `application: applied`; then call
`mcp_manager_list` — it should show your servers (chrome-devtools, playwright,
github, …). Tools become `mcp__<serverName>__<tool>` in **new** sessions.

## CLI

The bundle also ships a zero-dependency CLI (same engine, no harness needed):

```sh
node cli/mcp.js list [--json]
node cli/mcp.js probe [--id <id>] [--timeout 60]
node cli/mcp.js add "<npm-package | github-url | mcp-url | json>" [--yes] [--no-probe]
node cli/mcp.js enable|disable <id> --yes
node cli/mcp.js remove <id> --yes
node cli/mcp.js credential <id> get|set <value>
node cli/mcp.js validate <id>
node cli/mcp.js schema
```

All writes go through the same guarded pipeline: surgery on a candidate copy →
validation with DSH's own loader (`loadOptionalPatches`) → atomic write with a
`.bak` backup. A candidate that fails validation never reaches your live patch.

## Panel (Web GUI)

With the bundle enabled, the **DSH MCP manager** page under Plugins grows a
section listing your registered MCP servers:

- one row per server: a status dot, id, serverName, transport, and the command
  line or URL;
- a **status dot** where the text badge used to be — green (connected), amber
  (enabled, not connected), grey (disabled), or a hollow ring when the live
  registry cannot be read. It is the host's own `StateDot` primitive, read from
  the harness's MCP resource registry at zero cost, so "configured" and
  "actually connected" are no longer the same thing on screen. Hovering it
  shows the state as text in the host's `Tooltip`;
- **Probe** per row: a real handshake reporting the tool count, or the failure
  reason. Nothing is probed automatically; the list opens instantly;
- **Probe all** in the panel header: one click probes every registered server
  concurrently and reports per row;
- an enable/disable switch, and a delete that asks once inline;
- an add box: paste an npm package, GitHub repo, MCP endpoint or JSON fragment,
  see the exact YAML that would be appended, then write it.

The panel deliberately does **not** edit arbitrary config fields or rotate
credentials — those stay in the CLI and the agent tools.

It talks to the host over exact Fetch routes under `/api/dsh-mcp-manager/`,
registered through `ctx.connection.registerFetchRoute` so the harness's own
Host/Origin checks and browser-session authentication run first. The panel
implements no trust boundary of its own, and every write goes through the same
guarded pipeline as the CLI.

## What it writes

Entries follow the official `@deepseek-ai/dsh-mcp-client` contract exactly:

```yaml
- id: mcp-<serverName>
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: <serverName>      # [A-Za-z0-9_-]{1,32}, unique
    transport: stdio              # or streamable-http
    command: npx                  # stdio only
    args: ['-y', '<package>']
    failOnStartupError: true      # recommended for fresh entries
```

Secrets are never written into the patch: the tool stores them in a credential
file and references it with a `!!js` expression (the same pattern the official
GitHub entry uses). DSH hot-reloads the patch — new servers appear without a
restart.

## Scope and safety

- Writes target the **home** overlay `~/.dsh/cordis.patch.yml` (official
  composition order: bundle patches → profile patch → home patch → `--patch`).
- Every mutation requires explicit confirmation (`confirm: true` / `--yes`);
  removals and toggles keep a `.bak` of the previous file.
- Probes are read-only; they never start browsers or send credentials anywhere
  beyond the server's own endpoint.

## Development

```sh
node --test "test/*.test.mjs"   # 98 tests, zero dependencies
node -e "import('./scripts/check-bundle.mjs').then(m => console.log(m.checkBundle('.')))"
```

Official rules are vendored under `docs/official/` (extracted from the installed
DSH `app.asar`; provenance in `docs/official/README.md`), design and plan under
`docs/`.
