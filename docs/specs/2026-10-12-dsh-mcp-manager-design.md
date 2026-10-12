# dsh-mcp-manager — DSH MCP 服务器管理插件 · 设计文档(v2 · 发布导向)

日期:2026-10-12(v2 修订:按官方插件开发规则 + GitHub `dsh-plugin` topic 发布要求重写)
状态:设计经用户逐节确认;v2 依据官方 asar 内文档修订,待用户终审
目标仓库:`D:\pycharmproject\dsh-mcp`(已 git init,spec 已随 v1 提交)

## 0. v2 修订缘由(官方规则 + 发布要求)

用户要求:① 插件开发必须满足官方插件开发规则;② 插件将发布到 https://github.com/topics/dsh-plugin ,所有设计必须确保**可安装、可使用**。

据此把 v1 的"本机 CLI + 技能"升级为**发布导向的三位一体**,同一核心库支撑:

1. **DSH bundle(发布主体)**:一个符合官方规范的纯配置+Host 插件包,任何 DSH 用户都能通过官方通道(GitHub URL 安装)使用;
2. **CLI(本地开发/独立使用面)**:同样的核心逻辑提供命令行,便于脱离会话使用与本仓库测试;
3. **技能/文档(使用面)**:教 agent 驱动安装与管理流程。

官方规则的权威来源(已从 `app.asar` 提取,vendored 进 `docs/official/`):

- 官方技能 `cordis-plugin-development`(SKILL + references/host-plugin.md + references/mcp-bundle.md + templates/mcp/);
- `@deepseek-ai/dsh-mcp-client` README(字段表 = 官方配置契约);
- `@deepseek-ai/dsh-plugin-manager` README(install/list/toggle/remove 语义、GitHub 安装前置检查);
- `@deepseek-ai/dsh` README(profile 组合顺序、`dsh plugin`、`--dump-config(-schema)`)。

## 1. 交付物与仓库结构(bundle 即仓库根)

```
dsh-mcp/                                ← GitHub 仓库,topic: dsh-plugin
├── package.json          ← bundle 清单(见 §3 合规清单)
├── cordis.patch.yml      ← 插入本插件 Host 行(官方 mcp 模板同款方言)
├── index.js              ← Host 插件:apply(ctx, config) 注册管理工具
├── lib/                  ← 核心库(CLI 与插件共用)
│   ├── dump.js           ← 桥接 loadOptionalPatches() 读 patch(保真 !!js)
│   ├── surgery.js        ← 注释保持文本手术(add/remove/enable/disable)
│   ├── resolve.js        ← 输入解析(npm/GitHub/URL/JSON → mcp-client 条目)
│   ├── probe.js          ← MCP 握手探测(stdio JSON-RPC / streamable-http)
│   ├── rules.js          ← 官方规则校验(serverName/transport/字段对/范围)
│   └── patchfile.js      ← home patch 定位、原子写、.bak、mtime 防覆盖
├── cli/mcp.js            ← CLI 入口(bin: dsh-mcp),复用 lib/
├── locale/en.json, zh.json, icon.svg   ← 显示元数据(官方 host-plugin.md 规则)
├── test/                 ← node:test 单测 + 夹具
├── docs/
│   ├── official/         ← vendored 官方文档(提取自 app.asar,注明来源路径)
│   └── specs/            ← 本设计文档
└── README.md             ← 英文为主:安装方法(plugin_manager install_bundle <github-url> / Web Plugins 页)、使用说明
```

**发布即仓库**:用户安装方式为官方通道——会话内 `plugin_manager` `install_bundle https://github.com/<owner>/dsh-mcp`(plugin-manager 对 GitHub 仓库先做 `git ls-remote` 连通性检查再走 pnpm),或 Web 侧栏 Plugins 页安装。安装发生 bundle 校验:清单合法 + 声明了 `dsh.bundle.patch` 才算 bundle。

## 2. Host 插件设计(插件的功能面)

`index.js` 采用官方 Host 导出形式一:`export function apply(ctx, config)` + `export const Config`(声明 Config 即在激活时校验行 config)。在 `apply` 内经 `ctx.effect`/`ctx.on` 注册管理工具(工具经 DSH 权限系统,逐调用走审批,与官方 `plugin_manager` 工具行为一致):

| 工具 | 作用 |
|---|---|
| `mcp_manager_list` | 读 home patch,列出现有 mcp-client 行(id/serverName/transport/command或url/disabled),凭据掩码 |
| `mcp_manager_probe` | 对指定 id 或全部行做真实握手,报工具数/失败原因 |
| `mcp_manager_add` | 解析用户粘贴的地址(§5),干跑返回拟写入条目等用户确认;`confirm: true` 时落盘 |
| `mcp_manager_remove` / `mcp_manager_toggle` | 删除 / 启停指定 id 行(需确认参数) |
| `mcp_manager_credential` | 定位/掩码显示/轮换行内 `!!js` 引用的凭据文件 |
| `mcp_manager_validate` | 对拟写入或既有条目跑 §4 官方规则校验 |

**写入目标 = home 层 `~/.dsh/cordis.patch.yml`**(组合顺序:bundle 补丁 → profile patch → home patch → `--patch`),理由:① 这是官方文档明载的用户覆盖层;② 本机第一方 `mcp_server_*` 工具写的正是这一层,属受认可的通道(官方禁令针对的是手工改 profile 目录内文件、绕过 install_bundle);③ home patch 被 dsh-hmr 监听,写入即热生效。

写路径安全门(与 v1 相同,移入 lib 由插件工具与 CLI 共用):文本手术只做在候选副本 → `loadOptionalPatches("dsh", candidate)` 校验 → 原子落盘(临时文件+rename)→ 落盘前留 `.bak` → 写前核对 mtime。

## 3. 官方合规清单(add 与 CI 都按此逐项检查)

清单 manifest(host-plugin.md):
- [ ] `name` 唯一(建议 `@<owner>/dsh-mcp-manager` 形态)、`version` 合法、`"private": true`(不发布 npm,仅供 GitHub/路径安装,官方模板同款);
- [ ] `"type": "module"`;Host 行 `config: {}` 且插件声明 `export const Config`;
- [ ] `dsh.bundle.patch` 指向随包 patch;patch 方言为顶层数组 `- insert: [- id, name, config]`;`exports` 含 `".": "./index.js"`、`"./package.json"`、`"./locale/*.json"`,与 `files` 对齐(locale、icon);
- [ ] 显示元数据:`locale/en.json`(`meta.title/description`)+ `locale/zh.json` + 顶层 `icon`(相对路径、SVG/PNG/JPEG/WebP ≤256KiB、不越出包目录、不用符号链接逃逸),`exports` 暴露 `./package.json`、`./locale/*.json`,`files` 列出 locale 与 icon;
- [ ] 无安装脚本、无构建工具依赖(Host-only bundle 不需要 dependencies)。

mcp-client 行规则(dsh-mcp-client README 字段表,写入用户服务器的条目必须满足):
- [ ] `serverName` 匹配 `[A-Za-z0-9_-]{1,32}` 且同注册 scope 内唯一(重名后者加载失败);
- [ ] `transport` ∈ {`stdio`,`streamable-http`};stdio 必填 `command`(经 cross-spawn,`npx` 可用),http 必填 `url`;
- [ ] `toolCallTimeoutMs` 默认 60000;`failOnStartupError` 默认 false(本插件为用户写入的行默认 true,装完即可见错误);
- [ ] reconnect 参数范围:`initialDelayMs≥0`、`maxDelayMs≥initial`、`maxAttempts≥0`;
- [ ] env/header:秘密不进 patch——token 存独立凭据文件,patch 用 `!!js` 表达式读取(官方 github 行先例);**明确修正 v1 的错误认知**:清洗发生在 DSH 进程自身环境(`/KEY|PASSWORD|SECRET|TOKEN/i` 与 `DSH_*`),配置显式写的 `env` 会合并覆盖并正常到达 stdio 子进程(官方示例即如此),因此 env 校验只做"秘密不硬编码"检查,不做"秘密名会被清洗"的伪警告;
- [ ] 校验权威源:可用时用 `dsh --dump-config-schema` 的官方 JSON Schema 比对;不可用时用 README 字段表内嵌规则(rules.js)。

补丁层完整性:patch 文件必须可被 `loadOptionalPatches` 解析(存在但解析失败会在 boot 时 loud fail)。

## 4. add 的输入解析(沿用 v1,落点改为官方条目形态)

判定顺序:JSON(首字符 `{`/`[`)→ URL → GitHub 仓库 → npm 包名。

- npm 包名 → stdio `npx -y <pkg>`,serverName 由包名推导(去 scope、去 `-mcp`/`-server` 后缀,截断到 32 字符字符集);
- GitHub 仓库 → 抓 package.json/README(匿名优先,可选带 token):可判 bin → stdio;README 含远程 MCP 端点 → streamable-http;推不出 → 模板待补;
- 其他 http(s) URL → streamable-http;需鉴权走凭据文件 + `!!js`;
- JSON 片段(Claude Code `mcpServers` / 单服务器 / DSH 行)→ 字段映射(command→stdio,url→streamable-http),env 透传;
- 歧义一律停下询问。

## 5. 探测(probe)

- stdio:spawn → `initialize` → `tools/list`,报工具数;
- streamable-http:POST `initialize`(处理 `Mcp-Session-Id`)→ `tools/list`;
- 默认超时 60s(对齐官方 SDK 启动/发现默认),`--timeout`/参数可调;
- probe 只读无副作用;失败逐服务器报因(spawn 失败/超时/HTTP 状态码/401 凭据失效)。

## 6. 错误处理(沿用 v1)

活文件解析失败→中止不写并提示 `.bak` 恢复;校验失败→原样输出诊断、候选留在原地;mtime 变化→重读重做;probe 逐服务器隔离失败;DSH 未运行时写操作仍安全(合法性由校验门保证)。

## 7. 测试与"可使用"验证(发布门槛)

1. **单测**(node:test,零依赖):块边界、enable/disable(含无 `disabled:` 行块)、remove(含 insert 数组内行)、add 追加、坏 YAML 被校验门拒绝、四种输入解析(fetchFn 注入)、官方规则逐条(合法/非法 serverName、缺字段对、reconnect 范围、秘密硬编码拒绝)、掩码。
2. **CLI 链路**:`--file` 打临时副本走 add→validate→surgery→probe 全程。
3. **bundle 合规自检**:清单/patch/metadata 按官方 host-plugin.md 模板逐项比对(脚本化),vendored 官方模板为蓝本。
4. **端到端(发布前必过)**:在本机 DSH 上真实安装——经 Web Plugins 页(browser 自动化驱动)或用户手动,对本地路径/最终 GitHub URL 执行安装;读取返回 `application`/`warnings` 确认 `applied`;`cordis_inspect_query`/工具清单确认六个 `mcp_manager_*` 工具出现;实测 `mcp_manager_list` 与一次 probe;对失败**原地修复同一 bundle**(官方禁令:不许另建重复)。干净 profile 冒烟一次,确认不依赖本机既有状态。
5. **发布检查**:README 含官方安装命令;tag 语义化版本;仓库打 `dsh-plugin` topic;从另一台/干净环境按 README 能装能用(至少干净 profile 验证过)。

## 8. 使用面(技能)

- 随包技能:仿照官方 `dsh-skill-office` 的 assets 形态在 bundle 内携带使用技能(安装后对 agent 可见;具体注册机制以 dsh-skill-office 实测为准,E2E 阶段验证);
- 本机技能:`~/.dsh/skills/dsh-mcp-manager/`(v1 方案保留,内容改为驱动 CLI/插件工具:触发时机、确认流程、`mcp__<serverName>__<tool>` 汇报、踩坑清单——校验先行、秘密走凭据文件、npx/cross-spawn、`!!js` 凭据模式)。

## 9. 范围外(YAGNI)

GUI 面板;相似包推荐;自动升级;多 profile 管理界面(`--file`/参数可定位,不另建 profile 概念)。

## 10. v1 → v2 保留与变更对照

| 项 | v1 | v2 |
|---|---|---|
| 交付形态 | 本机 CLI + 技能 | GitHub 发布 bundle(主体)+ CLI + 技能 |
| 核心库 | dump/surgery/resolve/probe | 同左 + rules(官方规则校验)+ patchfile |
| 写入目标 | home patch | home patch(不变,补充官方组合顺序依据) |
| 校验门 | loadOptionalPatches | 同左 + §3 官方规则清单 |
| add 产物 | patch 行 | patch 行(`--bundle` 亦产官方纯配置 bundle 模板) |
| env 清洗认知 | 显式 env 会被清洗(**错误**) | 清洗只作用于 DSH 自身环境;显式 env 正常到达(**已按官方 README 修正**) |
| probe 超时 | 30s | 60s(对齐官方 SDK 默认) |
| 验证 | 单测+CLI 冒烟 | + bundle 合规自检 + Web 端到端安装验证 + 干净 profile |
