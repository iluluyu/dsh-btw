# btw 后续工作

当前实现与证据见 [verification.md](verification.md) 顶部：固定面板已迁移到真正的多轮 child/controller，收起不结束聊天；五个客户端 chunk 按首用场景加载，设置已独立为 outline 风格卡片。默认对齐、旧尺寸迁移、原生设置写入和按需搜索均有本轮回归/隔离 UI 证据，不沿用旧单轮/宽度滑杆阶段的结论。

- 本轮已收敛为小窗/侧边栏/全屏，同一聊天只切 UI。支持多个独立 btw；X 结束并清理当前，模式切换保留消息、草稿和选择。右上角“选择消息”主动进入多选，送回草稿不会自动发送。小窗包括主输入框上方的固定 btw 面板及独立浮窗，主要入口不变。固定面板内部滚动，Agent 优先使用 DSH Markdown 正文，不使用用户气泡样式。独立浮窗直接点击聚焦，不再使用编号聊天切换器；通过边缘/角落调整大小，不放宽度滑杆；固定面板与宿主输入框同宽，仅调高度。钉子只控制浮窗移动，浏览器仅按项目记忆数值位置/尺寸。无来源的新建优先经 `/btw nativeOpen` 使用 DSH 原生普通对话页（每次配置解析时合并有效路由，不写原始/持久化配置）：btw 创建独占普通 root Session，用公开 `uiWorkspace.openSession(id)` 打开，原生 composer/`+`/权限与模型选择、思考与消息渲染均由宿主提供，btw 只按 `[data-conversation-session]` 加虚线描边并在右上角提供带对勾的「临时聊天」状态入口；无法安全合并路由或 gate 未绑定时 `nativeOpen` 明确报错拒绝创建，客户端有限重试且不弹错误，不将未成功的普通对话伪装为临时会话，旧 ask/open 协议保留。当前临时模式可先开启、再等待原生工作区选择提交；前台模式、创建 token、后台 owner 回收相互独立，新开启不等待旧清理。拒写门、已有工作区关联/旧独占路径与关闭顺序见 `native-cleanup-algorithms.md`，历史调研见 `native-composer-boundary.md`。
- 模型和上下文选择已复用 dsh 浏览器共享的 `@deepseek-ai/dsh-client-ui-primitives` `Menu`，模块缺失时退回原生 select；上下文和模型选择仍只更新 btw 状态。dsh 0.2.2-rc.1 的业务 `ModelSelect` 未公开导出，其原生席位调用 `session.selectModel` 修改主会话，不能直接用于 btw。界面调整继续对照 `docs/design-acceptance.md`。
- dsh subagent API 的适配与隐私边界见 [subagent-integration.md](subagent-integration.md)：项目内临时聊天已复用公开的委派深度、子会话谱系和权限辅助函数，但不通过会写入主会话的 startActivation 创建；完整 fork/上下文继承机制仍留到下一轮。
- 修 bug 先固定最短复现、核对实际 dsh API、补回归，再修改；避免并行堆功能或重写架构。
- 修改后按改动范围运行检查；完整入口为 `npm run check`、`npm test`、`node scripts/smoke-isolated.mjs`、`node scripts/debug-on-demand-isolated.mjs`。默认使用隔离的本地 adapter，不擅自调用真实供应商模型。
- 会话与删除测试仅使用隔离 HOME/DSH_HOME；不读取真实会话、不输出凭据、不擅自重启服务。
- 是否 push、升版本或发布由用户决定，未明确要求前不执行。
