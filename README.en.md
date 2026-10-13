# dsh-mcp-manager for DSH

[English](README.en.md) | [中文](README.md)

A [DeepSeek Harness](https://github.com/topics/dsh-plugin) bundle that manages MCP
servers registered in your DSH patch files: search the official registry, list,
real-handshake probe, add from a pasted project reference, enable/disable, remove,
and credential rotation — following the official `@deepseek-ai/dsh-mcp-client`
configuration contract.

## Install

**Option A — agent tool (Creator mode):** ask your agent:

```
plugin_manager install_bundle https://github.com/shiliu153/dsh-mcp-manager
```

**Option B — Web UI:** open the sidebar **Plugins** page in the DSH Web app and
install from the GitHub URL above.

Both official channels run pnpm, validate the bundle manifest, and select the
bundle automatically. After installation, nine tools become available to agents:

| Tool | Purpose |
|---|---|
| `mcp_manager_list` | List registered MCP servers (credential values masked) |
| `mcp_manager_search` | Search the official MCP Registry; reports installability, the execution surface and any gaps |
| `mcp_manager_probe` | Real MCP handshake (`initialize` + `tools/list`) against one or all servers |
| `mcp_manager_add` | Paste an npm package / GitHub repo URL / MCP endpoint URL / JSON config; with `source: "registry"` the input is read as a registry name. Dry-run by default, `confirm: true` writes it |
| `mcp_manager_update` | Replace one entry's `config:` subtree with YAML text; dry-run by default, `confirm: true` writes it |
| `mcp_manager_remove` | Remove an entry (`confirm: true` required) |
| `mcp_manager_toggle` | Enable/disable an entry (`confirm: true` required) |
| `mcp_manager_credential` | Locate / mask-display / rotate the `!!js`-referenced credential file |
| `mcp_manager_validate` | Check an entry against the official mcp-client rules |

Verify after installation: the tool call returns `application: applied`; then call
`mcp_manager_list` — it should show your servers (chrome-devtools, playwright,
github, …). A server's tools appear as `mcp__<serverName>__<tool>` as soon as its
row mounts: DSH hot-reloads the patch, so a running session picks them up with no
restart (measured against a live install, 2026-10-13).

## CLI

The bundle also ships a zero-dependency CLI (same engine, no harness needed):

```sh
node cli/mcp.js list [--json]
node cli/mcp.js probe [--id <id>] [--timeout 60]
node cli/mcp.js search <query> [--limit 20] [--cursor <c>] [--json]
node cli/mcp.js install <registry-name> [--version <v>] [--yes] [--no-probe]
node cli/mcp.js add "<npm-package | github-url | mcp-url | json>" [--yes] [--no-probe]
node cli/mcp.js show <id> [--json] [--masked]
node cli/mcp.js edit <id> [--config <file>] [--yes]      # no --config reads stdin
node cli/mcp.js enable|disable <id> --yes
node cli/mcp.js remove <id> --yes
node cli/mcp.js credential <id> get|set <value>
node cli/mcp.js validate <id>
node cli/mcp.js schema
```

All writes go through the same guarded pipeline: surgery on a candidate copy →
validation with DSH's own loader (`loadOptionalPatches`) → atomic write with a
`.bak` backup. A candidate that fails validation never reaches your live patch.

`--registry-base <url>` overrides the registry base for `search` / `install`
(defaults to the official registry).

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
- **Edit** per row: the row opens a textarea holding its own `config:` subtree as
  YAML — comments, key order and `!!js` references included. **Validate** dry-runs
  the change against the official rules, **Write** applies it through the guarded
  pipeline and probes the result. A `!!js` value appears as an opaque placeholder
  (`Authorization: !!js «0»`) that the host refills verbatim, so the browser can
  never introduce or alter an expression — the Loader evaluates those at runtime,
  which would be code execution in the harness process. Rows carrying a hardcoded
  secret are read-only here; fix those from the CLI or the agent tool;
- an add box: paste an npm package, GitHub repo, MCP endpoint or JSON fragment,
  see the exact YAML that would be appended, then write it.

Credential **rotation** stays in the CLI and the agent tools. Editing itself is
available in all three surfaces; the CLI and `mcp_manager_update` may write raw
`!!js` text (the same trust level as editing the patch file by hand), the panel
may not.

### Market

The panel header carries two tabs: **Installed** (everything above) and **Market**.
The market is a read-only discovery surface — it never writes to the patch file.

Search goes to the official registry, which **matches names only** (reverse-DNS,
e.g. `ai.ankimcp/anki-mcp-server`), not descriptions — so `anki` also returns
`banking-*`. The returned page is re-ranked locally by title and description to
lift the exact hit, and the UI says so out loud rather than implying otherwise.

Opening a result shows an **execution surface that cannot be collapsed**:

- for a stdio entry, the exact command line that would run, verbatim and
  monospaced, e.g. `npx -y @ankimcp/anki-mcp-server@0.27.0`;
- for a remote entry, the exact URL that would be connected to;
- a red note when the runtime is not on `PATH`.

The same view lists provenance (publisher, registry name, version, repository and
website links, deprecation status) and **which credentials are still missing**.

**The tick box appears for stdio entries only.** `npx -y <anything>` runs arbitrary
code on this machine; a remote URL only sends queries to a third party, the same
as any web API. Demanding a tick for both trains people to click through it, which
weakens the one that matters. Credential gaps, a missing runtime and deprecation
are shown as prominent warnings instead.

**The market never writes credentials.** Entries that need secrets install fine,
but the secret fields are **omitted** rather than filled with placeholders — a fake
credential never reaches the patch. The first probe then returns 401, which is the
accurate signal that the value is still missing; set it with
`dsh-mcp credential <id> set <value>` or let the agent call
`mcp_manager_credential`.

**Entries this plugin cannot run are not listed at all**: the `sse` transport
(dsh-mcp-client does not accept it), and the `cargo` / `nuget` / `mcpb` package
types.

**Installed marking and version drift.** The market recognises a server it already
manages by the derived `serverName` first, and by the execution surface when the
user renamed the row, and labels it "Installed". Drift is only decidable when the
row **pins a version** — market installs pin one, while the `add` path writes a
bare `npx -y <pkg>`. The latter honestly reports "installed without a pinned
version, so it cannot be compared" instead of claiming to be current. Updating
goes through the existing `mcp_manager_update` pipeline and still needs
confirmation.

It talks to the host over exact Fetch routes under `/api/dsh-mcp-manager/`,
registered through `ctx.connection.registerFetchRoute` so the harness's own
Host/Origin checks and browser-session authentication run first. The panel
implements no trust boundary of its own, and every write goes through the same
guarded pipeline as the CLI.

## What it writes

Entries follow the official `@deepseek-ai/dsh-mcp-client` contract exactly:

```yaml
- insert:
    - id: mcp-<serverName>
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: <serverName>      # [A-Za-z0-9_-]{1,32}, unique
        transport: stdio              # or streamable-http
        command: npx                  # stdio only
        args: ['-y', '<package>']
        failOnStartupError: true      # default for rows this plugin writes
```

A new server goes inside its own `insert:` list. A bare top-level entry overrides
an *existing* row by id, and the loader warns about and skips one that matches no
row — so appending a bare entry, however well-formed, never mounts a new server.

Secrets are never written into the patch: the tool stores them in a credential
file and references it with a `!!js` expression (the same pattern the official
GitHub entry uses). DSH hot-reloads the patch — new servers appear without a
restart.

Editing replaces one entry's `config:` subtree and nothing else: the comment
block above the entry, its `- id:`, `name:` and `disabled:` lines, and every
other entry stay byte-identical. Reading a subtree and writing it straight back
reproduces the file exactly, which is what the test suite asserts.

## Scope and safety

- Writes target the **home** overlay `~/.dsh/cordis.patch.yml` (official
  composition order: bundle patches → profile patch → home patch → `--patch`).
- Every mutation requires explicit confirmation (`confirm: true` / `--yes`);
  removals, toggles and edits keep a `.bak` of the previous file.
- An edit is validated four ways before it lands: the candidate must parse under
  DSH's own loader, pass the official field rules, carry no hardcoded secret, and
  keep every `serverName` unique. A rejected candidate never reaches the live
  file.
- An **add** is gated before the write as well as after it: the candidate row
  must sit inside an insert list, must parse back through the loader with a
  `serverName`, and must not duplicate one already registered. The same check
  then runs against the persisted row before the probe, so `probe OK` can only
  describe a row that is really in the file.
- The panel holds an edit as raw text while you type, so it echoes the file's
  `mtime` back on write: if the file changed underneath, the write is refused
  with `file_changed` instead of clobbering it.
- Probes are read-only; they never start browsers or send credentials anywhere
  beyond the server's own endpoint.
- A probe resolves `!!js` values the way the harness does before sending them.
  The loader hands back an inert `{ __jsExpr }` marker, so a credential written
  as an expression used to reach the server as `Authorization: [object Object]`
  and come back as `400 … header is badly formatted` — a healthy credential
  reported as a malformed one. An expression that cannot be evaluated is now
  reported by name instead of being forwarded.
- **The registry's metadata can be wrong, and the market cannot tell.** Measured:
  `ai.ankimcp/anki-mcp-server` declares `transport: {type: "stdio"}` while the
  package is an HTTP server that binds `127.0.0.1:3000` and never reads stdin, so
  a stdio entry for it can only fail. The market can only reproduce what the
  registry says. When that happens the probe says so: it reports that the process
  printed an http(s) endpoint without ever answering on stdio, and appends the
  process's own output.
- A probe kills the whole process tree, not just the command it spawned. This
  matters on Windows, where `npx` resolves to `npx.cmd` and the probe's direct
  child is therefore a `cmd.exe` wrapper around the real server; killing only the
  wrapper left the server running and holding its port, which made the *next*
  probe fail with a misleading startup error.

## Development

```sh
node --test "test/*.test.mjs"   # 296 tests, zero dependencies
node -e "import('./scripts/check-bundle.mjs').then(m => console.log(m.checkBundle('.')))"
```

Official rules are vendored under `docs/official/` (extracted from the installed
DSH `app.asar`; provenance in `docs/official/README.md`), design and plan under
`docs/`.
