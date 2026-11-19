# PR #1 审查与本地适配

> 本文保留最初兼容修复阶段的历史验证与当时待办，不代表后续功能分支的当前状态。存储实现和风险边界以 [temporary-chat-storage.md](temporary-chat-storage.md) 为准；最终回归记录见 [verification.md](verification.md)。后续已新增模型/上下文、独立临时聊天、侧栏与安全清理，不能用下文旧 smoke 代替当前验收。

## 范围

- PR：https://github.com/iluluyu/dsh-btw/pull/1
- 作者：`setieroth`；提交：`8f863a103ed554e21c1cf53482be097738bf0ae8`。
- 修改三个文件，增加 32 行、删除 18 行；没有自动化检查或测试。
- 本地宿主：`@deepseek-ai/dsh@0.2.2-rc.1`；此前 web profile 仅安装 deepdiving、outline。
- 用户选择：本地适配、补测试、安装验证；不合并、不发布、不 bump。

## PR 改了什么

1. host 不再抢占共享 `/api` interceptor，改为 `connection.rpc.handle("/btw", handler)`；client 同步调用 `/btw`，方法去掉 `btw/` 前缀。
2. client 的 `inject` 移除 `connection`，通过运行时 `ctx.connection` 调用。
3. `shell.overlay` 与其他三个槽位一样走 `slots.inject`，等待布局声明，并统一清理 fiber。
4. PR 将版本升到 `0.0.4`；本地按工作区规则暂不采用该 bump。

## 审查结论

独立通道与延迟槽位方向正确，但 connection 部分不完整，且未覆盖临时聊天的新 API。不能仅凭语法检查认定 PR 可以直接发布。

### 阻塞：独立 RPC 路由的宿主依赖与上下文

实际启动 PR 等效代码时，btw 激活失败：`cannot get property "webServer" without inject`。

本机 `dsh-client-connection/lib/index.js:852–871` 的 `register(owner, ...)` 通过 `owner.webServer.register(route)` 挂载。即使调用方已声明 `webServer`，仍会因 shadow 服务上下文转发报错。已在真实宿主验证：通过 `ctx.extend({ webServer: ctx.webServer }).connection` 固定已注入的服务属性后，独立通道成功挂载且 btw 不再激活失败。该扩展沿用原 fiber 生命周期，不改全局宿主源码。

该独立通道仍走宿主 `admit()`，保留 Host/Origin 检查与身份认证；不是裸 HTTP 路由。

### 阻塞：移除 client 注入后仍直接读取 ctx.connection

PR 的“connection 不是服务，只是始终存在的属性”解释不符合本机运行时：`dsh-client-connection/lib/client.browser.js:1497` 明确调用 `ctx.provide("connection", handle)`。移除 inject 后 UI 能启动，但点击临时聊天时 `ctx.connection` 抛出 `cannot get property "connection" without inject`，界面卡在“正在开启”。

本地保留仅依赖 slots 的延迟启动方式，改为请求时 `ctx.get("connection")` 查找；`rpc()` 改为 async，确保未就绪或查找异常转换为 Promise rejection，交给现有错误 UI，而非同步抛出后卡住。测试的 connection 属性读取固定抛错，确保不会退回这一坏路径。

### 阻塞：临时聊天依赖旧版安装树

旧实现把工具包解析固定到 `$DSH_HOME/profiles/node_modules`。本机其中的链接指向已移除的 Node 安装，不能作为当前运行时的工具来源。

实际验证发现，链接到工作区的插件连裸 `import(name)` 也无法解析内置工具包。最终从注入的 `profileContext.installAnchor` 创建 require，resolve 后按 file URL 导入；安装锚点由当前宿主提供，不硬编码 Node 版本、profile 名或全局路径，不修改旧链接或额外全局安装工具包。

### 阻塞：子 agent 的 setup 参数已变化

旧代码读取 `childCtx.agent.session`；当前 setup scope 没有可读的 agent 服务。`dsh-agent-loop/lib/index.js:1574` 调用 `setup(agent.ctx, agent)`。本地改为接收第二个 child 参数并写入其 session 的审批策略，避免启动临时聊天时报 `cannot get property "agent" without inject`。测试现在实际调用 setup，通过模拟安装树验证六个工具/提示包解析与审批策略写入。

### 阻塞：会话事件与流式协议已迁移

真实 open/close 成功后，poll 又暴露 `events is not iterable`：当前 Session 不再公开 `.events`，且文本增量不再以持久化 `assistant/chunk` 事件出现。

本地改为在 setup 中订阅 `agent/assistant-stream` 的 text-delta，以及 `session/event` 的最终 assistant/message；按子 agent 身份过滤，poll 使用内存 chunk 游标，不读取已废弃的同步 session snapshot API。测试覆盖新事件帧、其他 agent 过滤、最终输出与增量游标。

### 阻塞：当前项目目录的前端取值已变化

旧临时聊天入口读取 `useSessions` store 的 `current` 字段；当前会话作用域直接提供 `props.sessionId`，不能假设 store 包含 current。旧路径会静默退回用户 home，违背“当前项目”约定。本地改为按 `props.sessionId` 查询 `byId`；测试数据不再提供 current，以锁定这个回归。

## 本地改动

- 采用 PR 三处兼容性修复，移除废弃的 RPC_PREFIX 和 intercept 命名。
- 补充宿主 webServer 依赖，并固定路由所需的上下文属性；client 改为 ctx.get 延迟查找 connection。
- 临时聊天工具从活动安装锚点解析，setup 使用显式 child 参数；适配新流式事件和当前项目目录取值。
- 增加 `test/compat.test.js` 和 `npm test`，不引入测试依赖。
- 更新中英文 README 与过时的 cordis.yml 注释。
- 版本仍为 `0.0.3`；npm 上同号的发布包不含这些本地修复。

## 自动化验证

`npm run check`、`npm test`、`git diff --check`。

9 项测试：独立 RPC 注册/卸载、裸方法分发、侧问流式轮询与上下文裁剪、取消/卸载中止请求、缺失默认模型、临时聊天 open/send/poll/close、四个槽位延迟挂载与清理、client 侧问提交/轮询，以及连接未就绪时激活。

测试使用临时 DSH_HOME、模拟安装树与模拟模型，不读取真实 marker、不调用付费模型。单元测试验证路由与 setup，真实工具组合的创建/销毁另有本机 smoke test；真实模型输出与工具执行未验证。

## 安装与界面验证

已执行 `dsh plugin --profile web add .`，web profile 新增本地 `dsh-btw` link；原有 deepdiving、outline 保留。

实际验证通过：

- 宿主不再报告 btw 激活失败；前端按钮和侧问面板正常挂载。
- `/btw 本地兼容性验证，不发送` 自动迁移到侧问输入框且主输入框清空。
- 认证浏览器的 `/btw/open`、`poll`、`close` 均成功；轮询空会话返回 `{text:"",lastSeq:0}`。
- 点击已有会话的临时聊天入口后，浮层进入 active 状态，输入框可用；marker 的 cwd 为当前项目目录，不再退回 home。
- 按 Esc 后浮层消失，marker 清空；先前确实存在的子会话目录已删除。
- `/api/settings/describe` 返回成功；未认证请求访问 `/api` 和 `/btw` 均为 HTTP 401。
- 先前失败版本的浏览器错误记录仍保留旧 origin 的堆栈，最终版本未新增同类异常；没有提交真实模型请求。

验证服务随后关闭，本地插件 link 保留。再次使用运行 `dsh web` 即可。

`npm pack --dry-run --json` 确认 docs、test、CI 配置不进入 npm 包。

## 后续增强（不混入本次兼容修复）

- 明确临时聊天权限边界：当前挂载 bash/fs 工具，persona 的“倾向只读”不是硬权限隔离；“不留痕”只针对会话目录，不代表工具不可能留下外部影响。
- 清理成功请求遗留的 send 超时计时器，以及 askCancel/卸载时的计时器。
- 对客户端轮询与关闭/重新打开过程增加竞态测试，避免迟到响应重新打开状态或继续轮询。
- 临时会话销毁考虑延迟持久化重建目录，以及多宿主 marker 并发写入。
- 已补 CI 配置，在 Node 24/26 上跑 check/test；尚未推送执行。发布前补真实模型 smoke test 和桌面版回归。
- 兼容性修复与这些小修整合后发 patch，预计 `0.0.4`，无需 minor；发布前重新检查 npm 版本占用。
