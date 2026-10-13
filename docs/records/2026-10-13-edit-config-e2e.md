# 编辑已有条目配置 — 实现与实测记录 · 2026-10-13

dsh-mcp-manager **v0.4.0**(本仓库,master)
设计:`docs/specs/2026-10-13-edit-config-design.md`;计划:`docs/plans/2026-10-13-edit-config.md`

## 1. 交付内容

| 面 | 新增能力 |
|---|---|
| 面板 | 每行 **编辑**:原始 YAML 文本框(预填该条目 `config:` 子树)、校验并预览、写入、写入后自动探测、409 冲突重载 |
| Host 工具 | `mcp_manager_update { id, config, confirm, file }`(默认干跑,`confirm:true` 落盘并探测) |
| CLI | `show <id> [--json] [--masked]`、`edit <id> [--config <file>] [--yes]`(不给 `--config` 读 stdin) |

核心:一个条目 **只替换 `config:` 子树**;`- id:` / `name:` / `disabled:` 与条目上方的注释块、其它条目一律逐字节不变。

## 2. 已验证(本机实测)

| 项目 | 结果 |
|---|---|
| 全量单测 `node --test "test/*.test.mjs"` | **159/159 通过**(0.3.0 时 110 条;本次新增 49 条) |
| bundle 合规自检 `checkBundle('.')` | `{ ok: true, errors: [], warnings: [] }` |
| 真实 patch 集成检查(对 `~/.dsh/cordis.patch.yml` 的**副本**,16 项) | **16/16 通过** |
| — 三条真实条目 round-trip(面板视图原样回写) | 与原文**逐字节相同**;github 行 `exprs=1 introduced=0` |
| — 面板视图不含表达式本体 | `Authorization: !!js «0»`,文本中无 `readFileSync` |
| — 带占位符改 github 行 | 表达式原样回填,`introduced=0` |
| — 面板路径注入新 `!!js` | 拒:`js_expression_forbidden` |
| — 硬编码秘密 / 重名 serverName | 拒:`hardcoded_secret` / `duplicate_server_name` |
| — 追加重复 YAML key | 拒:`candidate_invalid`(官方 loader 报 `duplicated mapping key`) |
| — 真实改写 playwright 行 | 写入 + `.bak`;去掉新增行后与原文**逐字节相同**;注释与 github 的 `!!js` 头完好 |
| — `GET /servers` / `POST /update` / 409 | 200 / 200(占位符回填 + 探测 3 工具)/ 409 `file_changed` |
| CLI 对真实 patch(只读) | `list` 三条正常;`show mcp-github` 逐字节输出;`show --masked` 输出 `!!js «0»`;`validate mcp-github` OK |
| 真实 patch 未被改动 | 全部写操作只落在临时副本;运行前后哈希一致 |
| 安装态同步 | 11 个文件(含新增 `lib/update.js`)已复制到 `~/.dsh/profiles/desktop/node_modules/@dsh-contrib/dsh-mcp-manager`,`package.json` = 0.4.0 |
| 技能热生效 | `~/.dsh/skills/dsh-mcp-manager/SKILL.md` 已同步;会话技能目录里 description 立即更新(实测) |

## 3. 过程中发现并修复的**既有**缺陷

1. **`checkSecrets` 三处同时失效**(`lib/rules.js`)——"秘密不得硬编码"这道门实际上形同虚设:
   - `\s*` 跨行:裸 `headers:` 行会把下一行整行吞掉,匹配记在 `headers` 名下(非秘密键),下面的 `Authorization: Bearer …` 被消费后再也不会被检查;
   - `(?!!js)` 是"负向前瞻 `!js`",不是 `!!js`,这道守卫从未生效(此前测试之所以通过,是因为缺陷 1 先把整行吞了);
   - `(\S+)` + 引号反向引用在第一个空格处停下,键字符类又排除 `-`,所以 `Authorization: Bearer ghp_…` 与 `X-Api-Key: …` 两种最常见形态根本匹配不到。
   修复后新增 3 条回归测试(多 token 值、虚线键、跨行吞咽)。**这是本次唯一影响既有安全断言的修复**,建议单独 review。
2. **`ITEM_RE` 行块边界**(`lib/surgery.js`)——行边界曾认"任意缩进的 `- `",因此块式 `args:`(`args:` 换行 + `- -y`)会把行块提前截断,`setDisabled`/`remove`/替换全部错位。现有三条服务器都是流式 `args`,所以从未暴露;编辑功能让块式写法变得触手可及,故必须前置修复。新增回归测试 + fixture `patch-block-args.yml`。
3. `loadPatchText` 的临时文件测试在**全量并行**下会误报(读的是共享 `os.tmpdir()` 列表)——测试侧问题,改用私有 scratch 目录。

## 4. 待验证(需要重启 DSH)

`node_modules` 不在 DSH 的 HMR 监听范围,当前运行的 harness 进程启动于 **15:15:11**,早于本次改动,所以内存里仍是旧代码:

- [ ] 重启后面板出现「编辑」按钮(旧 host 的 `GET /servers` 不带 `configText`,新面板会把它渲染为禁用,属预期);
- [ ] 面板改 `mcp-chrome-devtools` 的 `toolCallTimeoutMs` → 写入 → 探测报工具数;
- [ ] `mcp-github` 的 `Authorization` 在面板里显示为 `!!js «0»`,写入后该行逐字节不变;
- [ ] 新会话里工具数 7 → **8**,`mcp_manager_update` 干跑与 `confirm:true` 实测;
- [ ] 409 冲突路径(面板编辑期间从外部改 patch)。

> 探测路由的存在性无法用 HTTP 状态码判断:`/api` 通道的会话鉴权**先于**路由匹配,不存在的路径同样返回 401(实测 `/api/dsh-mcp-manager/definitely-not-a-route` 也是 401)。重启后请在面板上实测。

## 5. 生效条件与安装态

- 仓库改 → 安装态需**显式复制**。上一次记录(`2026-10-13-tool-schema-503.md` 第 80 行)称安装态是 pnpm 硬链接;本次实测**不成立**:11 个文件全部 `DIFFERS`,因此按文件复制并逐个校验哈希一致。下次改动同样要复制,尤其**新增文件**(`lib/update.js` 在安装态原本不存在)。
- 重启后生效范围:`lib/`、`index.js`、`cli/` 需要重启;`client.js` 先试刷新页面。
- 版本 0.3.0 → **0.4.0**,tag `v0.4.0`。

## 6. 结论

编辑能力在三个面上均已实现,并被 159 条单测与 16 项针对**真实 patch 副本**的集成检查覆盖;写入仍走同一条"候选 → 官方 loader → 语义校验 → 原子写 + `.bak`"管线,面板侧新增的 `!!js` 边界经真实 github 行验证(占位符回填、表达式不可新增/篡改)。附带修好了一处让"秘密不得硬编码"长期失效的既有缺陷。面板与工具的最后一步实测需重启 DSH。
