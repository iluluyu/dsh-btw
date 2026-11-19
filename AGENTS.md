# BTW 开发与验收规则

## 浏览器端到端验收

- 涉及按需引用、补读、模型流式输出或重试思考时，从 `btw/` 运行相应的真实 DSH Web + Chromium 验收。涉及传输、窗口或会话生命周期的共用改动时，复跑受影响的场景。除端到端外，按改动范围跑自动化回归。
- 验收使用隔离 profile、合成会话、环回本地测试模型。保留用户正在使用的实例与数据；不得为了测试发送真实模型请求、截图真实会话或记录访问凭证。明确要求 Windows 桌面验收时，Web 测试不能替代。
- 子代理交付后，主代理先检查实际差异、数据边界和测试断言，再独立复跑关键验收。只把实际观察到的结果记为通过；截图应能说明对应操作。

| 场景 | 在 `btw/` 运行 | 验收标准 |
|---|---|---|
| 按需引用、不调用补读 | `node scripts/smoke-on-demand-browser.mjs` | 一次模型请求；只收到命中的原文；引用可展开 |
| 模型主动补读 | `node scripts/smoke-on-demand-browser.mjs --supplement` | 首次请求不包含候选邻文；工具只读当前来源固定切点的相邻消息；实际补读标为「补读」，可展开核对 |
| 流式思考滚动 | `node scripts/smoke-on-demand-browser.mjs --scroll` | 顺畅跟随最新；主动向上滚动后位置稳定；回到末尾恢复跟随 |
| 重试思考 | `node scripts/smoke-on-demand-browser.mjs --retry` | 用流内 503 触发模型重试；等待新内容时同一个已展开的思考区保留原文，最终回答后初次思考仍可展开，且不混入正式思考或回答 |

记录实际命令、结果和关键截图到 [docs/verification.md](docs/verification.md)。[补读参考截图](docs/verification/on-demand/supplement.png) 和 [思考重试参考截图](docs/verification/on-demand/retry.png) 均来自隔离的 DSH rc.5 本地测试，仅作后续对照；旧截图不替代本次实测。提供 WSL 预览时，确认现有 loopback 实例加载当前 checkout，核对新链接返回 HTTP 200；只重启已识别的预览服务。
