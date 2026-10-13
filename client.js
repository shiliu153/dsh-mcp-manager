// Browser half of the dsh-mcp-manager bundle.
//
// Single self-contained file: the client module is served directly at
// /plugins/<id>/client.js and cannot require sibling files of this package.
// React comes from the browser module table.
window.__ModuleLoader__.load({
  id: '@dsh-contrib/dsh-mcp-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dshMcpManager';
    const BUNDLE_NAME = '@dsh-contrib/dsh-mcp-manager';
    const API = '/api/dsh-mcp-manager';

    // The shell seeds a frozen platform module table (react, react-dom, cordis,
    // client-store, ui-slots, ui-primitives, ui-dockkit) and every dynamic
    // bundle resolves against exactly that baseline, so this resolves the same
    // way `require('react')` above does. The guard is insurance, not the normal
    // path: without it a host that drops the key would throw inside the factory
    // and take the whole panel down, whereas a missing dot is survivable.
    let StateDot = null;
    let Tooltip = null;
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
      StateDot = primitives.StateDot ?? null;
      Tooltip = primitives.Tooltip ?? null;
    } catch { /* fall back to the self-drawn dot in StatusDot below */ }

    const ZH = {
      title: 'MCP 服务器',
      refresh: '刷新',
      loading: '加载中…',
      retry: '重试',
      patch: 'patch',
      badgeConnected: '已连接',
      badgeEnabledOffline: '已启用·未连接',
      badgeDisabled: '已禁用',
      badgeUnknown: '连接状态不可用',
      probe: '探测',
      probing: '探测中…',
      probeAll: '一键探测',
      probeAllLabel: '探测全部 {count} 个服务器',
      edit: '编辑',
      editLabel: '编辑 {id} 的配置',
      validate: '校验并预览',
      write: '写入',
      jsPlaceholders: '占位符（由服务端回填，面板不可修改）：{items}',
      editConflict: '文件已被外部修改，请重新加载后再改',
      reload: '重新加载',
      remove: '删除',
      removeConfirm: '确认删除？',
      cancel: '取消',
      toggleLabel: '启用或禁用 {id}',
      probeOk: '{count} 个工具',
      probeFailed: '探测失败：{error}',
      probeHint: '提示：{hint}',
      addTitle: '新增服务器',
      addPlaceholder: '粘贴 npm 包名 / GitHub 仓库 / MCP 端点 / JSON 片段',
      parse: '解析',
      previewTitle: '预览',
      write: '写入',
      needsInput: '还缺信息：{items}',
      empty: '没有已登记的 MCP 服务器',
      installedTab: '已安装',
      marketTab: '市场',
      marketSearch: '搜索',
      marketSearchPlaceholder: '按名称搜索 MCP Registry',
      marketSearchByName: 'Registry 的搜索只匹配名称（反域名，如 ai.ankimcp/anki-mcp-server），不匹配描述。',
      marketEmpty: '没有匹配的可安装条目',
      marketDegraded: '离线，无法访问 registry：{reason}',
      marketMore: '加载更多',
      marketDetail: '详情',
      marketClose: '收起',
      marketProvenance: '出处',
      marketPublisher: '发布者',
      marketVersion: '版本',
      marketRepo: '仓库',
      marketSite: '主页',
      marketDeprecated: '已弃用',
      marketExecution: '将要执行 / 连接',
      marketRuntimeMissing: '运行时不在 PATH 上，装好后需要先安装它',
      marketGaps: '还缺凭据',
      marketGapsHint: '装完后用 dsh-mcp credential <id> set <值>，或让 agent 调用 mcp_manager_credential 补上。',
      marketNoGaps: '无需凭据',
      marketInstall: '安装',
      marketInstallAnyway: '仍然安装',
      marketConfirm: '我已确认上述执行目标与出处',
      marketInstalled: '已安装',
      marketDriftBehind: '有更新：{installed} → {latest}',
      marketDriftCurrent: '已是最新',
      marketDriftAhead: '已装版本比 registry 更新',
      marketDriftUnpinned: '版本未钉住，无法比对',
      marketDriftIncomparable: '与已装版本不同（无法比较）',
    };
    const EN = {
      title: 'MCP servers',
      refresh: 'Refresh',
      loading: 'Loading…',
      retry: 'Retry',
      patch: 'patch',
      badgeConnected: 'Connected',
      badgeEnabledOffline: 'Enabled · not connected',
      badgeDisabled: 'Disabled',
      badgeUnknown: 'Connection state unavailable',
      probe: 'Probe',
      probing: 'Probing…',
      probeAll: 'Probe all',
      probeAllLabel: 'Probe all {count} servers',
      edit: 'Edit',
      editLabel: 'Edit the config of {id}',
      validate: 'Validate',
      write: 'Write',
      jsPlaceholders: 'Placeholders (refilled by the host, not editable here): {items}',
      editConflict: 'The file changed on disk — reload before editing',
      reload: 'Reload',
      remove: 'Delete',
      removeConfirm: 'Delete?',
      cancel: 'Cancel',
      toggleLabel: 'Enable or disable {id}',
      probeOk: '{count} tools',
      probeFailed: 'Probe failed: {error}',
      probeHint: 'Hint: {hint}',
      addTitle: 'Add a server',
      addPlaceholder: 'Paste an npm package, GitHub repo, MCP endpoint, or JSON fragment',
      parse: 'Resolve',
      previewTitle: 'Preview',
      write: 'Write',
      needsInput: 'Still needed: {items}',
      empty: 'No MCP servers registered',
      installedTab: 'Installed',
      marketTab: 'Market',
      marketSearch: 'Search',
      marketSearchPlaceholder: 'Search the MCP Registry by name',
      marketSearchByName: 'The registry matches names only (reverse-DNS, e.g. ai.ankimcp/anki-mcp-server) — not descriptions.',
      marketEmpty: 'No installable entries matched',
      marketDegraded: 'Offline — cannot reach the registry: {reason}',
      marketMore: 'Load more',
      marketDetail: 'Details',
      marketClose: 'Close',
      marketProvenance: 'Provenance',
      marketPublisher: 'Publisher',
      marketVersion: 'Version',
      marketRepo: 'Repository',
      marketSite: 'Website',
      marketDeprecated: 'Deprecated',
      marketExecution: 'Will run / connect to',
      marketRuntimeMissing: 'The runtime is not on PATH; install it before this server can start',
      marketGaps: 'Credentials still needed',
      marketGapsHint: 'After the write, run dsh-mcp credential <id> set <value>, or have the agent call mcp_manager_credential.',
      marketNoGaps: 'No credentials needed',
      marketInstall: 'Install',
      marketInstallAnyway: 'Install anyway',
      marketConfirm: 'I have read the execution target and provenance above',
      marketInstalled: 'Installed',
      marketDriftBehind: 'Update available: {installed} → {latest}',
      marketDriftCurrent: 'Up to date',
      marketDriftAhead: 'Installed version is newer than the registry',
      marketDriftUnpinned: 'Installed without a pinned version, so it cannot be compared',
      marketDriftIncomparable: 'Differs from the installed version (not comparable)',
    };

    // ---- pure helpers (unit-tested through __test) ----

    function isOurs(subject) {
      return subject?.kind === 'bundle' && subject?.pkg?.name === BUNDLE_NAME;
    }

    function badgeState(server, resourcesAvailable) {
      if (server.disabled) return 'disabled';
      if (!resourcesAvailable) return 'unknown';
      return server.live ? 'connected' : 'enabledOffline';
    }

    // State -> dictionary key. The component used to inline this object, which
    // made an unmapped state render as an undefined label; a named fallback is
    // the difference between a wrong word and no word at all.
    const BADGE_KEYS = {
      connected: 'badgeConnected',
      enabledOffline: 'badgeEnabledOffline',
      disabled: 'badgeDisabled',
      unknown: 'badgeUnknown',
    };

    function badgeKey(state) {
      return BADGE_KEYS[state] ?? BADGE_KEYS.unknown;
    }

    // State -> the host StateDot primitive's own vocabulary. `unknown` is the
    // only one that is not a solid dot: appearance 'step' renders the
    // primitive's hollow ring, which says "this reading is unavailable" rather
    // than claiming a fourth colour.
    const DOT_PROPS = {
      connected: { state: 'done' },
      enabledOffline: { state: 'warning' },
      disabled: { state: 'idle' },
      unknown: { state: 'idle', appearance: 'step' },
    };

    function dotProps(state) {
      return DOT_PROPS[state] ?? DOT_PROPS.unknown;
    }

    function commandLine(server) {
      if (server.url) return server.url;
      return [server.command, ...(server.args ?? [])].filter(Boolean).join(' ');
    }

    function probeText(result, t) {
      if (!result) return '';
      if (!result.error) return t('probeOk', { count: String(result.toolCount ?? 0) });
      // A bare reason is what left the user hunting: "server exited early
      // (code 1)" said nothing, while the child's own output named the problem.
      const lines = [t('probeFailed', { error: result.error })];
      if (result.hint) lines.push(t('probeHint', { hint: result.hint }));
      if (result.detail) lines.push(String(result.detail).trim());
      return lines.join('\n');
    }

    function errorMessage(payload, fallback) {
      return payload?.error?.message ?? fallback;
    }

    /**
     * True when the text carries a `!!js` expression that is not a placeholder.
     *
     * The host hands the panel `!!js «k»` instead of the expression itself and
     * refills it server-side; the browser must never send an expression back,
     * because the harness Loader evaluates those at runtime. This is the local
     * guard only — the route enforces the same rule and is the real boundary.
     */
    function hasRawJsExpr(text) {
      return String(text ?? '').split('\n').some((l) => /!!js/.test(l) && !/!!js\s*«\d+»\s*$/.test(l));
    }

    /** Editor seed for one row; an uneditable row yields an empty, disabled seed. */
    function openEditor(server) {
      if (!server?.editable) return { id: '', text: '', editable: false, reason: server?.editReason ?? '' };
      return { id: server.id, text: server.configText ?? '', editable: true, reason: '' };
    }

    /** The exact command line or URL a market entry would run. */
    function marketCommandLine(candidate) {
      const exec = candidate?.execution;
      if (!exec) return '';
      if (exec.kind === 'stdio') return [exec.command, ...(exec.args ?? [])].filter(Boolean).join(' ');
      return exec.url ?? '';
    }

    /**
     * Only local execution demands an explicit tick.
     *
     * `npx -y <anything>` runs arbitrary code on this machine; a remote URL only
     * sends queries to a third party, the same as any web API. Demanding a tick
     * for both trains people to click through it, which weakens the one that
     * matters. Credential gaps and a missing runtime are shown as warnings
     * instead — they ask the user to do something, not to agree to something.
     *
     * Reads `transport` because that is what the host's market rows carry;
     * `execution.kind` is accepted too so the helper stays usable against a raw
     * candidate.
     */
    function needsExecutionCheckbox(candidate) {
      return (candidate?.execution?.kind ?? candidate?.transport) === 'stdio';
    }

    function gapText(gaps) {
      return (gaps ?? []).map((g) => `${g.kind}: ${g.name}`).join('; ');
    }

    // Returns a dictionary KEY, not prose: the component maps it through t().
    function driftText(drift) {
      if (!drift) return '';
      switch (drift.state) {
        case 'behind': return `behind:${drift.installed}->${drift.latest}`;
        case 'current': return 'current';
        case 'ahead': return 'ahead';
        case 'unpinned': return 'unpinned';
        default: return `incomparable:${drift.installed}->${drift.latest}`;
      }
    }

    const DRIFT_KEYS = {
      behind: 'marketDriftBehind',
      current: 'marketDriftCurrent',
      ahead: 'marketDriftAhead',
      unpinned: 'marketDriftUnpinned',
      incomparable: 'marketDriftIncomparable',
    };

    function driftLabel(drift, t) {
      if (!drift) return '';
      return t(DRIFT_KEYS[drift.state] ?? DRIFT_KEYS.incomparable, {
        installed: String(drift.installed ?? ''),
        latest: String(drift.latest ?? ''),
      });
    }

    // ---- components ----

    /** Hook-free wrapper: the ownership test runs before any hook is called. */
    function Panel(props) {
      return isOurs(props.subject) ? h(PanelBody, props) : null;
    }

    /**
     * The per-row connection state, as a dot.
     *
     * The host primitive carries the look; the anchor span exists because
     * Tooltip clones its child with a ref, and StateDot cannot forward one.
     * The anchor also owns the accessible name: StateDot is aria-hidden by
     * design ("pair with text for accessibility"), and Tooltip only injects
     * aria-describedby when openOnClick is on, which it is not here.
     */
    function StatusDot(props) {
      const dot = dotProps(props.state);
      const anchorProps = {
        className: 'dsh-mcp-dot-anchor',
        role: 'img',
        'aria-label': props.label,
      };
      const inner = StateDot
        ? h(StateDot, { state: dot.state, appearance: dot.appearance })
        : h('span', { className: 'dsh-mcp-dot', 'data-state': props.state });

      // Degraded: no host bubble, so the native one has to carry the text.
      // Never both - two tooltips for one dot is worse than either alone.
      if (!Tooltip) return h('span', { ...anchorProps, title: props.label }, inner);
      return h(Tooltip, { label: props.label, side: 'top' }, h('span', anchorProps, inner));
    }

    // Colours are theme tokens only. Every token below was checked against the
    // host theme's own vocabulary (--dsw-alias-label-*, --dsw-alias-border-l*,
    // --dsw-alias-brand-primary, ...). An invented name makes the declaration
    // invalid at computed-value time, so the border or colour silently vanishes
    // instead of failing loudly.
    const CSS = `
.dsh-mcp { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.dsh-mcp-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dsh-mcp-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-mcp-path { font-size: 12px; color: var(--dsw-alias-label-caption); word-break: break-all; }
.dsh-mcp-list { display: flex; flex-direction: column; gap: 8px; }
.dsh-mcp-row { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.dsh-mcp-row-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dsh-mcp-id { font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-mcp-meta { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-mcp-target { font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: var(--dsw-alias-label-caption); word-break: break-all; }
.dsh-mcp-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
/* The host Tooltip positions its bubble from a ref on this element, so the dot
 * must stay a child rather than the anchor itself: StateDot is a plain function
 * component and cannot take a ref. */
.dsh-mcp-dot-anchor { display: inline-flex; align-items: center; flex: 0 0 auto; }
/* Degraded dot, used only when the host's ui-primitives module cannot be
 * resolved. Sizes and colours mirror StateDot.module.css on purpose: the
 * fallback must not read as a different design. */
.dsh-mcp-dot { box-sizing: border-box; display: inline-block; width: 10px; height: 10px; border-radius: 50%; corner-shape: round; background: currentColor; color: var(--dsw-alias-state-idle-primary); }
.dsh-mcp-dot[data-state="connected"] { color: var(--dsw-alias-state-success-primary); }
.dsh-mcp-dot[data-state="enabledOffline"] { color: var(--dsw-alias-state-warn-primary); }
.dsh-mcp-dot[data-state="disabled"] { color: var(--dsw-alias-state-idle-primary); }
.dsh-mcp-dot[data-state="unknown"] { background: transparent; border: 1.5px solid var(--dsw-alias-label-tertiary); }
.dsh-mcp-result { font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; }
.dsh-mcp-edit { display: flex; flex-direction: column; gap: 8px; }
.dsh-mcp-button { font-size: 12px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; }
.dsh-mcp-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-mcp-button:disabled { cursor: default; opacity: 0.5; }
.dsh-mcp-button:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
/* Track and thumb copied from the host Switch primitive (Switch.module.css) and
 * renamed under this plugin's prefix. State keys off aria-checked, so the look
 * cannot disagree with what assistive technology reads. Capsule and thumb opt
 * out of the global superellipse, exactly as the host's do. */
.dsh-mcp-switch { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px; corner-shape: round; background: var(--dsw-alias-border-l3); cursor: pointer; }
.dsh-mcp-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.dsh-mcp-switch:disabled { cursor: default; opacity: 0.5; }
.dsh-mcp-switch:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.dsh-mcp-thumb { display: block; width: 16px; height: 16px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-label-primary-foreground); transition: transform 120ms ease; }
.dsh-mcp-switch[aria-checked='false'] .dsh-mcp-thumb { background: var(--dsw-alias-switch-thumb); }
.dsh-mcp-switch[aria-checked='true'] .dsh-mcp-thumb { transform: translateX(16px); }
.dsh-mcp-error { font-size: 12px; color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 8px 10px; }
.dsh-mcp-add { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--dsw-alias-border-l2); padding-top: 12px; }
.dsh-mcp-input { box-sizing: border-box; width: 100%; min-height: 56px; resize: vertical; font-family: inherit; font-size: 13px; padding: 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); }
.dsh-mcp-preview { font-family: ui-monospace, Consolas, monospace; font-size: 12px; white-space: pre-wrap; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 8px; color: var(--dsw-alias-label-secondary); }
.dsh-mcp-tabs { display: flex; gap: 4px; }
.dsh-mcp-tab { font-size: 12px; padding: 4px 10px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dsh-mcp-tab[aria-selected='true'] { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.dsh-mcp-tab:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.dsh-mcp-note { font-size: 12px; color: var(--dsw-alias-label-caption); }
.dsh-mcp-warn { font-size: 12px; color: var(--dsw-alias-state-warn-primary); }
.dsh-mcp-detail { border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.dsh-mcp-exec { font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; padding: 6px 8px; word-break: break-all; }
.dsh-mcp-check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-mcp-link { font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
`;

    function PanelBody(props) {
      const t = props.t;
      const [state, setState] = React.useState({ status: 'loading' });
      const [busy, setBusy] = React.useState({});
      const [probes, setProbes] = React.useState({});
      const [confirming, setConfirming] = React.useState('');
      const [addText, setAddText] = React.useState('');
      const [preview, setPreview] = React.useState(null);
      const [addError, setAddError] = React.useState('');
      // Appended after the add-box state on purpose: the render smoke tests
      // script useState by call order, so new state goes at the end.
      const [editing, setEditing] = React.useState('');
      const [editText, setEditText] = React.useState('');
      const [editState, setEditState] = React.useState(null);
      // Market state, in the order the render smoke tests script it.
      const [tab, setTab] = React.useState('installed');
      const [market, setMarket] = React.useState({ status: 'idle', results: [], degraded: '', nextCursor: '' });
      const [marketQuery, setMarketQuery] = React.useState('');
      const [marketOpen, setMarketOpen] = React.useState('');
      const [marketChecked, setMarketChecked] = React.useState(false);
      const [installState, setInstallState] = React.useState(null);
      const abortRef = React.useRef(null);

      const setBusyKey = (key, value) => setBusy((b) => {
        const next = { ...b };
        if (value) next[key] = value; else delete next[key];
        return next;
      });

      const load = React.useCallback(async () => {
        abortRef.current?.abort();
        const ac = new AbortController();
        abortRef.current = ac;
        setState({ status: 'loading' });
        try {
          const r = await fetch(`${API}/servers`, { signal: ac.signal });
          const body = await r.json().catch(() => null);
          if (!r.ok) throw new Error(errorMessage(body, `HTTP ${r.status}`));
          setState({ status: 'ready', data: body });
        } catch (e) {
          if (e?.name === 'AbortError') return;
          setState({ status: 'error', message: String(e?.message || e) });
        }
      }, []);

      React.useEffect(() => {
        load();
        return () => abortRef.current?.abort();
      }, [load]);

      async function post(path, body) {
        const r = await fetch(`${API}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const payload = await r.json().catch(() => null);
        if (!r.ok) throw new Error(errorMessage(payload, `HTTP ${r.status}`));
        return payload;
      }

      async function runProbe(id) {
        setBusyKey(id, 'probe');
        try {
          const payload = await post('/probe', { id });
          setProbes((p) => ({ ...p, [id]: payload }));
        } catch (e) {
          setProbes((p) => ({ ...p, [id]: { error: String(e?.message || e) } }));
        } finally {
          setBusyKey(id, '');
        }
      }

      // One click, every row. Fanning out to the existing per-row probe keeps
      // progress and results per row for free, and needs no new server route.
      // Disabled servers are probed too: a probe answers "does this config
      // start at all", which is a question the switch does not gate.
      async function runProbeAll() {
        const servers = state.status === 'ready' ? state.data?.servers ?? [] : [];
        if (servers.length === 0) return;
        setBusyKey('__all', 'probe');
        try {
          await Promise.all(servers.map((s) => runProbe(s.id)));
        } finally {
          setBusyKey('__all', '');
        }
      }

      async function runToggle(server) {
        setBusyKey(server.id, 'toggle');
        try {
          await post('/toggle', { id: server.id, disabled: !server.disabled });
          await load();
        } catch (e) {
          setState((s) => (s.status === 'ready' ? { ...s, message: String(e?.message || e) } : s));
        } finally {
          setBusyKey(server.id, '');
        }
      }

      async function runRemove(id) {
        setBusyKey(id, 'remove');
        try {
          await post('/remove', { id });
          setConfirming('');
          await load();
        } catch (e) {
          setState((s) => (s.status === 'ready' ? { ...s, message: String(e?.message || e) } : s));
        } finally {
          setBusyKey(id, '');
        }
      }

      function startEdit(server) {
        const seed = openEditor(server);
        if (!seed.editable) return;
        setEditing(seed.id);
        setEditText(seed.text);
        setEditState(null);
        setConfirming('');
      }

      function stopEdit() {
        setEditing('');
        setEditText('');
        setEditState(null);
      }

      async function runEdit(confirm) {
        setEditState(null);
        if (hasRawJsExpr(editText)) {
          setEditState({ errors: [t('jsPlaceholders', { items: '' })] });
          return;
        }
        setBusyKey('__edit', confirm ? 'write' : 'validate');
        try {
          const payload = await post('/update', {
            id: editing, config: editText, confirm,
            expectMtime: state.status === 'ready' ? state.data?.mtimeMs : undefined,
          });
          setEditState({ preview: payload.preview, warnings: payload.warnings ?? [] });
          if (confirm) {
            const edited = editing;
            stopEdit();
            await load();
            await runProbe(edited);
          }
        } catch (e) {
          const msg = String(e?.message || e);
          const conflict = /file_changed|FileChangedExternally/.test(msg);
          setEditState({ errors: [conflict ? t('editConflict') : msg], conflict });
        } finally {
          setBusyKey('__edit', '');
        }
      }

      async function runParse() {
        setAddError('');
        setBusyKey('__add', 'parse');
        try {
          setPreview(await post('/add', { input: addText }));
        } catch (e) {
          setAddError(String(e?.message || e));
        } finally {
          setBusyKey('__add', '');
        }
      }

      async function runWrite() {
        setAddError('');
        setBusyKey('__add', 'write');
        try {
          const payload = await post('/add', { input: addText, confirm: true });
          setPreview(null);
          setAddText('');
          await load();
          if (payload?.probe) setProbes((p) => ({ ...p, __last: payload.probe }));
        } catch (e) {
          setAddError(String(e?.message || e));
        } finally {
          setBusyKey('__add', '');
        }
      }

      async function runMarketSearch(cursor) {
        setInstallState(null);
        setMarketChecked(false);
        setMarket((m) => ({ ...m, status: 'loading' }));
        try {
          const qs = new URLSearchParams({ q: marketQuery });
          if (cursor) qs.set('cursor', cursor);
          const r = await fetch(`${API}/market?${qs.toString()}`);
          const body = await r.json().catch(() => null);
          if (!r.ok) throw new Error(errorMessage(body, `HTTP ${r.status}`));
          setMarket((m) => ({
            status: 'ready',
            results: cursor ? [...m.results, ...(body.results ?? [])] : (body.results ?? []),
            degraded: body.degraded ?? '',
            nextCursor: body.nextCursor ?? '',
          }));
        } catch (e) {
          setMarket({ status: 'error', results: [], degraded: String(e?.message || e), nextCursor: '' });
        }
      }

      function openMarket(registryName) {
        setMarketOpen(marketOpen === registryName ? '' : registryName);
        setMarketChecked(false);
        setInstallState(null);
      }

      async function runMarketInstall(candidate) {
        setBusyKey('__market', 'write');
        setInstallState(null);
        try {
          const payload = await post('/market/install', { name: candidate.registryName, confirm: true });
          setInstallState({ preview: payload.preview, probe: payload.probe });
          await load();
          if (payload.probe) setProbes((p) => ({ ...p, __last: payload.probe }));
        } catch (e) {
          setInstallState({ error: String(e?.message || e) });
        } finally {
          setBusyKey('__market', '');
        }
      }

      function marketRows() {
        const out = [];
        if (market.degraded) {
          out.push(h('div', { key: 'd', className: 'dsh-mcp-warn' }, t('marketDegraded', { reason: market.degraded })));
        }
        if (market.status === 'ready' && (market.results ?? []).length === 0 && !market.degraded) {
          out.push(h('div', { key: 'e', className: 'dsh-mcp-meta' }, t('marketEmpty')));
        }
        for (const c of market.results ?? []) {
          const open = marketOpen === c.registryName;
          const busyKey = Boolean(busy.__market);
          out.push(h('div', { key: c.registryName, className: 'dsh-mcp-row' },
            h('div', { className: 'dsh-mcp-row-head' },
              h('span', { className: 'dsh-mcp-id' }, c.title || c.registryName),
              h('span', { className: 'dsh-mcp-meta' }, c.publisher),
              h('span', { className: 'dsh-mcp-meta' }, c.version),
              h('span', { className: 'dsh-mcp-meta' }, c.transport),
              c.status === 'deprecated' ? h('span', { className: 'dsh-mcp-warn' }, t('marketDeprecated')) : null,
              c.installed ? h('span', { className: 'dsh-mcp-meta' }, t('marketInstalled')) : null,
              h('span', { className: 'dsh-mcp-actions' },
                h('button', {
                  type: 'button', className: 'dsh-mcp-button', 'aria-expanded': open,
                  onClick: () => openMarket(c.registryName),
                }, open ? t('marketClose') : t('marketDetail')))),
            h('div', { className: 'dsh-mcp-meta' }, c.description),
            h('div', { className: 'dsh-mcp-target' }, c.commandLine),
            c.drift ? h('div', { className: 'dsh-mcp-meta' }, driftLabel(c.drift, t)) : null,
            open
              ? h('div', { className: 'dsh-mcp-detail' },
                  h('div', { className: 'dsh-mcp-meta' }, `${t('marketProvenance')}: ${c.registryName}`),
                  h('div', { className: 'dsh-mcp-meta' }, `${t('marketPublisher')}: ${c.publisher} · ${t('marketVersion')}: ${c.version}`),
                  c.repositoryUrl
                    ? h('a', { className: 'dsh-mcp-link', href: c.repositoryUrl, target: '_blank', rel: 'noreferrer noopener' }, `${t('marketRepo')}: ${c.repositoryUrl}`)
                    : null,
                  c.websiteUrl
                    ? h('a', { className: 'dsh-mcp-link', href: c.websiteUrl, target: '_blank', rel: 'noreferrer noopener' }, `${t('marketSite')}: ${c.websiteUrl}`)
                    : null,
                  h('div', { className: 'dsh-mcp-meta' }, t('marketExecution')),
                  h('div', { className: 'dsh-mcp-exec' }, c.commandLine),
                  c.runtimePresent === false ? h('div', { className: 'dsh-mcp-warn' }, t('marketRuntimeMissing')) : null,
                  h('div', { className: 'dsh-mcp-meta' }, `${t('marketGaps')}: ${(c.gaps ?? []).length ? gapText(c.gaps) : t('marketNoGaps')}`),
                  (c.gaps ?? []).length ? h('div', { className: 'dsh-mcp-note' }, t('marketGapsHint')) : null,
                  needsExecutionCheckbox(c)
                    ? h('label', { className: 'dsh-mcp-check' },
                        h('input', {
                          type: 'checkbox', checked: marketChecked,
                          onChange: (e) => setMarketChecked(e.target.checked),
                        }),
                        t('marketConfirm'))
                    : null,
                  h('div', { className: 'dsh-mcp-actions' },
                    h('button', {
                      type: 'button', className: 'dsh-mcp-button',
                      disabled: busyKey || (needsExecutionCheckbox(c) && !marketChecked),
                      onClick: () => runMarketInstall(c),
                    }, c.runtimePresent === false ? t('marketInstallAnyway') : t('marketInstall'))),
                  installState?.error ? h('div', { className: 'dsh-mcp-error' }, installState.error) : null,
                  installState?.preview ? h('div', { className: 'dsh-mcp-preview' }, installState.preview) : null,
                  installState?.probe ? h('div', { className: 'dsh-mcp-result' }, probeText(installState.probe, t)) : null)
              : null));
        }
        if (market.nextCursor) {
          out.push(h('button', {
            key: 'more', type: 'button', className: 'dsh-mcp-button', disabled: Boolean(busy.__market),
            onClick: () => runMarketSearch(market.nextCursor),
          }, t('marketMore')));
        }
        return out;
      }

      const rows = [];
      if (state.status === 'loading') rows.push(h('div', { key: 'l', className: 'dsh-mcp-meta' }, t('loading')));
      if (state.status === 'error') {
        rows.push(h('div', { key: 'e', className: 'dsh-mcp-error' }, state.message));
        rows.push(h('button', { key: 'r', type: 'button', className: 'dsh-mcp-button', onClick: load }, t('retry')));
      }
      if (state.status === 'ready') {
        if (state.message) rows.push(h('div', { key: 'm', className: 'dsh-mcp-error' }, state.message));
        const servers = state.data?.servers ?? [];
        if (servers.length === 0) rows.push(h('div', { key: 'n', className: 'dsh-mcp-meta' }, t('empty')));
        for (const s of servers) {
          const badge = badgeState(s, state.data?.resourcesAvailable === true);
          const isBusy = Boolean(busy[s.id]);
          rows.push(h('div', { key: s.id, className: 'dsh-mcp-row' },
            h('div', { className: 'dsh-mcp-row-head' },
              h(StatusDot, { state: badge, label: t(badgeKey(badge)) }),
              h('span', { className: 'dsh-mcp-id' }, s.id),
              h('span', { className: 'dsh-mcp-meta' }, s.serverName),
              h('span', { className: 'dsh-mcp-meta' }, s.transport),
              h('span', { className: 'dsh-mcp-actions' },
                h('button', {
                  type: 'button', className: 'dsh-mcp-button',
                  disabled: isBusy || !s.editable,
                  title: s.editable ? t('editLabel', { id: s.id }) : s.editReason,
                  onClick: () => startEdit(s),
                }, t('edit')),
                h('button', {
                  type: 'button', className: 'dsh-mcp-button', disabled: isBusy,
                  onClick: () => runProbe(s.id),
                }, busy[s.id] === 'probe' ? t('probing') : t('probe')),
                h('button', {
                  type: 'button', className: 'dsh-mcp-button', disabled: isBusy,
                  onClick: () => setConfirming(confirming === s.id ? '' : s.id),
                }, t('remove')),
                h('button', {
                  type: 'button', role: 'switch', 'aria-checked': !s.disabled,
                  'aria-label': t('toggleLabel', { id: s.id }),
                  title: t('toggleLabel', { id: s.id }),
                  className: 'dsh-mcp-switch', disabled: isBusy,
                  onClick: () => runToggle(s),
                }, h('span', { className: 'dsh-mcp-thumb' })))),
            h('div', { className: 'dsh-mcp-target' }, commandLine(s)),
            editing === s.id
              ? h('div', { className: 'dsh-mcp-edit' },
                  h('textarea', {
                    className: 'dsh-mcp-input', value: editText,
                    onChange: (e) => setEditText(e.target.value),
                  }),
                  (s.jsExprs ?? []).length
                    ? h('div', { className: 'dsh-mcp-meta' }, t('jsPlaceholders', { items: s.jsExprs.join('; ') }))
                    : null,
                  h('div', { className: 'dsh-mcp-actions' },
                    h('button', { type: 'button', className: 'dsh-mcp-button', disabled: Boolean(busy.__edit),
                      onClick: () => runEdit(false) }, t('validate')),
                    h('button', { type: 'button', className: 'dsh-mcp-button', disabled: Boolean(busy.__edit),
                      onClick: () => runEdit(true) }, t('write')),
                    h('button', { type: 'button', className: 'dsh-mcp-button', onClick: stopEdit }, t('cancel'))),
                  (editState?.errors ?? []).map((x, i) => h('div', { key: `e${i}`, className: 'dsh-mcp-error' }, x)),
                  editState?.conflict
                    ? h('div', { className: 'dsh-mcp-actions' },
                        h('button', { type: 'button', className: 'dsh-mcp-button',
                          onClick: () => { stopEdit(); load(); } }, t('reload')))
                    : null,
                  editState?.preview ? h('div', { className: 'dsh-mcp-preview' }, editState.preview) : null)
              : null,
            probes[s.id] ? h('div', { className: 'dsh-mcp-result' }, probeText(probes[s.id], t)) : null,
            confirming === s.id
              ? h('div', { className: 'dsh-mcp-actions' },
                  h('span', { className: 'dsh-mcp-meta' }, t('removeConfirm')),
                  h('button', { type: 'button', className: 'dsh-mcp-button', disabled: isBusy,
                    onClick: () => runRemove(s.id) }, t('remove')),
                  h('button', { type: 'button', className: 'dsh-mcp-button',
                    onClick: () => setConfirming('') }, t('cancel')))
              : null));
        }
        if (probes.__last) rows.push(h('div', { key: 'last', className: 'dsh-mcp-result' }, probeText(probes.__last, t)));
      }

      return h('div', { className: 'dsh-mcp' },
        h('style', null, CSS),
        h('div', { className: 'dsh-mcp-head' },
          h('span', { className: 'dsh-mcp-title' }, t('title')),
          h('span', { className: 'dsh-mcp-actions' },
            state.status === 'ready' && (state.data?.servers ?? []).length > 0
              ? h('button', {
                  type: 'button', className: 'dsh-mcp-button', disabled: Boolean(busy.__all),
                  title: t('probeAllLabel', { count: String((state.data?.servers ?? []).length) }),
                  onClick: runProbeAll,
                }, busy.__all ? t('probing') : t('probeAll'))
              : null,
            h('button', { type: 'button', className: 'dsh-mcp-button', disabled: state.status === 'loading',
              onClick: load }, t('refresh')))),
        state.status === 'ready' && state.data?.patch && tab === 'installed'
          ? h('div', { className: 'dsh-mcp-path' }, `${t('patch')}: ${state.data.patch}`)
          : null,
        h('div', { className: 'dsh-mcp-tabs', role: 'tablist' },
          h('button', {
            type: 'button', role: 'tab', className: 'dsh-mcp-tab', 'aria-selected': tab === 'installed',
            onClick: () => setTab('installed'),
          }, t('installedTab')),
          h('button', {
            type: 'button', role: 'tab', className: 'dsh-mcp-tab', 'aria-selected': tab === 'market',
            onClick: () => setTab('market'),
          }, t('marketTab'))),
        tab === 'market'
          ? h('div', { className: 'dsh-mcp-add' },
              h('textarea', {
                className: 'dsh-mcp-input', value: marketQuery, placeholder: t('marketSearchPlaceholder'),
                onChange: (e) => setMarketQuery(e.target.value),
              }),
              h('div', { className: 'dsh-mcp-note' }, t('marketSearchByName')),
              h('div', { className: 'dsh-mcp-actions' },
                h('button', {
                  type: 'button', className: 'dsh-mcp-button',
                  disabled: market.status === 'loading' || !marketQuery.trim(),
                  onClick: () => runMarketSearch(),
                }, market.status === 'loading' ? t('loading') : t('marketSearch'))))
          : null,
        h('div', { className: 'dsh-mcp-list' }, tab === 'market' ? marketRows() : rows),
        tab === 'installed' ? h('div', { className: 'dsh-mcp-add' },
          h('span', { className: 'dsh-mcp-title' }, t('addTitle')),
          h('textarea', {
            className: 'dsh-mcp-input', value: addText, placeholder: t('addPlaceholder'),
            onChange: (e) => setAddText(e.target.value),
          }),
          h('div', { className: 'dsh-mcp-actions' },
            h('button', { type: 'button', className: 'dsh-mcp-button',
              disabled: Boolean(busy.__add) || !addText.trim(), onClick: runParse },
              busy.__add === 'parse' ? t('loading') : t('parse'))),
          addError ? h('div', { className: 'dsh-mcp-error' }, addError) : null,
          preview?.needsInput?.length
            ? h('div', { className: 'dsh-mcp-error' }, t('needsInput', { items: preview.needsInput.join('; ') }))
            : null,
          preview?.preview
            ? h('div', null,
                h('div', { className: 'dsh-mcp-meta' }, t('previewTitle')),
                h('div', { className: 'dsh-mcp-preview' }, preview.preview),
                (preview.notes ?? []).map((n, i) => h('div', { key: `n${i}`, className: 'dsh-mcp-meta' }, `note: ${n}`)),
                (preview.warnings ?? []).map((w, i) => h('div', { key: `w${i}`, className: 'dsh-mcp-meta' }, `warn: ${w}`)),
                h('div', { className: 'dsh-mcp-actions' },
                  h('button', { type: 'button', className: 'dsh-mcp-button', disabled: Boolean(busy.__add),
                    onClick: runWrite }, busy.__add === 'write' ? t('loading') : t('write')),
                  h('button', { type: 'button', className: 'dsh-mcp-button',
                    onClick: () => setPreview(null) }, t('cancel'))))
            : null) : null);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-mcp-manager: dictionaries');
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
          name: 'plugins.detail.section',
          id: 'dsh-mcp-manager',
          order: 10,
          locale: NS,
          inject: () => ({ t }),
        }, Panel));
      },
      __test: { NS, BUNDLE_NAME, API, isOurs, badgeState, badgeKey, dotProps, commandLine, probeText, errorMessage, hasRawJsExpr, openEditor, marketCommandLine, needsExecutionCheckbox, gapText, driftText, driftLabel, ZH, EN },
    };
  },
});
