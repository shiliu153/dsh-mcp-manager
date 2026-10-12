# dsh-mcp — DSH MCP 服务器全生命周期管理工具

为 [DeepSeek Harness (DSH)](https://127.0.0.1:19387) 提供的 MCP 服务器管理 CLI,配合一个技能
实现"粘贴项目地址 → 解析 → 确认 → 安装 → 探测验证"的对话式安装体验。

- 设计文档:[docs/specs/2026-10-12-dsh-mcp-manager-design.md](docs/specs/2026-10-12-dsh-mcp-manager-design.md)
- 安装目标:`~/.dsh/port/mcp/`(CLI 本体)+ `~/.dsh/skills/dsh-mcp-manager/`(技能)

状态:设计已确认,尚未开始实现。
