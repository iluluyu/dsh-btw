# BTW 开发与验收规则

通用版本发布、端到端与截图、隐私卫生、文档按需加载规则，继承工作区 [`../docs/rules/`](../docs/rules/)。

## 按需加载文档（仅在对应场景读取）

| 场景 | 文档 |
|:---|:---|
| 模块边界、生命周期、原生对话复用、按需上下文与 subagent 边界 | [overview.md](docs/architecture/overview.md) |
| 临时聊天存储、JSONL 清理边界 | [storage.md](docs/architecture/storage.md) |
| 原生普通 Session 阅后清理算法与实证 | [cleanup.md](docs/architecture/cleanup.md) |
| Windows 桌面端 `desktop` profile 排查 | [windows.md](docs/guides/windows.md) |
| 历史验证记录与截图留存 | [log.md](docs/verification/log.md) |

## BTW 端到端验收场景

- 涉及按需引用、补读、模型流式输出、重试思考或草稿保留时，从 `btw/` 运行真实 DSH Web + Chromium 验收，并按改动范围跑 `npm run check && npm test`。
- **临时聊天完整端到端**：从界面打开 → 使用原生输入框**实际发送一条合成消息** → 在同一临时会话确认模型回复完整显示且生成结束 → 退出并核对本次会话记录与恢复记录已清理。仅验证开关、填草稿或拦截请求均不算通过。
- Windows 桌面端变动必须在 Windows 桌面应用内完成端到端实测，先核对 `desktop` profile。
- 子代理交付后，主代理先核对实际差异、数据边界与断言，再独立复跑关键验收。

| 场景 | 在 `btw/` 运行 | 验收标准 |
|---|---|---|
| 按需引用、不调用补读 | `node scripts/smoke-on-demand-browser.mjs` | 一次模型请求；只收到命中的原文；引用可展开 |
| 模型主动补读 | `node scripts/smoke-on-demand-browser.mjs --supplement` | 首次请求不包含候选邻文；工具只读当前来源固定切点的相邻消息；实际补读标为「补读」，可展开核对 |
| 流式思考滚动 | `node scripts/smoke-on-demand-browser.mjs --scroll` | 顺畅跟随最新；主动向上滚动后位置稳定；回到末尾恢复跟随 |
| 重试思考 | `node scripts/smoke-on-demand-browser.mjs --retry` | 用流内 503 触发模型重试；等待新内容时同一个已展开的思考区保留原文，最终回答后初次思考仍可展开，且不混入正式思考或回答 |
| 临时聊天草稿 | `node scripts/smoke-on-demand-browser.mjs --native-draft` | 草稿进临时聊天、修改后退出仍在；切换不触发模型；显式发送并收到回复后退出，已发送文字不回填 |

记录实际命令、结果和关键截图到 [log.md](docs/verification/log.md)。[补读参考截图](docs/verification/on-demand/supplement.png) 和 [思考重试参考截图](docs/verification/on-demand/retry.png) 仅作对照，旧截图不替代本次实测。提供 WSL 预览时，确认现有 loopback 实例加载当前 checkout，核对新链接返回 HTTP 200；只重启已识别的预览服务。
