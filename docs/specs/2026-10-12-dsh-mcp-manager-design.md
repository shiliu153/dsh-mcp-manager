# dsh-mcp — DSH MCP 服务器全生命周期管理工具 · 设计文档

日期:2026-10-12
状态:已经用户逐节确认
产物:`~/.dsh/port/mcp/`(CLI)+ `~/.dsh/skills/dsh-mcp-manager/`(技能)

## 1. 背景与目标

DSH 的 MCP 服务器登记在用户级补丁层 `~/.dsh/cordis.patch.yml`(一行一条,id 如 `mcp-github`,name 固定 `@deepseek-ai/dsh-mcp-client`),该文件被 DSH 监听、HMR 热加载。当前痛点:

- 配置文件里积累了大量踩坑注释(`!!js` 凭据表达式、cross-spawn 解析 npx、秘密名清洗规则),手工编辑容易破坏;
- 会话内虽有 `mcp_server_*` 工具,但"粘贴一个项目地址帮我装好"需要每次现推传输方式与启动命令,没有沉淀;
- 没有 CLI 能在会话外查看/校验/管理。

目标:一个零依赖的 Node CLI `mcp.js` 覆盖 MCP 服务器全生命周期(查看 / 探测 / 安装 / 启停 / 删除 / 凭据轮换),外加一个技能让"复制地址→安装"成为对话里的一句话交互。

成功标准(验收口径):

1. `node mcp.js list` 秒出三行现有服务器(chrome-devtools / playwright / github),凭据掩码;
2. `probe` 能报出每个服务器实际工具数,github 在 token 失效时给出 401 级别的明确失败原因;
3. 粘贴 npm 包名 / GitHub 仓库 / MCP HTTP 地址 / JSON 片段,经确认后一条命令装好并 probe 验证;
4. 任何写操作产生的坏配置都到不了线上文件(校验门先行)。

## 2. 总体架构

```
~/.dsh/port/mcp/
├── mcp.js          ← 唯一 CLI 入口(node 直接跑,零 npm 依赖,Node ≥ 22)
├── lib/
│   ├── dump.js     ← 桥接 DSH 自己的加载器读取/解析 patch(保真,含 !!js 求值)
│   ├── surgery.js  ← 注释保持型文本手术(add / remove / enable / disable)
│   ├── resolve.js  ← 输入解析器(npm 包 / GitHub 仓库 / HTTP URL / JSON 片段)
│   └── probe.js    ← 真实握手探测(stdio JSON-RPC / streamable-http)
├── test/           ← node:test 单测 + cordis.patch.yml 净化副本夹具
└── README.md
```

### 2.1 读取:用 DSH 自己的解析器

所有需要结构化配置的命令通过桥接脚本 `import` 打包在 `app.asar` 里的
`@deepseek-ai/dsh-app-boot` 的 `loadOptionalPatches()`(与现有 `~/.dsh/port/validate_patch.js` 第 13 行同款 URL,注意路径含空格需百分号编码)得到结构化行数组。收益:YAML 解析、`!!js` 表达式求值、patch 语义(裸条目覆盖 / `{insert:[...]}` 追加)与 DSH 完全一致,不自造解析器。桥接以 `--input-type=module` 的子进程方式运行,把行数组 JSON 打到 stdout。

### 2.2 写入:注释保持的文本手术

`js-yaml.dump` 会丢掉全部注释,因此所有写操作直接对原始文本做手术。块边界规则(唯一规则):**顶层条目从 `^- id:` 或 `^- insert:` 行开始,到下一个这样的行(或文件尾)为止**。`insert:` 内部的行(`    - id: ...`)因缩进不同不会误判。

| 操作 | 文本动作 |
|---|---|
| add | 在文件尾追加新块(空行分隔 + 注释头) |
| remove | 删除整块;若该块来自顶层 `insert:` 数组则只删数组内对应行,数组空了再删整个 insert 块 |
| enable / disable | 在该块内改写或插入 `disabled: true/false` 行 |

### 2.3 校验门(不可绕过)

任何写操作:手术只做在**候选副本**上 → 用 DSH 自己的 `validate_patch.js` 同款 `loadOptionalPatches()` 校验候选文件 → 通过才原子落盘(写临时文件后 rename),落盘前把线上文件复制为 `cordis.patch.yml.bak`。落盘后 DSH 自动热重载,无需重启。坏文件永远到不了线上——这是对 `~/.dsh/port` 现有 candidate→validate→落盘惯例的直接复用。

### 2.4 隔离与干跑

所有命令支持 `--file <path>` 覆盖默认配置路径。单测与演练都打在夹具副本上;涉及真文件的冒烟验证只在最后做一次。

## 3. 命令面(全生命周期)

| 命令 | 作用 |
|---|---|
| `list [--json]` | 表格:id、serverName、transport、command/url、disabled;凭据值一律掩码(`B*****`) |
| `probe [--id x] [--timeout s]` | 真实握手:stdio → spawn 子进程,发 `initialize` + `tools/list`;http(streamable-http)→ POST `initialize`(带 `Mcp-Session-Id` 跟随)→ `tools/list`;报工具数与失败原因 |
| `add <input> [--yes]` | 第 4 节解析;默认干跑展示拟写入条目等确认,`--yes` 跳过(供技能在用户已确认后使用) |
| `remove <id>` | 删除条目(需确认) |
| `enable <id>` / `disable <id>` | 切换 `disabled`(需确认) |
| `credential <id> get\|set <value>` | 定位该服务器引用的凭据文件(如 `github-mcp-token.txt`);get 掩码显示;set 覆写文件并 touch patch 文件触发重载(复用 yml 注释里已记载的轮换机制) |

凭据文件定位规则:在该服务器块内扫描 `!!js` 表达式中的文件路径(匹配 `readFileSync("...")` 之类取第一个绝对/家目录路径);块内没有凭据引用时,`credential` 命令直接报告"该服务器未引用凭据文件"而不是猜。掩码规则:凡是 key 匹配 `/KEY|PASSWORD|SECRET|TOKEN|AUTH/i` 的 header/env 值,或 `!!js` 表达式的求值结果,一律显示为 `B*****`(保留长度不给,内容不给)。

`add` 收尾自动跑 `probe --id <新id>` 验证连通并报告工具数。

## 4. add 的输入解析(全能形态)

判定顺序:JSON(首字符 `{`/`[`)→ URL(`https?://`)→ GitHub 仓库(`github.com/owner/repo`)→ 其余按 npm 包名处理。

- **npm 包名**(含 `@scope/name@ver`)→ stdio,`npx -y <pkg>`;serverName 从包名推导(去 scope,去 `-mcp`/`-server` 后缀),供用户确认。
- **GitHub 仓库 URL** → 抓 `package.json` 与 README(匿名优先;有 `GITHUB_PERSONAL_ACCESS_TOKEN` 环境变量则带上,但注意环境变量是 harness 进程启动时的快照,可能过期):
  - 有 package.json(bin/main 可判)→ 推导 npm 包走 stdio;
  - README 含远程 MCP 端点(如 `https://.../mcp`)→ streamable-http;
  - 推不出 → 输出条目模板让用户补齐;抓取失败同样降级为模板。
- **其他 HTTP(S) URL** → streamable-http;需鉴权时按 github 行先例:token 存独立文件 + `!!js` 表达式引用,**秘密永不进 yml**。
- **JSON 片段**(Claude Code `mcpServers` 格式 / 单服务器对象 / DSH 行)→ 字段映射:有 `command` → stdio,有 `url` → streamable-http;`env` 透传但**必须检查秘密名清洗规则**:名字匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的 env 变量到不了 stdio 子进程(DSH 行为),解析器要报警并建议改用凭据文件方案。
- 解析结果有歧义(如 GitHub 仓库既像 npm 又像远程)一律停下来问,不猜。

## 5. 错误处理

- 活文件解析失败 → 立即中止且不写;提示可用 `cordis.patch.yml.bak` 恢复。
- 校验失败 → 原样打印验证器输出,候选文件留在原地供检查,线上文件不动。
- 写前核对 mtime:文件被外部改动则重读重做,防覆盖。
- probe 按服务器逐个报因(spawn 失败 / 超时 / HTTP 状态码),单个失败不影响其他服务器。
- DSH 未运行时写操作仍然安全:热加载是 DSH 侧行为,CLI 只保证文件合法。

## 6. 测试策略

- 单测:Node 22 内置 `node:test`,零依赖。覆盖:块边界解析、enable/disable(含原本无 `disabled:` 行的块)、remove(含 insert 数组内行)、add 追加、校验门拒绝坏 YAML、四种输入解析(GitHub 抓取注入 `fetchFn` 模拟)、秘密名 env 报警。
- 真实链路:在 `--file` 指向的临时副本上完整走 add→validate→surgery→probe(选一个已知能起的 stdio 服务器,如 `@modelcontextprotocol/server-everything` 或复用 chrome-devtools 行);最后才对真文件做一次冒烟:`list` + 对 github 行 disable→enable 往返 + `credential github get`(掩码)。
- 探测超时默认 30 秒(`--timeout` 可调,stdio 的 npx 首次拉包耗时在此量级);probe 不写任何文件、不落任何配置,天然幂等。

## 7. 配套技能 `dsh-mcp-manager`

写到 `~/.dsh/skills/dsh-mcp-manager/SKILL.md`(DSH 自动扫描、热生效,零配置)。内容:

- 触发时机:用户要管理 MCP 服务器 / 粘贴项目地址求安装 / 报告 MCP 工具不可用;
- 工作流:`list` 掌握现状 → 对粘贴的地址先 `add`(干跑)把拟写入条目给用户确认 → `add --yes` 落盘 → `probe` 验证 → 以 `mcp__<server>__<tool>` 形式报告可用工具(新工具要对**新会话**才可见,热加载对当前会话的工具清单是否刷新要以实测为准,技能里写明两种情况的话术);
- 踩坑清单:校验先行、秘密名清洗、npx 依赖 cross-spawn、`!!js` 凭据文件模式、headless 实例不继承会话内工具。

这样"复制地址帮你安装"的入口就是对话本身:用户粘贴地址,技能驱动的助手完成解析、确认、安装、验证全流程。

## 8. 范围外(YAGNI)

- 不做 GUI / 网页面板(方案对比中已否掉独立网页与 GUI 内嵌两个形态);
- 只管用户层 `cordis.patch.yml`;profile 层已有的行只展示、不改动;
- 不做相似包推荐、依赖图分析、自动升级;
- 不覆盖 `~/.dsh/profiles/*/cordis.patch.yml`(多 profile 场景后续有需要再加 `--file` 之外的 profile 概念)。

## 9. 关键实现事实备忘(来自踩坑记录)

- `loadOptionalPatches("dsh", path)` 对"存在但解析失败"的文件会 throw → 这正是校验门的意义;
- patch 文件必须是顶层 YAML 数组;裸 `{id,...}` 覆盖先行层,`{insert:[...]}` 无 id 追加;
- 匹配不到行的 patch 条目会被警告并跳过,不致命;
- stdio 子进程 env 中 `/KEY|PASSWORD|SECRET|TOKEN/i` 名字被清洗;stdio spawn 经 cross-spawn(应用 PATHEXT),所以 `command: npx` 在 Windows 可用;
- `!!js` 表达式在配置加载时求值,适合读凭据文件;`process.env` 是进程启动快照,改环境变量需要新进程,改文件 + touch patch 文件即可热生效。
