# dsh-mcp-manager — 编辑已有条目的配置 · 设计文档

日期:2026-10-13
状态:设计经用户逐节确认(三个决策点均由用户选择);本文件为实施依据
目标仓库:`https://github.com/shiliu153/dsh-mcp-manager`(master,基线 commit `379c1bf` "chore: 0.3.0")
目标版本:0.3.0 → **0.4.0**(新功能)

## 0. 背景与缺口

用户诉求原话:"我的 mcp 插件没有修改配置的选项呢"。

核实结果:该观察成立,且是刻意设计,不是缺陷遗漏。

| 入口 | 现有能力 | 编辑已有条目的配置 |
|---|---|---|
| 面板(`client.js`,Plugins → DSH MCP manager) | 状态点、单条探测、一键探测、启停开关、删除、新增(解析→预览→写入) | **无** |
| Host 工具(`lib/tools-bridge.js`,7 个) | list / probe / add / remove / toggle / credential / validate | **无**(没有 update) |
| CLI(`cli/mcp.js`) | list / probe / add / enable / disable / remove / credential / validate / schema | **无** |

证据:`README.md` 第 76-77 行 *"The panel deliberately does **not** edit arbitrary config fields or rotate credentials — those stay in the CLI and the agent tools."*;而 CLI 侧同样没有 edit。缺口代价:要改一个已有条目的 `args` / `toolCallTimeoutMs` / `url` / `headers`,只能 ① `remove` + `add`(丢失条目内与条目上方的注释、丢 `!!js` 头),或 ② 手工编辑 `~/.dsh/cordis.patch.yml`(绕过全部校验门与 `.bak` 保护)。

本设计补上"编辑",并保持既有安全姿态:所有写入仍走同一条**候选副本 → 官方 loader 校验 → 原子写 + `.bak`** 管线。

## 1. 决策记录(用户已确认)

### D1 编辑方式 = 原始 YAML 文本编辑

面板与工具/CLI 的编辑面都是**该条目 config 子树的原始 YAML 文本**,不是字段表单。

依据(硬约束):解析后的条目**无法原样还原 `!!js`**。DSH loader 把 `!!js` 解析成惰性对象 `{__jsExpr}`(`app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js` 第 20-26 行的 `JsExpr` 类型、第 2238 行 *"Inert representation of a YAML !!js scalar … Its result is evaluated and validated only at runtime"*),而 `lib/patchfile.js` 的 `renderConfig`/`yamlScalar` 只认**字符串**形式的 `!!js`。因此"读成对象 → 重新渲染整段"的表单方案会**毁掉 `mcp-github` 的 `Authorization` 头**及条目内注释。文本级手术是唯一能保真的路径。

被否方案:字段表单(毁 `!!js`)、表单 + 高级文本双编辑面(两个真相源,工作量翻倍)。

### D2 编辑区 = 条目的 `config` 子树

| 字段 | 可编辑性 |
|---|---|
| `- id:` | 只读(它是 `toggle`/`remove`/`probe`/`update` 的键,改了会漂移) |
| `name:` | 只读(恒为 `@deepseek-ai/dsh-mcp-client`;非 mcp-client 行不出现在列表里) |
| `disabled:` | 只读(面板已有开关,避免双真相源) |
| `config:` 之后到条目末的全部行 | **可编辑**:`serverName` / `transport` / `command` / `args` / `url` / `headers` / `env` / `toolCallTimeoutMs` / `failOnStartupError` / `reconnect` / `cwd` 等 |

被否方案:整条替换(能改坏 `id`/`name`);字段级手术(嵌套 `headers`/`env` 做不动,零依赖下需自写 YAML 定位,能力反而最小)。

### D3 `!!js` 边界 = 面板禁止新增或篡改,但保留原值

面板编辑区里**已存在**的 `!!js` 表达式显示为不可编辑占位符,提交时由**服务端**原样回填;面板无法引入该条目原本没有的表达式。CLI 与 Host 工具**不设此限制**(与手工编辑 patch 同权,属可信本地上下文),但会如实回报改动引入的表达式数量。

依据:`!!js` 的结果"只在运行时被求值",而求值者是 harness 进程内的 Loader —— 即写入一条新表达式等价于**在宿主进程里执行任意 JS**。现有面板刻意只走结构化 `add`(`lib/resolve.js` 从不产出 `!!js`),故其最坏影响是"加一个 MCP 服务器";开放原始文本编辑后若不设限,任何浏览器侧 XSS/CSRF 都会升级为宿主代码执行。

被否方案:完全允许(把面板变成 RCE 面)、彻底禁止(含 `!!js` 的条目在面板里不可编辑,`mcp-github` 直接失去面板编辑能力)。

## 2. 组件与接口

单一实现原则(沿用 `lib/rows.js` 的注释约定):策略集中在**一个**新模块,三个入口只做适配。

| 文件 | 改动 |
|---|---|
| `lib/surgery.js` | 新增 `readConfigBlock` / `replaceConfigBlock`;修 `ITEM_RE` 行块边界缺陷(§3.4) |
| `lib/update.js` | **新增**:编辑策略编排(读 → 归一化 → `!!js` 令牌回填 → 四道校验 → 候选文本),面板/工具/CLI 共用 |
| `lib/patchfile.js` | `doSurgery` 增加 `replaceConfig` 操作;`applySurgeryAsync` 增加可选 `preCommit` 语义校验钩子 |
| `lib/server.js` | 新增 `POST /api/dsh-mcp-manager/update`;`GET /servers` 每行增加编辑相关字段 |
| `lib/tools-bridge.js` | 新增 `mcp_manager_update` |
| `cli/mcp.js` | 新增 `show <id>` 与 `edit <id>` |
| `client.js` | 每行「编辑」按钮 + 编辑区 + 占位符处理 + 冲突重载 |
| `index.js` | 不改 |

### 2.1 `lib/surgery.js`

```js
/** 读一条目 config 子树的原文。返回 undefined 表示该 id 不存在。 */
export function readConfigBlock(text, id) → {
  kind: 'block' | 'flow' | 'absent',   // 块式 config / 行内 flow 式 / 无 config 行
  indent: number,                       // config 子树的缩进空格数(块式 = config: 行缩进 + 2)
  configText: string,                   // 块式:子树各行(已去公共缩进);flow: 行内值;absent: ''
  startLine: number, endLine: number,   // 子树在文件中的行区间(用于替换)
}

/** 用 fragment 替换该条目的 config 子树。id 不存在时抛 `entry not found: <id>`。 */
export function replaceConfigBlock(text, id, fragment) → string
```

### 2.2 `lib/update.js`(新)

```js
/**
 * 干跑:归一化 fragment、回填 !!js 令牌、跑四道校验,返回拟写入的候选全文。
 * 不触盘(仅读原文件)。errors 非空时 candidate 为 undefined。
 */
export async function prepareUpdate({ file, id, fragment, allowJsExpr = false }) → {
  ok: boolean,
  errors: string[], warnings: string[],
  normalized: string,      // 归一化 + 回填后的子树文本(展示用)
  candidate: string,       // 完整候选文件文本
  jsExprCount: number,     // 改动后该条目含有的 !!js 表达式数量
  introducedJsExpr: number,// 改动引入的、原本不存在的表达式数量
}

/** 落盘:内部复用 prepareUpdate 构造候选,再经 patchfile 的校验门与原子写落盘。
 *  expectMtime 不匹配时抛 FileChangedExternally。 */
export async function applyUpdate({ file, id, fragment, allowJsExpr = false, expectMtime }) → {
  applied: true, backupPath: string, jsExprCount: number, introducedJsExpr: number,
}

/** GET /servers 用:把子树原文转成面板可安全展示的形式。 */
export function toPanelView(configText) → {
  configText: string,        // !!js 值 → `!!js «k»`;硬编码秘密值 → `B*****`
  jsExprs: string[],         // 每个令牌的人类可读描述,如 `credential file: C:/…/github-mcp-token.txt`
  editable: boolean,         // 含硬编码秘密时为 false
  reason: string,            // editable=false 的原因(否则 '')
}
```

### 2.3 `lib/patchfile.js`

```js
case 'replaceConfig': return replaceConfigBlock(text, operation.id, operation.fragment);
```

`applySurgeryAsync` 增加可选 `preCommit: async (candidateText) => void`,在 loader 校验通过后、`commit` 之前调用;抛错即中止且候选留在 `.candidate`。`lib/update.js` 用它挂载语义校验(§5),避免把策略下沉进写门。

## 3. 手术规则

### 3.1 缩进归一化

fragment 先按行拆分,去掉非空行的**最小公共前导空白**,再按 `indent` 重新缩进;空行保持空行。面板预填的就是当前子树原文(已去公共缩进),因此"原样提交"必然产出与原文件逐字节相同的子树——这是可回归的强不变式(测试断言)。

### 3.2 三种 config 形态

| kind | 触发 | 替换方式 |
|---|---|---|
| `block` | `^(\s*)config:\s*$` | 用 fragment 各行替换该行之后的子树行 |
| `flow` | `^(\s*)config:\s*(\S.*)$` | fragment 必须**单行**,替换行内值;多行 → 400 `flow_config_single_line` |
| `absent` | 条目内无 `config:` 行 | 在条目首行(`- id:` 行)之后插入 `config:` 行 + fragment;若紧随其后有 `name:` / `disabled:` 行则插在这些行之后。`indent` = `- id:` 行缩进 + 2 |

### 3.3 保留边界

条目**上方**的注释块与 `- id:` / `name:` / `disabled:` 行永不改动;同文件其他条目逐字节不变(测试断言:替换前后对非目标行区间做全等比较)。fragment 内部的注释由用户自己维护(他看得见原文)。

### 3.4 前置修复:`ITEM_RE` 行块边界(必须)

现状 `lib/surgery.js` 第 6 行 `const ITEM_RE = /^(\s+)- /` 把**任意**缩进的 `- ` 都当作 insert 数组的行边界。今天三条服务器都用流式 `args: ['-y', …]` 才没暴露;一旦有人在编辑框里写块式序列:

```yaml
      args:
        - -y
        - chrome-devtools-mcp@1.6.0
```

第 2 行就会被误判为新的 insert 行,`findRow` 返回的行块在第 1 行处被截断 → `setDisabled` / `remove` / `replaceConfig` 全部错位(错位内容会写进活文件,`.bak` 只能事后补救)。

修法:行边界只认**与 `- id:` 同缩进**的 item 标记。即 `parseTopBlocks` 先记录该 insert 块首个 `- id:` 行的缩进 `n`,此后只有 `^ {n}- ` 才算新行,其余(更深缩进)一律视为当前行内容。回归测试:块式 `args` 的条目,`findRow` 的行块必须覆盖到下一个同缩进行。

## 4. `!!js` 占位符协议

令牌形式:`!!js «k»`(`k` 为十进制序号,`«»` 为 U+00AB/U+00BB,不会出现在 YAML 标量或 JS 表达式里)。

写入方向(`prepareUpdate`,服务端权威):

1. 读当前子树原文,按出现顺序抽取全部 `!!js` 表达式 → `exprs[0..n-1]`。
2. 若 `allowJsExpr === false`(面板路径),提交文本里每个 `!!js` 必须匹配 `^!!js «(\d+)»$` 且 `k < n`;否则 400 `js_expression_forbidden`。合法令牌替换回 `exprs[k]`。
3. 若 `allowJsExpr === true`(CLI/工具路径),令牌照旧回填,同时允许任意 `!!js` 原文;`introducedJsExpr` = 改动后**原本不存在的**表达式数量(即"新代码"的条数,不是净增减:把一条表达式换成另一条净变化为零,却同样是把新代码交给 Loader 执行),回报给调用方。

**安全不变式**(测试断言):`allowJsExpr=false` 时,`prepareUpdate` 产出的候选文本中出现的 `!!js` 表达式集合 ⊆ 该条目原有的表达式集合。伪造/重排/重复令牌只会复用同一行已有的表达式,不产生新能力。

## 5. 校验门(四道 + 防覆盖)

在既有 `applySurgeryAsync`(候选 → `.candidate` → `loadOptionalPatches` 解析 → `.bak` + tmp + rename + 双次 mtime 复核)之外,`preCommit` 增加:

1. **官方规则**:用 loader 解析候选,按 id 取回条目,跑 `lib/rules.js` 的 `validateEntry(config)`(serverName 字符集、transport 枚举、stdio 必 `command` / http 必 `url`、`toolCallTimeoutMs` 正数、`reconnect` 范围)。失败 → 拒绝,错误逐条返回。
2. **硬编码秘密**:对 fragment 原文跑 `checkSecrets`(密钥名且值非 `!!js`)。命中 → 拒绝,提示改用凭据文件 + `!!js`(与 `add` 路径的既有行为一致)。
3. **serverName 唯一**:候选文件内所有 mcp-client 行的 `serverName` 不得重复(官方 loader 遇重名会令后者加载失败)。

第四道——**表达式边界**——不在 `preCommit` 里:它必须在候选文本被构造**之前**就成立,由 §4 的令牌解析强制执行(`allowJsExpr=false` 时拒绝任何非令牌 `!!js`)。`preCommit` 只承担"候选已成文之后才能做的"三项语义校验。

**防覆盖**:面板是"读—改—写"且中间可能隔数分钟,`GET /servers` 因此返回 `mtimeMs`,面板提交时带回 `expectMtime`;不匹配 → HTTP 409 `file_changed`,面板提示"文件已被外部修改,重新加载"。CLI/工具每次调用即时读盘,不需要该参数。

## 6. 三个入口的行为

### 6.1 面板(`client.js`)

- 每行新增「编辑」按钮(与「探测」「删除」同一动作组)。点开 → 该行下方展开编辑区:textarea 预填 `configText`,下方显示 `jsExprs` 占位符说明。
- 按钮:「校验并预览」(`confirm:false`,展示 `errors`/`warnings`/归一化结果)、「写入」(`confirm:true`)、「取消」。
- 写入成功后:清空编辑区 → 重新 `load()` → 自动对该行跑一次既有 `runProbe`,直接显示工具数或失败因。
- 409 冲突:显示提示与「重新加载」按钮,不覆盖用户正在编辑的文本。
- `editable:false` 的行:编辑按钮禁用,`title` 显示 `reason`。

### 6.2 Host 工具 `mcp_manager_update`

```
参数: { id: string(必填), config: string(必填,config 子树 YAML 文本),
        confirm: boolean(默认 false), file: string(可选) }
```

- 默认干跑:返回归一化文本 + 校验错误/警告 + `introducedJsExpr` 提示;`confirm:true` 才落盘并随后探测一次。
- `allowJsExpr` 恒为 `true`(可信上下文),但输出明确写出"本次引入 N 个 `!!js` 表达式"。
- 参数 schema 必须过 `test/tool-schema.test.mjs` 的结构守卫:枚举用 `enum`,**禁止**把 `oneOf`/`anyOf`/`allOf` 当枚举用(v0.1.0 那次 503 的根因)。

### 6.3 CLI

```sh
node cli/mcp.js show <id> [--json]              # 打印当前子树原文(逐字节,不掩码:它是本机可信面)
node cli/mcp.js edit <id> [--config <file>] [--yes]   # 不给 --config 时从 stdin 读
```

- `edit` 默认干跑预览,`--yes` 落盘;`allowJsExpr` 为 `true`。
- `show` 默认**不掩码**:掩码值若被回填会静默写坏配置。需要展示掩码时用 `--masked`。
- 用法串、`usage()` 与 README 的 CLI 表同步更新。

## 7. 错误与状态码

| 场景 | 面板路由 | 工具/CLI 文本 |
|---|---|---|
| id 不存在 | 404 `not_found` | `entry not found: <id>` |
| config 缺失/类型错 | 400 `bad_request` | 同左 |
| flow 式 config 收到多行 | 400 `flow_config_single_line` | 同左 |
| 面板提交含非令牌 `!!js` | 400 `js_expression_forbidden` | 不适用(工具/CLI 允许) |
| `validateEntry` 失败 | 400 `rules_failed`(带 `errors[]`) | `FAIL:` + 逐条 |
| 硬编码秘密 | 400 `hardcoded_secret` | 同左 |
| serverName 重复 | 400 `duplicate_server_name` | 同左 |
| YAML 候选非法 | 400 `candidate_invalid`(候选留在 `.candidate`) | 同左 |
| 文件被外部改动 | 409 `file_changed` | `FileChangedExternally: …` |

## 8. 测试矩阵(`node:test`,零依赖,不写真实 `~/.dsh/cordis.patch.yml`)

| 文件 | 新增用例 |
|---|---|
| `test/surgery.test.mjs` | 子树替换保留上方注释/其他条目/`id`/`name`/`disabled`;CRLF 归一化;缩进归一化(含空行、深缩进粘贴);`flow` 单行替换;`absent` 时插入 `config:`;id 不存在抛错;**块式 `args` 行块边界回归** |
| `test/update.test.mjs`(新) | 原样提交产出逐字节相同的子树(强不变式);`!!js` 令牌回填;伪造令牌越界 `k>=n` 被拒;非令牌 `!!js` 在 `allowJsExpr=false` 被拒、`=true` 放行且 `introducedJsExpr` 正确;`validateEntry` 失败;硬编码秘密被拒;serverName 重复被拒;`toPanelView` 的占位符与 `editable:false` |
| `test/patchfile.test.mjs` | `replaceConfig` 操作走通;`preCommit` 抛错时候选留在 `.candidate`、活文件未动;`.bak` 生成;mtime 冲突被拦 |
| `test/server.test.mjs` | `/update` 干跑/落盘/四类错误码/409;`/servers` 新字段(`configText`/`jsExprs`/`editable`/`mtimeMs`) |
| `test/client.test.mjs` | `__test` 新增纯函数:占位符识别、归一化、新 `!!js` 检测 |
| `test/tool-schema.test.mjs` | 新工具纳入既有结构守卫;定点断言 `mcp_manager_update` 的 schema |
| `test/cli.test.mjs` | `show` 逐字节输出;`edit` 干跑/`--yes`/stdin;`--masked` |
| `test/plugin-tools.test.mjs` | 工具数 7 → 8;`mcp_manager_update` 干跑与落盘 |

## 9. 生效路径与发布

1. 仓库改 → `node --test "test/*.test.mjs"` 全绿 → `checkBundle('.')` ok。
2. 同步安装态 `~/.dsh/profiles/desktop/node_modules/@dsh-contrib/dsh-mcp-manager`(该目录为 pnpm 硬链接;`docs/records/2026-10-13-tool-schema-503.md` 第 80 行记载)。
3. **`lib/`、`index.js`、`cli/` 的改动需重启 DSH**(`node_modules` 不在 HMR 监听范围);`client.js` 先试刷新页面,不生效则同样重启。
4. 重启后实测:面板出现「编辑」→ 改 `mcp-chrome-devtools` 的 `toolCallTimeoutMs` → 写入 → 探测成功;`mcp-github` 的 `Authorization` 头在面板里显示为占位符且写入后**逐字节不变**。
5. 版本号 0.3.0 → 0.4.0;README 的"面板刻意不编辑配置"段落改写、工具表与 CLI 表补齐;`assets/skills/dsh-mcp-manager/SKILL.md` 与 `~/.dsh/skills/dsh-mcp-manager/SKILL.md` 同步新增 update/edit 流程;`docs/records/2026-10-13-edit-config-e2e.md` 记录实测结果。
6. 按仓库惯例逐个任务提交(英文 conventional commits),最后 `git tag v0.4.0` 并推送。

## 10. 范围外(YAGNI)

不做字段表单;不做 diff 算法(干跑返回归一化文本,调用方自己比对);不改 `id` / `name` / `disabled`;不编辑 profile 层或 `--patch` 层文件(仍是单一 home 层);不做编辑历史/回滚 UI(`.bak` 已足够);不做面板内凭据轮换(仍在 CLI/工具);不做多条目批量编辑。

## 11. 官方依据(本轮新查)

- `!!js` 惰性语义与运行时求值:`app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js` 第 20-26 行(`JsExpr` 类型,`construct: (data) => ({ __jsExpr: data })`)、第 2236-2238 行(JSON Schema 描述:*"Inert representation of a YAML !!js scalar from the Cordis entry-list parser. Its result is evaluated and validated only at runtime."*)。
- 字段契约与秘密不进 patch:`docs/official/dsh__node_modules__@deepseek-ai__dsh-mcp-client__README.md`(既有 `lib/rules.js` 的来源)。
- 工具定义契约与 schema 陷阱:`docs/records/2026-10-13-tool-schema-503.md`。
- patch 组合顺序与 home 层定位:`docs/specs/2026-10-12-dsh-mcp-manager-design.md` §2。
