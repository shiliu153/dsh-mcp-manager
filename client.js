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
      remove: '删除',
      removeConfirm: '确认删除？',
      cancel: '取消',
      toggleLabel: '启用或禁用 {id}',
      probeOk: '{count} 个工具',
      probeFailed: '探测失败：{error}',
      addTitle: '新增服务器',
      addPlaceholder: '粘贴 npm 包名 / GitHub 仓库 / MCP 端点 / JSON 片段',
      parse: '解析',
      previewTitle: '预览',
      write: '写入',
      needsInput: '还缺信息：{items}',
      empty: '没有已登记的 MCP 服务器',
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
      remove: 'Delete',
      removeConfirm: 'Delete?',
      cancel: 'Cancel',
      toggleLabel: 'Enable or disable {id}',
      probeOk: '{count} tools',
      probeFailed: 'Probe failed: {error}',
      addTitle: 'Add a server',
      addPlaceholder: 'Paste an npm package, GitHub repo, MCP endpoint, or JSON fragment',
      parse: 'Resolve',
      previewTitle: 'Preview',
      write: 'Write',
      needsInput: 'Still needed: {items}',
      empty: 'No MCP servers registered',
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

    function commandLine(server) {
      if (server.url) return server.url;
      return [server.command, ...(server.args ?? [])].filter(Boolean).join(' ');
    }

    function probeText(result, t) {
      if (!result) return '';
      if (result.error) return t('probeFailed', { error: result.error });
      return t('probeOk', { count: String(result.toolCount ?? 0) });
    }

    function errorMessage(payload, fallback) {
      return payload?.error?.message ?? fallback;
    }

    // ---- components ----

    /** Hook-free wrapper: the ownership test runs before any hook is called. */
    function Panel(props) {
      return isOurs(props.subject) ? h(PanelBody, props) : null;
    }

    // Colours are theme tokens only, so a renamed token degrades appearance
    // rather than breaking rendering.
    const CSS = `
.dsh-mcp { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.dsh-mcp-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dsh-mcp-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-text-primary); }
.dsh-mcp-path { font-size: 12px; color: var(--dsw-alias-text-secondary); word-break: break-all; }
.dsh-mcp-list { display: flex; flex-direction: column; gap: 8px; }
.dsh-mcp-row { border: 1px solid var(--dsw-alias-border-secondary); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.dsh-mcp-row-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dsh-mcp-id { font-weight: 600; color: var(--dsw-alias-text-primary); }
.dsh-mcp-meta { font-size: 12px; color: var(--dsw-alias-text-secondary); }
.dsh-mcp-target { font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: var(--dsw-alias-text-secondary); word-break: break-all; }
.dsh-mcp-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.dsh-mcp-badge { font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-secondary); color: var(--dsw-alias-text-secondary); }
.dsh-mcp-badge[data-state="connected"] { color: var(--dsw-alias-text-primary); }
.dsh-mcp-result { font-size: 12px; color: var(--dsw-alias-text-secondary); }
.dsh-mcp-button { font-size: 12px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-secondary); background: transparent; color: var(--dsw-alias-text-primary); cursor: pointer; }
.dsh-mcp-button:disabled { opacity: 0.5; cursor: default; }
.dsh-mcp-switch { width: 36px; height: 20px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-secondary); background: transparent; cursor: pointer; position: relative; }
.dsh-mcp-switch[data-on="true"] { background: var(--dsw-alias-brand-primary); }
.dsh-mcp-error { font-size: 12px; color: var(--dsw-alias-text-primary); border: 1px solid var(--dsw-alias-border-secondary); border-radius: 6px; padding: 8px 10px; }
.dsh-mcp-add { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--dsw-alias-border-secondary); padding-top: 12px; }
.dsh-mcp-input { width: 100%; min-height: 56px; resize: vertical; font-family: inherit; font-size: 13px; padding: 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-secondary); background: transparent; color: var(--dsw-alias-text-primary); }
.dsh-mcp-preview { font-family: ui-monospace, Consolas, monospace; font-size: 12px; white-space: pre-wrap; border: 1px solid var(--dsw-alias-border-secondary); border-radius: 6px; padding: 8px; color: var(--dsw-alias-text-secondary); }
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
          const badgeKey = { connected: 'badgeConnected', enabledOffline: 'badgeEnabledOffline',
            disabled: 'badgeDisabled', unknown: 'badgeUnknown' }[badge];
          const isBusy = Boolean(busy[s.id]);
          rows.push(h('div', { key: s.id, className: 'dsh-mcp-row' },
            h('div', { className: 'dsh-mcp-row-head' },
              h('span', { className: 'dsh-mcp-id' }, s.id),
              h('span', { className: 'dsh-mcp-meta' }, s.serverName),
              h('span', { className: 'dsh-mcp-meta' }, s.transport),
              h('span', { className: 'dsh-mcp-badge', 'data-state': badge }, t(badgeKey)),
              h('span', { className: 'dsh-mcp-actions' },
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
                  className: 'dsh-mcp-switch', 'data-on': !s.disabled, disabled: isBusy,
                  onClick: () => runToggle(s),
                }))),
            h('div', { className: 'dsh-mcp-target' }, commandLine(s)),
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
          h('button', { type: 'button', className: 'dsh-mcp-button', disabled: state.status === 'loading',
            onClick: load }, t('refresh'))),
        state.status === 'ready' && state.data?.patch
          ? h('div', { className: 'dsh-mcp-path' }, `${t('patch')}: ${state.data.patch}`)
          : null,
        h('div', { className: 'dsh-mcp-list' }, rows),
        h('div', { className: 'dsh-mcp-add' },
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
            : null));
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
      __test: { NS, BUNDLE_NAME, API, isOurs, badgeState, commandLine, probeText, errorMessage, ZH, EN },
    };
  },
});
