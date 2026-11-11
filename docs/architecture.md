# btw 架构

零 build：入口和首用模块均直接交付 `window.__ModuleLoader__.load`，不引入构建器、框架或状态机依赖。使用宿主公开 `require.async('./client.<name>.js')` 协议按需加载自包含 sibling chunk；没有同步跨 chunk require。

## 文件边界与加载

- `lib/client.js`：轻量入口、来源/斜杠指令桥、聊天 registry 和首用加载任务；不把视图当成资源所有者。
- `lib/client.controllers.js`：每条聊天的连接、代次、发送/轮询和关闭屏障。
- `lib/client.geometry.js`：尺寸与边缘计算、视口限制和仅数值的几何记忆。
- `lib/client.messages.js`：共享用户气泡与 Agent Markdown/纯文本展示。
- `lib/client.views.js`：固定面板、浮窗、侧栏、全屏；公开原生按钮/图标/tooltip 与共享选择器的适配。
- `lib/client.settings.js`：outline 风格的分组设置行，通过注入的 form-scope 保存器和共享选择器工作。

未使用时不加载功能 chunk，也不请求 btw 模型目录；首次聊天 UI 并行加载 controller/geometry/messages/views 四个 chunk，设置卡另在首次访问设置时加载。两条加载任务各自去重、可重试并在卸载时 fencing，晚到结果不能注入 CSS 或重新激活插件。npm `files: ["lib", ...]` 包含所有 sibling；`npm run check` 覆盖各文件。DSH 的不可变 sibling URL 使用入口 `client.js` 的 revision；修改任一 sibling 时必须同步更新该入口注释中的 SHA-256，测试会检查全部签名，避免重启后浏览器继续使用旧 chunk。原生 `PanelChrome` 等私有组件不直接导入，公开组件缺失时保留安全退化。

## 职责

- **客户端视图**：`btw` 按钮打开的 composer 上方固定面板是主要小窗入口，独立浮窗是内容的另一形态。固定面板、页面、浮窗和侧栏只负责展示与调用动作；用户气泡与 Agent 正文使用共享消息展示规则，Agent 优先复用公开 `MarkdownText`，缺失时安全显示纯文本。展示容器只决定位置，不拥有会话资源。窗口尺寸属于展示偏好，不改变上下文范围；小窗由边缘和四角缩放，侧栏交给宿主尺寸控制，全屏填满宿主可用区域，不提供宽度滑杆。只提供三种模式：小窗（`overlay`）、侧边栏（`sidebar`）、全屏（`global`），通过原生风格的模式图标按钮互相切换。
- **聊天管理**：本地 registry 维护多个独立 btw 和焦点顺序；多个小窗可同时显示，点击窗口聚焦/置前，不要求用户选择编号聊天。新建与按来源聚焦已有 live 聊天是不同动作，不向用户提供恢复历史的流程。每条聊天有自己的草稿、消息、来源、模型和上下文选择；关闭只结束目标聊天，切换模式不结束聊天。小窗默认固定，用钉子切换可拖动状态；位置、宽度和高度仅按项目作为数值保存在浏览器，不保存正文、草稿或上下文。
- **传输与生命周期**：首次发送才创建宿主子会话，单轮串行轮询；每条聊天独立持有创建连接、开启 attempt、轮次 fence、计时器和关闭屏障。显式结束走目标聊天的关闭屏障，插件卸载对全部聊天执行清理。
- **宿主 `lib/index.js`**：模型解析、子 agent、发送截止时间、持久化恢复记录和安全删除；显式路由启用时另有 `nativeOpen`/`nativeClose`——创建前拒写墓碑、已有或独占 workspace 关联与关闭屏障，实现于 `lib/native-cache.js`（gate backend）与 `lib/native-cache-workspaces.js`。保持既有清理屏障与真实宿主适配，不由 UI 删除文件。
- **固定面板**：与其余形态共享同一个 controller 和 child；第二问只发送新问题，历史由独立 DSH child 保留，不重放手工拼接的问答。默认高 200px、宽度始终与宿主 composer 外框对齐，仅可调整高度；`/dock-v3` 只保存手动高度并忽略旧版宽度与旧默认，不删除旧数据或改变浮窗几何。收到首个有效回复后折叠编辑区，圆形箭头可继续输入，草稿保留。消息独立滚动，输入区保持可见。来源参考不显示为 btw 消息，也不等于 fork：recent 取稳定的已完成 `legacy.nodes`；all 走官方 `session.events` 固定 cursor 分页和有界缓存；on-demand 搜索最多 48k 的授权尾部快照。容量由宿主 `resolveModelInfo` 查询。

项目会话标题栏的 btw 优先打开原生侧栏；侧栏服务不可用时退回小窗。无来源新对话入口优先经 `/btw nativeOpen` 使用 DSH 原生普通对话页：btw 启动时自动把 `routes.session_projcache` 指向 `btw-native-json`（配置解析时只合并有效配置，不改原始/持久化配置），随后创建独占普通 root Session 并用公开 `uiWorkspace.openSession(id)` 打开；原生 composer、`+`、权限/模型选择、思考与消息渲染全部由宿主提供，btw 只按 `[data-conversation-session="<owned id>"]` 作用域给 composer 卡与用户气泡加虚线描边，并在全局入口提供「结束临时聊天」（原生 hero 页不渲染 header utilities）。自动路由被用户自定义配置挡住或 gate 未绑定时 `nativeOpen` 仍拒绝不安全创建；客户端有限重试后退出未成功的模式，诊断留在后台而非聊天弹层，不把普通对话伪装成临时会话，旧 ask/open 协议独立保留；拒写门、原生工作区选择接续（旧独占 API 仅兼容/恢复保留）与关闭顺序详见 `native-cleanup-algorithms.md` 与 `temporary-chat-storage.md`。打开侧栏初期仅做一次有界的默认页竞态修正，用户主动操作后取消，不持续抢占其他标签。固定面板的全屏安全绑定来源会话的 DSH 原生侧栏 tab，用户退出原生全屏时返回原固定面板。侧栏不显示 btw 自己的模式选择或最小化按钮，侧栏中新建仍留在侧栏。关闭 btw 结束并清理该聊天；只有该 tab 时收起侧栏，不隐藏其他 tab。浮窗和固定面板的收起行为不变。

## 临时状态与所有权

`idle → configuring → opening → active → closing → idle`。首发开启失败回到配置并显示错误；清理失败进入 `error`，保留子会话 ID 供重试。模式切换只改变展示，不结束对话；关闭/X 才结束当前聊天；收起仅回到原 btw 按钮，聊天与草稿保留。模式迁移或结束会移除旧的本插件侧栏标签，不显示空标签和“恢复临时聊天”组件。

child 流程的全局新建不带 cwd/父会话，强制无父上下文；原生 UI 入口按宿主 New Session 规则选择当前或最近的已有工作区，空白桌面页也可继承；Web 没有可用工作区时保留已选临时模式，等待宿主工作区选择提交后继续，不弹错误、不自动创建 btw 分组，同样无父会话。底层旧 `{}` API 的独占目录恢复路径仅为兼容保留，不再是当前 UI 的默认行为。模型菜单只显示一个「默认」：有来源时请求 `current`，无来源时请求 `host`；自选仍请求明确模型，不修改主会话模型。旧配置 `host/current` 在 UI 中都归为默认。继承的来源文本只作为请求参考，不插入 btw 消息列表；界面只显示这条 btw 自身的问答。

- 每条聊天的代次隔离开启/结束/卸载，轮次标识隔离每轮回复；旧回包只能回到原聊天，不能写入新聊天或当前切换后的聊天。
- 开启 attempt 持有原连接、上下文取消器、open promise 和子会话 ID；send/poll/close 始终使用这个连接。迟到 open 先交回 ID，再由同一 close 屏障释放，不另开清理支路。
- 单轮最多一个 poll 在途；最终 poll 等待旧 poll。完成/退出清除 timer；退出中重复请求共用 `closingTemp`。卸载先对所有 controller 启动该屏障，再释放 UI 服务并清空活动选择；卸载后的清理失败依赖宿主已有恢复记录，不声称已经删除。

## 原生临时聊天的服务生命周期约束

- 原生 composer、附件、权限、模型、消息展示仍归宿主；btw 只为本人 Session 的输入框和消息气泡加作用域虚线。工作区发现不调用 `create`，不自建默认工作区或猜测桌面启动 cwd。
- UI 的临时模式意图（`idle/choosing/opening/active`）、创建 request token 和后台 owner 回收表相互独立；启动早期工作区列表短暂为空不锁定等待，列表就绪后按同一规则直入。工作区选择发布的多个投影在微任务末统一读取；工作区一旦可解析（选择归属或官方 recent 规则）即直接进入，不等待手动选择提交。已开启会话遇到同工作区/无归属的空白页选择视为选区提交竞态，有界重断言本人视图而非回收重建；不同工作区空白页仍是切换。瞬时双 mainView 投影等待下一提交，不终止模式。切到历史对话/其他面板则退出模式。旧 request 返回的 owner 在后台回收，不阻塞新选择，也不写回新模式状态；没有前台 closing/清理/错误状态。本人视图通过公开 archiveSession 退出，但 archive 不等于 burn，后台仍须等待真实删除确认。
- 大文件 ID 的所有权校验从写入到 handle stat、目录 lstat、sidecar unlink 都保持 BigInt；普通 Number 只用于不涉及身份的类型/尺寸读取，不能混入 inode 比较。


- 缓存存储适配器可以跨可选注入 scope 复用，但清理回调必须在执行时重新取得当前 gate、workspaceRegistry 和 sessions；不得把首次注入的 domain/entity 当作永久服务，否则重载后会报 `domain 'workspace' is closed`。
- 一次 native open 固定自己的服务代次，异步准备、preset 挂载和 Session 关联后都需核对代次；依赖已重建时取消本次开启并清理本人预留资源，不混用新旧服务。客户端在 host 返回 ID 后、目录刷新前登记 owner；连接/注入 scope、请求 token 和目标工作区必须在异步边界核对，过期结果只通过创建连接在后台回收，不抢回页面。
- 父 scope 与可选依赖 scope 并发卸载时，先设置 shutdown fence、等待在途开启，再共享同一 native close 屏障；可选依赖在本人 writer/注册清理结束前不得释放。
- `burned: true` 必须有证据。重载丢失内存回执时，只能在永久拒写标记存在、本人恢复记录及 live/durable Session 和 workspace 引用均已不存在时确认已完成；该路径只确认，不删除未知 ID。清理未完成则保留记录并报告失败。

- 原生保护路由由公开配置解析 waterfall 施加到有效配置。仅启动时改一次 Entry 内存选项不够：欢迎页/设置保存会让 Include 用原始配置重建，丢失该修改。有效配置策略在每次解析时保留路由，不写用户配置、不在配置提交后循环热修域；显式 foreign route 仍不覆盖。

## 历史验收顺序

以下是最初单聊天阶段的验收顺序；本轮多聊天和统一视图的证据另记在 [verification.md](verification.md)，不将旧记录当作新行为已通过。

1. **最初 MVP**：新对话右上入口 → 无工作区灰色聊天 → DSH 默认模型两轮 → 等待清理退出。自动化先行，真实宿主/浏览器由主代理单独复验。
2. 来源会话、侧问、收起/停靠、草稿送回与跨来源保护，逐项验收已有实现。
3. recent/all/on-demand、模型/设置、缓存与错误恢复；最后按设计批注做窄屏、深浅色及键盘验收。不以单阶段通过代表全部完成。
