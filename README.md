# @dsh-contrib/dsh-mcp-manager

[English](README.en.md) | 中文

对登记在 DSH patch 文件中的 MCP 服务器条目提供查看、探测、安装、编辑、启停、删除与凭据轮换。条目格式遵循官方 `@deepseek-ai/dsh-mcp-client` 的配置契约，全部写入经过同一条带守卫的管线。

## 概述

在 DSH 中新增一台 MCP 服务器通常意味着手工编辑 `~/.dsh/cordis.patch.yml`：新增条目必须置于 `insert:` 列表内，`serverName` 在作用域内唯一，凭据不得以明文写入 patch。任一处不符都会导致条目不被挂载，或使配置重载失败。

本包把这一过程收敛为受校验的操作。写入先经过 DSH 自身加载器与官方字段规则校验，通过后才以原子方式落盘并保留 `.bak` 备份；未通过校验的候选内容不会触及实际文件。

同一套引擎驱动三个界面：Agent 工具（`mcp_manager_*`）、命令行（`cli/mcp.js`）与 Web 面板。凭据轮换仅在 Agent 工具与命令行中提供，面板不允许写入原始 `!!js` 表达式。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [失败行为](#failure-behavior)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

安装：把下面一行交给 agent，或在 Web 侧边栏的**插件**页中安装同一地址。

```
plugin_manager install_bundle https://github.com/shiliu153/dsh-mcp-manager
```

安装完成后 `mcp_manager_*` 工具即可用。验证方式是调用 `mcp_manager_list`：**该调用返回列表即表示插件已挂载**，列表为空同样算通过——本包不预设用户已登记任何服务器，新环境下的空列表是正常结果。

### 支持的输入格式

`mcp_manager_add` 与命令行 `add` 接受四种粘贴形式，`serverName` 由输入自动推导，可在预演阶段调整。

| 粘贴内容 | 示例 |
|---|---|
| npm 包名 | `@modelcontextprotocol/server-memory` |
| GitHub 仓库 | `https://github.com/modelcontextprotocol/servers` |
| MCP 端点 | `https://mcp.example.com/mcp` |
| JSON 配置 | `{"command":"npx","args":["-y","@upstash/context7-mcp"]}` |

### Agent 工具

安装后以下八个工具对 agent 可用。写入类工具默认只执行预演：先返回将要写入的内容与各项校验结果，确认无误后再以 `confirm: true` 重新调用。

| 工具 | 用途 | 需确认 |
|---|---|:---:|
| `mcp_manager_list` | 列出已登记服务器，凭据值已掩码 | — |
| `mcp_manager_probe` | 对单台或全部服务器执行真实握手 | — |
| `mcp_manager_validate` | 按官方 mcp-client 规则校验条目 | — |
| `mcp_manager_credential` | 定位、掩码显示或轮换凭据文件 | — |
| `mcp_manager_add` | 从粘贴的地址新增服务器 | 是 |
| `mcp_manager_update` | 替换某条目的 `config:` 子树 | 是 |
| `mcp_manager_toggle` | 启用或禁用条目 | 是 |
| `mcp_manager_remove` | 移除条目 | 是 |

### 命令行

零外部依赖，与 Agent 工具共用同一套引擎，无需 harness 即可运行。

```sh
node cli/mcp.js list [--json]
node cli/mcp.js probe [--id <id>] [--timeout 60]
node cli/mcp.js add "<npm-package | github-url | mcp-url | json>" [--yes] [--no-probe]
node cli/mcp.js show <id> [--json] [--masked]
node cli/mcp.js edit <id> [--config <file>] [--yes]      # 省略 --config 时读取 stdin
node cli/mcp.js enable|disable <id> --yes
node cli/mcp.js remove <id> --yes
node cli/mcp.js credential <id> get|set <value>
node cli/mcp.js validate <id>
node cli/mcp.js schema
```

| 参数 | 含义 |
|---|---|
| `--file <path>` | 指定 patch 文件；缺省为 `$DSH_HOME/cordis.patch.yml` 或 `~/.dsh/cordis.patch.yml`。 |
| `--json` | 输出机器可读结果（`list`、`show`）。 |
| `--yes` | 跳过确认。 |
| `--masked` | `show` 时以占位符替换 `!!js` 表达式。 |

退出码：`0` 成功，`1` 失败，`2` 用法错误。

### Web 面板

启用本包后，侧边栏**插件**页下的 **DSH MCP 管理器** 列出已登记服务器。每行显示状态点、id、serverName、传输方式，以及命令行或 URL。

状态点直接读取 harness 的 MCP 资源注册表，因此「已配置」与「实际已连接」在界面上是两个不同的状态：

| 显示 | 悬停提示 | 含义 |
|:---:|---|---|
| 绿色圆点 | 已连接 | 服务器进程存活，可正常调用 |
| 橙色圆点 | 已启用 · 未连接 | 条目已启用，但未连上 |
| 灰色圆点 | 已禁用 | 条目被停用 |
| 空心圆环 | 连接状态不可用 | 无法读取 harness 的实时注册表 |

每行可执行的操作：

- **探测**——执行真实握手，报告工具数量或失败原因。列表不做自动探测，因此可以即时打开；面板头部的**一键探测**可一次并发探测全部服务器。
- **编辑**——展开文本域，内容为该行自身的 `config:` 子树 YAML，含注释、键序与 `!!js` 引用。**校验并预览**按官方规则预演变更，**写入**通过带守卫的管线应用变更并探测结果。
- **启用 / 禁用开关**，以及一次内联确认的**删除**。
- **新增服务器**——粘贴上述四种格式之一，点击**解析**生成预览，确认将要追加的 YAML 内容后再写入。
- **刷新**——重新读取 patch 文件与实时连接状态。

面板通过 `ctx.connection.registerFetchRoute` 在 `/api/dsh-mcp-manager/` 下注册精确的 Fetch 路由，因此 harness 自身的 Host/Origin 校验与浏览器会话认证先于任何处理函数执行。面板自身不实现信任边界，所有写入都经过与命令行相同的带守卫管线。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 写入的配置条目

条目严格遵循官方 `@deepseek-ai/dsh-mcp-client` 契约：

```yaml
- insert:
    - id: mcp-<serverName>
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: <serverName>      # [A-Za-z0-9_-]{1,32}，需唯一
        transport: stdio              # 或 streamable-http
        command: npx                  # 仅 stdio
        args: ['-y', '<package>']
        failOnStartupError: true      # 本包写入的条目默认值
```

新增服务器必须置于独立的 `insert:` 列表内。顶层裸条目用于按 id 覆盖**已有**条目；若其不匹配任何现有条目，加载器会告警并跳过，因此追加一个裸条目不会挂载新服务器。

密钥不写入 patch：工具将其存入凭据文件，并以 `!!js` 表达式引用，与官方 GitHub 条目采用同一模式。DSH 会热重载 patch，新增或修改的服务器在当前会话即可使用。

编辑操作只替换指定条目的 `config:` 子树，其余内容保持不变：条目上方的注释块、`- id:`、`name:` 与 `disabled:` 行，以及其他所有条目都逐字节一致。读出一个子树后原样写回可精确复现文件内容，这一点由测试套件断言。

### 安全模型

- **写入目标**为 home 覆盖层 `~/.dsh/cordis.patch.yml`。官方组合顺序：bundle patches → profile patch → home patch → `--patch`。
- **显式确认**：每次变更都要求 `confirm: true` 或 `--yes`；删除、启停与编辑保留前一份文件的 `.bak`。
- **四重校验**：候选内容须能在 DSH 自身加载器下解析、符合官方字段规则、不含硬编码密钥，且所有 `serverName` 保持唯一。
- **写入前后双重把关**：新增操作在写入前后各校验一次——候选行必须位于 insert 列表内、能通过加载器解析出 `serverName`、且不与已登记项重名。写入后针对已持久化的行再次执行同一检查，因此 `probe OK` 只可能描述确实存在于文件中的条目。
- **并发写入保护**：面板在编辑期间以原始文本持有内容，写入时回传所读文件的 `mtime`；文件在此期间被修改则以 `file_changed` 拒绝，不覆盖对方的改动。
- **探测只读**：探测不启动浏览器，也不将凭据发送到服务器自身端点之外的任何位置。
- **`!!js` 求值**：探测按 harness 的方式先解析 `!!js` 值再发送。加载器返回的是惰性的 `{ __jsExpr }` 标记对象，直接转发会使以表达式写入的凭据以 `Authorization: [object Object]` 到达服务器并返回 `400`，将有效凭据误报为格式错误。无法求值的表达式按名称报告，不转发。

所有写入共用同一条带守卫的管线：

```
读取原文件 → 在候选副本上执行文本手术 → DSH 加载器校验 → mtime 复核 → .bak 备份 → 原子替换
```

### 项目结构

`lib/` 为共享实现，`cli/`、`index.js` 与 `client.js` 是它的三种入口。

```
index.js            宿主插件入口：在 ctx.tools 注册 mcp_manager_* 工具，
                    并在存在 web profile 时通过 ctx.connection 注册面板路由
client.js           浏览器端面板（单文件，由 /plugins/<id>/client.js 直接提供）
cli/mcp.js          命令行入口
lib/                共享引擎
  dump.js           经 DSH 自身加载器结构化读取 patch 文件
  jsexpr.js         !!js 值的运行时求值
  patchfile.js      带守卫的写入管线（手术 → 校验 → mtime 复核 → .bak → 原子替换）
  surgery.js        保留注释的文本手术：增删条目、启停、替换 config 子树
  rules.js          官方 dsh-mcp-client 条目字段规则
  resolve.js        将粘贴的项目地址解析为官方 patch 条目
  probe.js          真实 MCP 握手（stdio 与 streamable-http）
  rows.js           行筛选与凭据掩码（命令行、宿主工具与面板共用同一实现）
  update.js         编辑策略：!!js 占位符协议与语义闸门
  server.js         面板的 Fetch 路由
  tools-bridge.js   官方工具定义形态与管理器库之间的桥接
  subprocess.js     最小化同步子进程辅助
locale/             面板文案（en / zh）
assets/skills/      随包提供的 Agent 技能定义（置于 ~/.dsh/skills/ 后生效）
cordis.patch.yml    本包自身的 patch，用于注册 dsh-mcp-manager
docs/official/      从已安装的 DSH app.asar 中提取的官方规则
```

`rows.js` 的掩码实现只有一份：若出现漂移副本，凭据会泄漏到浏览器。`lib/` 保持零外部依赖，便于测试与在命令行中独立运行。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- 官方 `@deepseek-ai/dsh-mcp-client` 条目规则——`docs/official/`。
- 本包的设计与实施计划——`docs/specs/`、`docs/plans/`，端到端实测记录见 `docs/records/`。
- 随包 Agent 技能——`assets/skills/dsh-mcp-manager/SKILL.md`。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 面板不写入 `!!js` 表达式。Loader 在运行时对表达式求值，等同于在 harness 进程中执行代码，因此面板只提交不透明占位符（`Authorization: !!js «0»`），由宿主原样回填。凭据轮换与表达式改动需经命令行或 Agent 工具。
- 面板中携带硬编码密钥的条目为只读，需经命令行或 Agent 工具处理。
- 编辑只作用于条目的 `config:` 子树。`id` 与 `name` 不经此路径修改，`disabled` 由 `mcp_manager_toggle` 负责。
- 本包自身的代码更新需要重启进程以加载新的 JavaScript 模块版本；HMR 只覆盖配置重载，不覆盖模块代码替换。
- 命令行与 Agent 工具可以写入原始 `!!js` 文本，其信任级别与手工编辑 patch 文件相同。

-----

<a id="failure-behavior"></a>
## 失败行为

拒绝发生在写入之前，实际 patch 文件保持不变。

| 情形 | 处理方式 |
|---|---|
| 候选内容无法通过 DSH 加载器解析 | 拒绝写入，保留 `.candidate` 供查看；实际文件不变。 |
| 候选内容违反官方字段规则 | 拒绝写入，只报告原因，删除 `.candidate`；实际文件不变。 |
| 候选内容含硬编码密钥 | 同上。 |
| 候选 `serverName` 与已登记项重名 | 拒绝写入并报告重名；实际文件逐字节不变。 |
| 面板写入时文件已被外部修改 | 以 `file_changed` 拒绝，提示重新加载后再改。 |
| 探测失败 | 报告进程启动失败、超时、HTTP 状态码或工具列表；不修改任何内容。 |

探测失败不会改动条目，修复方式是按结果修正配置（启停、改配置、重新添加），而非重复添加同一 `serverName`——官方加载器在单一作用域内拒绝重名。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

```sh
node --test "test/*.test.mjs"   # 179 个测试，零依赖
node -e "import('./scripts/check-bundle.mjs').then(m => console.log(m.checkBundle('.')))"
```

官方规则以 vendored 形式存放于 `docs/official/`，提取自已安装的 DSH `app.asar`，来源说明见 `docs/official/README.md`。

</details>
