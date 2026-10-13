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

    function PanelBody() {
      return null; // Task 8
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
