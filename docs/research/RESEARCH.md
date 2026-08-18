# dsh btw / 临时聊天 生态调研（2026-08-18 快照）

> 调研日期：2026-08-18。dsh 发布不久、生态日更，开工前建议按文末「复查入口」刷新一遍。
> 原始数据在 `raw/`；参考截图在 `../reference/chatgpt-temporary-chat.png`（ChatGPT 临时聊天目标 UI）。

## 结论

生态位**存在且空着**：`右上角入口 → 浮层/全屏临时聊天 → 无父上下文 → cwd 指向当前项目（快速了解项目）→ 关闭即焚 → 不进侧栏历史`。btw 侧问与临时聊天各有零散实现，无一家做全，且无官方 temporary 原语。

## 一、btw 侧问类（10+ 个）

| 插件 | ★ | 安装 | 要点 |
|:---|:--|:--|:---|
| omdsh-dev/dsh-sidechain（原 Buyi-wsgzg） | 10 | `github:Buyi-wsgzg/dsh-sidechain` | 最完整：`/btw` 单发 + `/side` 续聊，fork 临时子会话，右侧面板（思考/工具调用/拖宽/Ctrl+Shift+E），历史持久化。**唯一进 awesome 主列表**。适配公开版 dsh 0.0.1-rc.5 ~ 0.1.0-rc.7。包名 `@dsh-external/dsh-sidechain` v0.6.5 |
| iyllyt/dsh-btw | 6 | 仅 github | Claude Code /btw 忠实复刻：一次性无工具，composer 上方临时面板；三种存档模式（私有 JSONL/仅内存/不保存）；复用父请求共享前缀降缓存成本；可取消。README 设计文档最认真，值得通读 |
| ChenRuoT/dsh-sidebar-qa | 18 | ✅ npm 0.2.0 | 基于 DSH-better-sidebar 的侧栏提问 tab：选中会话文本→右侧问 |
| invalidnaaaame/dsh-side-workspace | 3 | 仅 github | Codex 风 /side + /btw + 右侧工作区。包名 `@dsh-external/dsh-side` |
| AHGGG/dsh-side-chat | 12 | ✅ npm `@ahggg/dsh-side-chat` | 选中文本追问（共享选中内容非全上下文）。锁 rc.6 |
| 其余 | 0-4 | 仅 github | loster12520 / left0ver / cololi（三个同名 dsh-btw）、wensincai/btw4DeepseekHarness、ExElectron/btw-sidekick-plugin、boyun-zhang/better-session-management（会话分叉+btw 只读问答） |

**名字事实**：≥5 个社区仓库的 package.json 都叫 `dsh-btw` 但均未发布；本项目于 2026-08-18 注册并首发 `dsh-btw@0.0.1`（现为 0.0.2）。

## 二、临时聊天类（ChatGPT 式）

| 插件 | ★ | 安装 | 距离目标形态的差距 |
|:---|:--|:--|:---|
| HuiHuitie-zhu/dsh-incognito | 3 | ✅ npm 0.1.0 | 浮窗+即焚+无父上下文，**但 cwd 隔离在专用临时目录 → 读不到当前项目**；入口在输入框加号旁非右上角；重型子 agent |
| Xinyu-lumos/dsh-temporary-chat | 0 | 仅 github | 语义最像 ChatGPT（默认新会话即临时、真不落盘、侧栏隐藏、关/刷即焚），**但 patch 6 个编译产物文件实现**（apiproxy/persistence/connection/runtime/ui-workspace/ui-conversation），锁死 rc.6，升级即碎。08-18 仍在活跃修 |
| ToBeWin/DSH-Temporary-Chat | 1 | 未发 npm | 名为 temporary 实为「免开工作区聊天」，**照常持久化** |
| fsyabc111/dsh-quick-chat | 0 | 仅本地脚本 | 免选工作区直接聊，正式会话进历史。**价值在实现细节**：`conversation.hero.workspace` 是 single 槽，priority -1 阴影渲染接管内置选择器，崩溃自动 retire 回退 |
| Enc-hanted/dsh-quote-temp-ask | 0 | ✅ npm | 选区工具条三按钮之一「临时对话」：右侧 390px 面板，每问独立无状态单轮、250ms 轮询流式、AbortController 可停、清空上下文。**无状态单轮实现可抄** |

## 三、关键源码发现（架构硬约束，决定实现路线）

1. **模块 id = npm 包名（强制）**。`raw/modsys.ts`（packages/client/modules/src/client/system.ts）：浏览器模块图 boot row 的 id 就是包名，bundle 加载后必须以该 id 经 `window.__ModuleLoader__.load({id, factory})` 注册，不符直接报错。→ 设置页显示名完全由包名决定。
2. **显示名剥壳规则**。`raw/inv.tsx`（ui-settings-plugin-inventory）`moduleShortName()`：剥 `@scope/`、`cordis:`、`cordis-plugin-`、`dsh-(host|client)-`，**不剥 `dsh-plugin-`**。→ 命名规则：UI 插件用 `dsh-ui-<短名>` 显示 `ui-<短名>`；功能插件 `dsh-<短名>` 显示短名。（坑例：`dsh-outline` 已被 urzeye 占且同赛道）
3. **无 temporary 原语**。session 模型无 temporary 标志，持久化层无条件写盘（Xinyu-lumos 证实）。官方仓库无相关 issue。→ **别学 patch 路线**，走子 agent/旁路请求才能稳。
4. **稳路线 = fork 子 agent RPC**。incognito：host 端 `/api/fork-incognito/*`（open/send/poll/close），完全绕过主会话与 SessionStore，close 延迟重试删目录+残留清理。
5. **入口 slot 先例**：composer 加号旁（incognito）；选区工具条（quote-temp-ask）；`conversation.hero.workspace` 槽位阴影 priority -1 + 崩溃自动回退（quick-chat）。右上角常驻入口未见先例，需探 `shell.overlay`（outline 已用，order 20）或 header 区域可用槽。
6. **官方发布规范**。`raw/publish.md`：bundle（发 npm）vs profile（用户 boot）；`prepare` 脚本需自包含（pnpm≥10 git 依赖要 approve-builds 白名单）；npm 发布应带预构建 lib/，用户 `dsh plugin --profile web add <pkg>` 即装。我们 zero-build 手维护 lib/ 完全合规。

## 四、实现方案草案（对应 README roadmap）

**0.1.x `/btw` 侧问**（参考 iyllyt + quote-temp-ask）
- host 端：独立一次性 LLM 请求（非子 agent 也行，参考 quote-temp-ask 用注入的 `llm`/`agentDefaultModel` 服务），复用父会话已完成回合为上下文前缀（缓存友好），不写 SessionStore
- client 端：composer 上方临时面板，Markdown 渲染，关闭即弃；可先不做 slash 命令注册，仅面板交互
- 定位：问「刚才说的配置文件叫什么」这类答案已在上下文里的短问题

**0.2.x 临时聊天**（参考 incognito 骨架 + ChatGPT 参考图）
- host 端：`fork-btw/*` RPC（open/send/poll/close），子会话目录 `--btw--`，close 焚毁 + 残留清理
- **cwd = 当前工作区项目根**（incognito 的关键差异点），工具集可先只读（读文件/目录树），后续放开
- client 端：右上角常驻入口（新 slot 或 shell.overlay），打开全屏/大浮层：居中标题「临时聊天」+「不会出现在历史记录中」+ 输入框（照参考图）
- 首条消息可自动拼项目速览（README + 顶层目录树）实现「快速了解项目」

## 五、raw/ 数据说明

| 文件 | 内容 | 快照日 |
|:---|:---|:--|
| topic-repos.json | GitHub topic `dsh-plugin` 按星前 100（共 6832 仓库） | 08-17 |
| awesome-main.md | awesome-dsh-plugin 精选列表全文（1286 条） | 08-18 |
| plugins-all.md | AdamPlatin123/awesome-dsh-plugins 全量索引（7600+ 候选） | 08-18 |
| inv.tsx / modsys.ts | 设置页剥壳逻辑 / 浏览器模块系统源码 | 08-18 |
| publish.md | 官方发布教程 | 08-18 |

未存：dsh 官方仓库 git tree JSON（2.8MB，`gh api repos/deepseek-ai/deepseek-harness/git/trees/master?recursive=1` 可随时重取）。

## 六、复查入口（生态日更，开工前必刷）

1. GitHub topic：`https://github.com/topics/dsh-plugin`（按 Recently updated）
2. awesome-dsh-plugin/awesome-dsh-plugin
3. AdamPlatin123/awesome-dsh-plugins 的 `PLUGINS-ALL.md`
4. `npm search dsh btw` / `npm search dsh temporary`
5. 官方动向：deepseek-ai/deepseek-harness issues 搜 temporary/ephemeral（原语出现则路线 3 失效，全盘简化）

## 附：本次命名迁移记录

- `dsh-plugin-outline` → `dsh-ui-outline@0.2.2`（deprecate 指向新名）
- `dsh-plugin-deepdiving` → `dsh-ui-deepdiving@0.3.2`（同上）
- `dsh-btw@0.0.1` 首发注册（初始骨架，无行为变更；0.0.2 更新项目描述）
- GitHub：iluluyu/dsh-ui-outline、iluluyu/dsh-ui-deepdiving（gh repo rename，旧 URL 自动重定向）、iluluyu/dsh-btw 新建
