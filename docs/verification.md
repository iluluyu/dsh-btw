# 本地验证记录

## 本轮：先临时模式后工作区，后台安静回收

- 用真实安装版 UI 复现用户顺序，确认不仅是按钮状态：首次 Preview Notice 的 Continue 保存欢迎设置后，Include 重建 storage-domain 原始配置，将旧的一次性内存路由冲掉。观测到 binding 从 ok 变为拒绝、有效 routes 为空、保护 unit 列表为空；此前只测 RPC 未覆盖这一步。
- 改为 `installNativeRoute` 在配置解析 waterfall 中为每次有效配置保留保护路由。原始配置仍为 `{backend: json}`，有效配置含 `session_projcache: btw-native-json`；不写用户文件，不在设置提交后循环热修域。新增纯配置/启动调用点回归，以及真实宿主 raw config recompose 冒烟。
- 前台模式意图、创建 request token、后台 owner 回收表分离。可先开启模式再选择工作区；原生选择发布的投影在微任务末读取，注册目录本身不抢先取消宿主导航，新 blank 提交后接续临时模式。开启中或已进入后换工作区均转向新原生会话，旧结果后台回收，历史/面板导航仍可退出。
- 前台没有 closing/清理/失败弹层；退出即时回到普通模式，新模式不等待旧 burn。后台回收和开启暂时失败均有限重试；删除未确认的 owner 不丢失，保留服务端恢复证据，耗尽重试写诊断日志，后续操作可重试，不假报 burned、不将普通会话伪装为成功的临时会话。
- 本地 `npm run check`、278 项全量测试、扩展隔离 smoke、`git diff --check` 通过；随后新增并通过公开视图激活回调内取消的重入回归（客户端 148 项重测通过，整体新增至 279 项）。测试覆盖先模式后选区、创建中/活动时切区、旧 owner 回调隔离、后台重试及耗尽后保留、无前台错误、有效路由重解析与 foreign 配置保留。
- 实际浏览器使用全新隔离 HOME/DSH_HOME、无凭据、未发送消息：Continue → 开启临时模式 → 选择 project-a → 成功进入原生临时 root，输入框计算样式 dashed；再选择 project-b → 切入新 root，模式保持；退出后前台无清理/失败文本，两个 native 恢复目录为空，用户项目未删除，控制台无报错。不是 Windows/macOS 桌面 GUI 真机验收。
- Windows/macOS/Linux 验证分支 CI 结果以本轮 commit 的 workflow run 为准；不升版本，不改 main，不发布新 Release。

以下为更早时点的验证记录；早期的前台错误/closing、先选工作区和一次性 Entry 路由修改，均已由本节的模式意图/后台回收与有效配置策略替代。

## 本轮：桌面优先的原生临时聊天边界

- 复现并修复大于 2^53 的目录 inode 在 BigInt/Number 间丢精度，导致空会话关闭误报目录替换；同步修复 sidecar 身份精度。3 项回归覆盖正常关闭、真实目录替换拒删、stat→unlink 间替换拒删。
- 客户端按宿主 New Session 的公开 projection 规则继承当前/最近已有 workspace；新增桌面空白/default/recent/稳定排序、当前项目优先、pending discovery、Web 无 workspace 的测试。移除原生入口的无条件 create/adopt，不再由新 UI 请求独占 btw 分组。
- 明确 idle/opening/active/closing；开启中可以取消/恢复，关闭中可预约/取消重开，重开受原连接和后续导航隔离。显式结束当前本人视图走公开 uiWorkspace.archiveSession；实际 burn 独立执行并清理本人 archive 标记，不归档来源、不把归档当删除。
- cache 能力证据改成当前 facility 路由/domain/cache/活跃 unit，而非 backend 全局只许一个 unit；支持多个受保护 scope，拒绝借其他 unit 授权 foreign route。首次 bind 失败可重试，成功后仍 pin domain 并由 scope 重建恢复。新增初始化暂时失败/重复错误前缀、真实服务 reopen 回归。
- 全量 271 项运行中，270 项通过；新 reopen 回归的唯一失败是测试夹具仍引用旧关闭 unit，修正夹具后重跑全部 host 63 项均通过，其余 208 项已在同一实现上通过。`npm run check`、`git diff --check` 通过。
- 隔离安装版 Linux dsh 0.2.2-rc.1 连续 8 次未发送的原生会话：已有项目继承、公开 archive 退出、并发 close、实际插件 restart；无新 btw 分组，用户 workspace/哨兵不变，本人 JSONL/恢复记录/archive 标记移除，永久 deny marker 保留。脚本已通过并清掉所属进程与临时目录，无供应商请求。
- `.github/workflows/check.yml` 新增 Windows/macOS 的 filesystem/client contracts，结果以对应验证分支 workflow run 为准，未成功前不声称通过；这些是实际 OS 的契约测试，也不等同桌面应用 GUI 真机验收。本轮没有 Windows/macOS 桌面真机，不把 Web smoke 作为桌面通过证据。未 bump、未发布、未改用户 profile。
- 公开 SDK 能力与版本绑定私有读取边界见 [原生临时聊天架构复核](native-temp-architecture-review.md)。

## 本轮：workspace 关闭、临时聊天退出与切换

- 修复原生临时聊天清理回调长期保存首次 workspace/domain/sessions 实例的问题。可选服务重建后按次解析当前 gate；开启期间代次变化会取消本次创建并清理本人预留资源。
- 父/子 scope 并发卸载时保留可选依赖直至共享关闭屏障完成；host scope 重载后允许凭永久标记和无残留证据确认既有清理回执，绝不删除陌生 ID，也不把待清理记录视为成功。
- 客户端在工作区登记前即记录 host 会话所有权，登记失败与卸载统一走 burned 确认与可重试关闭；切换会话/连接后的迟到结果在登记工作区之前即被拦截，不打开或抢回页面。来源导航、连接和注入服务代次在多个异步边界使用同一 stale 检查。
- 新增 6 项后端、6 项前端回归；关键失败场景先复现再修复。`npm run check` 与全量 251 项测试通过；最后追加两项切换回归并修复后，客户端/兼容/模块相关 146 项及客户端语法检查全部通过，`git diff --check` 通过。真实 `@deepseek-ai/cordis` 卸载覆盖在测试内。
- 扩展 `node scripts/smoke-isolated.mjs`：在隔离 HOME/DSH_HOME 中使用安装版 dsh `0.2.2-rc.1`，验证普通临时聊天并发独立清理、原生 root 创建、整个插件真实 restart、随后重复 nativeClose 回执，以及 JSONL/workspace/records 全部消失、永久拒写标记保留。探针位于隔离目录，避免同一个 client package 注册多个 Loader source；restart 后通过真实依赖就绪屏障等待子 scope，而非固定延迟。脚本通过并清理全部所属进程/临时目录。
- 未请求真实供应商模型、未重启用户现有服务、未改用户 profile、未 bump 或发布。未重做 Windows、跨进程共享 DSH_HOME 或 UI 像素验收；展示模式既有回归保持通过，未为未证实的问题改变交互语义。

## 本轮：项目内 btw 实时思考与工作区继承

- 项目会话中的 btw 通过 opt-in 快照展示本人当前 attempt 的真实 reasoning delta；使用 DSH 公开 `DisclosureRow`、思考图标及 reasoning 正文 Factory，思考中展开、结束后自动折叠。重试替换实时快照，失败/取消清除，最终内容仍以成功提交的事件为准；不展示 signature，不向来源草稿插入思考。
- 隔离 Web 与延迟合成 adapter 实测：思考文本在正式答案前可见且展开；随后答案出现、思考自动折叠。当前工作区 `project` 也已在新原生临时 Session 继承，结束后原 Session 与工作区文件保留。
- 固定面板折叠时，展开按钮为绝对定位，消息区高度 159px（200px 面板）；展开后编辑器也以绝对定位悬浮，折叠/展开保留草稿。390px 宽度实测标题和操作在同一行、无横向溢出；输入提示不再显示「回复中，可以等它说完」。
- `client.js` 现在记录所有 sibling chunk 的 SHA-256；测试使用安装版 DSH registry 验证仅改 sibling 不会更新 URL，而更新入口印记会发布新 revision，避免浏览器复用不可变旧版本。更新入口后再次用隔离宿主和延迟合成模型验证实时思考展开、回答后折叠。
- 最终 `npm run check`、`npm test`（216/216）、`git diff --check`、隔离跨进程缓存探针及 `scripts/smoke-isolated.mjs` 通过。

## 上轮：无来源 btw 接入 DSH 原生普通对话页

- 无来源入口经 `/btw nativeOpen` 创建 btw 独占的普通 root Session，公开 `uiWorkspace.openSession(id)` 打开完整原生 conversation；composer、`+`、权限/模型选择、思考与消息渲染均由宿主提供，btw 只按 `[data-conversation-session="<owned id>"]` 作用域给 composer 卡与用户气泡加虚线描边，并在右上角提供带对勾的「临时聊天」状态入口，点击结束（原生 hero 页不渲染 header utilities）。路由由插件启动时自动绑定（内存合并，绝不写用户配置）；用户显式路由到其他 backend 或 gate 未绑定时 `nativeOpen` 明确报错拒绝创建，前端显示错误，不创建临时会话，旧 ask/open 协议保留可用。
- 创建前先落本人 UUID 的持久拒写标记（pre-create tombstone；gate 对本人 UUID 的 `session_projcache` 写入拒写，其他 key 透传），投影缓存从不落盘；默认继承当前 Session 所属的工作区；没有工作区时 cwd 为独占空目录 `$DSH_HOME/.btw-native-workspaces/_no-cwd/<UUID>` 并建立专属 WorkspaceRegistry 注册。两种方式都通过 `attachSession` 挂接本人 Session，否则原生 hero composer 会 inert。
- `nativeClose` 需要 `{sessionId}` 且必须返回 `burned: true`（未确认视为失败）；关闭顺序：拒写标记 retain → dispose → whenIdle → 删本人 JSONL 与空目录 → 移除专属 workspace 注册（先注册后目录）→ 删恢复记录 → 只清理本人 archive/pin 条目。隔离浏览器实测：关闭后 session 目录、project 目录、workspace 目录、records 全无，workspace registry 回到空，只剩 `.btw-native-deny/<uuid>.json` 永久墓碑（按设计保留）；临时 workspace 打开期间作为「btw」分组出现在宿主工作区列表，关闭即消失。
- 边界：不是 OS 沙箱（普通 preset 权限策略仍适用）；共享附件 blob 不删；不做安全擦除；不保证绕过 gate 的写入；跨进程互斥/并发宿主/断电等场景未覆盖。
- 验证全部通过：`npm run check`、`npm test`（**204/204**）、`git diff --check`、`node scripts/native-cache-backend-probe.mjs`、`node scripts/native-cache-cross-process-probe.mjs`、`node scripts/smoke-isolated.mjs`、`npm pack --dry-run`（15 files）；隔离 Web 宿主实测打开→原生发送→回答→结束→无残留。仅隔离 HOME/DSH_HOME 与本地合成 adapter，未调用真实供应商模型、未读真实会话。

## 上轮：紧凑面板、侧栏和子会话思考

- `npm run check`、**178 项测试**和 `git diff --check` 通过；仅使用临时 HOME/DSH_HOME、合成会话和本地 adapter，未请求供应商模型、未读真实会话。
- 固定面板桌面外框与原生输入框均为 left420.5/right1132.5，390px 窄屏均为 left16/right367；默认高200px，只提供顶部高度拖柄。旧 v2 宽高不再覆盖，v3 只记手动高度。
- 两轮真实 DSH 子会话均保留用户消息和回复。首个有效回复后输入区收起；圆形按钮用公开模型菜单同款 Chevron，展开可继续输入，草稿保留。实测原生图标忽略 inline transform，故通过 CSS 翻转，避免展开箭头方向错误。
- 固定面板放大经已核验 child tab 进入原生侧栏全屏；点击 DSH 的退出全屏返回原面板，原子会话、历史和未发草稿保留，不留侧栏 tab。项目标题入口在桌面实测默认普通侧栏；侧栏不再嵌套模式控件，侧栏中新建保持侧栏，旧聊天和草稿不变且不产生浮窗。窄屏自动全屏遵守宿主布局。
- 合成 adapter 返回 reasoning block，经安装版公开 DSH 运行时及 btw 独立游标传输，两轮各自渲染可展开的「思考过程」。正文使用 root-scope 的公开 `conversation.chat.reasoning.content` Factory（缺失时安全回退），折叠外层仍由 btw 提供。隔离 DSH 的固定、浮窗、侧栏和无来源页面均实测出现宿主的 compact Markdown，且无页面错误；只传 child 已成功提交的思考，不传尝试、tool 参数或其他会话事件。送回草稿只含答案；未提供 reasoning 的模型不伪造，当前非逐 token 展示。
- 无来源 btw 入口在主区域打开，不使用浮窗，输入框和用户消息为虚线；通过独立 child 发送，点击 X 或导航离开都运行关闭/删除屏障。实测恢复记录从1到0，导航后无残留浮窗。**该页面当时仍是 btw 自有视图，不是原生 conversation**。后续隔离实证发现 btw 持有普通 root Agent 可以走原生会话路由，`uiWorkspace.openSession` 可绑定原生完整页面；但普通 Session 退出后留下的 projection cache 缺少可证明的并发写入排空屏障，组件级受控测试复现了缓存删除后重新写入。该轮结论已被取代：后续轮次改为创建前拒写门（见顶部本轮记录与 `native-cleanup-algorithms.md`），原生普通页已接入。

## 上轮：精简侧栏控件

- 侧栏内不再渲染 btw 自带的全屏或最小化按钮；全屏由 DSH 原生侧栏控件负责，X 结束并清理该聊天。小窗与独立全屏的控件保持不变。
- `npm run check`、客户端及侧栏回归共 97 项和 `git diff --check` 通过；覆盖侧栏按钮不存在、X 调用 child close 并移除标签、失败可重试以及其他模式不丢草稿。本轮未再次重启用户服务，运行中的页面需要重启后加载新代码。

## 上轮：项目对话中的闪屏与面板布局

下方侧栏 btw 自带的全屏与收起控件已按最新需求移除；侧栏使用 DSH 原生全屏与 btw 结束按钮。以下保留为该轮历史证据。

- 隔离 DSH rc.1 项目会话，以本地合成 adapter 和逐帧采样复现：首次和再次打开都先出现 993×33px 的加载条，再跳为 712×240px 面板；输入框 DOM 未重新挂载。原生 sticky composer 与其 ResizeObserver 放大了两次尺寸变化。
- 修复后首次加载按帧为 712×240px 占位 → 同尺寸面板；收起后热打开直接显示 712×240px 面板，没有加载条中间帧。两次均保留来源草稿与输入框 DOM，收起重开保留 btw 草稿。冷加载失败可重试、取消和卸载屏障保留。另一次独立审查复现并修复 dock 加载提示重复显示在 shell overlay、取消浮窗加载误取消并发 dock，以及已有手动尺寸冷启动占位跳变。
- 编辑器改为占满可用宽度，独立消息区为唯一面板滚动区；滚动条向内避开右侧 8px 缩放手柄，浮窗同样避让。390px 页面无横向溢出，编辑器实测 329px；滚动内容足够长时命中滚动区而不是 resize handle。隔离宿主读取实际新 chunk 后复测：桌面编辑器宽690px、窄屏329px，输入区不产生额外滚动条，消息滚动条内缩8px。390px 下完整提示文字测宽255px、编辑器可用宽317px；面板与来源输入框外框均 left16/right367，并检查了实际截图。

- 项目会话标题 btw 实际直接选中原生侧栏 tab；原生默认页竞态只做一次身份核验后的修正，用户主动切换会取消。真实浏览器手动切到 Start 后未被抢回，再按标题 btw 恢复原草稿；内部结束后只移除 btw tab。原生全屏时收起/结束会隐藏本插件当前活动 tab 所在的侧栏，避免 Start 全屏遮住原入口；其他 tab 不被移除，收起再开保留草稿。
- 侧栏内的 btw 全屏按钮通过 DSH 的目标校验与原生 `toggleFullscreen` 扩到主区域（实测宽1279px），再次点击恢复侧栏（575px），草稿不变；目标不是本插件或宿主缺能力时回退独立全局面板。使用本地合成模型，不触碰用户服务。
- 最终 `npm run check`、**154 项测试**和 `git diff --check` 均通过；本轮隔离浏览器、宿主及临时目录已清理。

## 本轮：统一多轮、按需加载、对齐与设置

- `npm run check`、**139 项测试**、隔离宿主 smoke、公开 LLM API 的按需调试脚本和 `git diff --check` 通过。最后的窄屏 CSS 调整又通过 7 项设置测试；实际安装版 loader/打包协议补验 2 项通过。npm dry-run 共 13 个文件，包含全部五个客户端 chunk，无文档/测试或新依赖。
- DSH `0.2.2-rc.1`、临时 HOME/DSH_HOME、合成会话和进程内 `LlmAdapter`。未读取真实会话、凭据，未调用真实供应商模型，未重启用户服务，未 bump/commit/push/发布；不是供应商兼容性或 OS 网络沙箱认证。
- 未打开 btw/设置前，功能 chunk 与 `/btw/models` 请求均为 0；首次聊天只加载 controller/geometry/messages/views 四个 chunk，各一次；设置卡在首次进入原生 Plugins 页面时另加载一次。失败重试、并发去重、卸载后晚到设置 chunk 不注入 CSS/不复活 UI 有回归。
- 固定面板连续两问在真实 DSH child 的 `options.messages` 中召回首问 marker；保留两条用户消息和两条 Agent 回复，而非拼接回放历史或每问重开。固定→收起→原按钮→浮窗→侧栏→全屏→侧栏始终只有一个 child/恢复记录，问答和未发送草稿保持；来源草稿未被发送或覆盖。
- 收起直接回到原 btw 按钮，再点继续，不显示恢复页面。内部 X 结束后，恢复记录和本插件原生侧栏 tab 均为 0；再开是空白聊天。全屏→侧栏先恢复来源页面，未留下空 tab。
- 默认固定面板高 240px。1280px 页面中面板与原生 composer 外框均为 left420.5/right1132.5；390px 深色页面均为 left16/right367，两侧误差均为 **0px**，来源输入框仍可见，无横向溢出。`/dock-v2` 迁移旧自动宽度，保留新手动尺寸/浮窗几何，有专门回归。
- 消息使用原生 Markdown 的标题、列表、代码及工具栏；两轮回答的消息区 clientHeight108/scrollHeight1184，内部滚动而非撑高宿主。钉住浮窗仍可从西边键盘缩放：width740→750、left270→260，right1010 不动；存储仅含项目内数值几何。焦点移到来源输入框后 Escape 只收起浮窗、不结束聊天。
- 设置按 outline 分为聊天默认/窗口行为/入口，复用公开 Menu；无已验证的公开 Switch，使用键盘原生的 checkbox role=switch 回退。真实 Plugins→dsh-btw→Configure 进入卡片；普通本地包安装下上下文/开关写入成功，拒写回归及原子模型更新回归保留。390px 深色卡片宽350，无横向溢出，五个开关仍右对齐；深浅色截图已检查。
- 设置成功写入验证使用隔离 profile 的原生 CLI `file:` 安装。另验证了外部临时 patch 的写入返回 false 时，UI 明确显示“设置未保存，请重试”，不把它当成功或悄悄改变值。
- 原生 UI 的来源文本在第 5400 字之后放置 marker，按需 child 收到 `DEMAND_CHILD_CONFIRMED`；来源参考没有变成 btw 消息。已完成 tool-result 文本、超过14条短消息及最终48k尾部预算由回归/公开 runtime 脚本覆盖；不调用工具与不支持工具的公开错误明确失败，无 all/none 回退。
- 本轮不含完整来源 fork、真实供应商请求、远端 CI 或 Node24 矩阵。所有自有测试会话先显式结束，随后清理所属浏览器、宿主、临时 profile/目录与截图。以下内容保留为历史证据，不代表当前实现。

## 上一轮：多 btw 与三种展示模式（宽度滑杆版）

本轮包含辅助实现与只读审查；主会话核对实际代码、修正兼容测试并进行真实宿主/浏览器验收。以下是该轮证据，不沿用后文旧版单聊天的通过结论；其中编号切换器、宽度滑杆等行为已由后续需求取代。

- Linux / dsh `0.2.2-rc.1`；临时 HOME、DSH_HOME、工作目录、web profile。无用户凭据、无外部供应商请求。浏览器回复来自临时的进程内合成 adapter；Node loopback guard 仍不是 OS 网络沙箱。
- `npm run check`、98 项测试和 `git diff --check` 通过。新增覆盖多 controller 并发、晚到 open、关闭失败/重试、原连接归属、跨来源和展示切换、卸载全部、默认模型、位置/宽度、钉住/拖动、记忆开关和设置值。旧测试中的“默认必进全屏/默认必为 host”已按新行为更新。
- `node scripts/smoke-isolated.mjs` 通过：除原有认证和安全删除检查外，两条临时会话同时存在，关闭一条不会影响另一条的记录、文件和轮询。
- 浏览器实测两条独立聊天：模型、回复和草稿不串线；关闭 A 后 B 仍在。小窗→全屏保留 A 草稿；来源聊天在小窗→侧边栏→全屏→小窗间保留两条消息、未发送草稿和已选消息，不重新创建子会话。
- 已授权 recent 来源文本没有出现在 btw 消息列表。选择助手消息送回后，来源草稿 `MAIN_DRAFT_KEEP` 前缀仍在，提示“已插入草稿，未发送”；来源模型保持 Fixture one，主会话未自动发送新 turn。
- 固定小窗实际鼠标拖动不改变位置，解钉后能移动并夹紧到视口。关闭后新窗口恢复数值位置/宽度，聊天正文和草稿不恢复。不同项目几何键隔离；关闭记忆及存储故障有自动化覆盖。
- 全屏内容宽度滑到 360px 后，消息列和输入区都实际变为 360px；三种模式的聊天壳和输入框计算圆角均为宿主的 28px（`--dsw-radius-panel`）。长回答只使内部消息区滚动。
- 390×844 小窗在视口内、无横向溢出；浅色截图检查通过。深色菜单实测在弹窗上方且可点击，Escape 仅关闭菜单并返回触发器焦点，不结束聊天。最终去掉正常状态的重复副标题后，重启隔离宿主复核标题仅为 btw。
- 补齐原生侧栏标签的显式 Close：使用 dsh `registerCloseHandler`，只结束该来源当前展示于侧栏的聊天，不因收起、切会话或切模式而结束。单元回归和真实浏览器均确认：关闭前一条恢复记录，原生 Close 后记录为零，来源模型不变。
- 项目内 child 使用公开委派深度/谱系/权限辅助函数；独立 composition 和安全删除不变。真实来源的默认模型及 recent 首发成功，父会话不被写入 subagent catalog；无来源不虚构父关系。完整 fork 和上下文种子机制未在本轮改动。

边界：无来源的新建不能挂载 dsh 的会话侧栏，默认侧栏会回到小窗；侧问仍是一次性任务。新设置的写入/拒写有 form-scope 回归覆盖，本轮未从插件安装列表进入真实设置页进行像素验收，也未重新做真实供应商模型测试。全部所属浏览器、宿主和临时目录在验收后清理；用户服务未重启，未 bump、push 或发布。

## 历史：环境与边界

- Linux，Node `26.12.1`，安装版 dsh `0.2.2-rc.1`。
- 使用临时 HOME、DSH_HOME、工作目录与独立 web profile。不读取或删除真实用户会话，不改真实 profile。
- 复用已授权配置的本地模型路由，仅发送合成问题。目标凭据单独提取到权限 0600 的隔离文件，不打印密钥；验证结束清理所属进程及临时目录。
- 不发布、不提升 npm `0.0.3` 版本。远端 CI / Node 24 矩阵未执行，不把 CI 配置当成已通过证据。

## 自动化与真实宿主

```sh
npm run check
npm test
node scripts/smoke-isolated.mjs
node scripts/smoke-model.mjs /path/to/cordis.patch.yml /path/to/.credentials.yaml
git diff --check
npm pack --dry-run --json
```

- 交付前完整测试 **78 项通过，0 失败**；覆盖真实协议形状、来源和请求代次、乱序轮询、晚到 open、关闭重试、卸载、设置拒写、分页/缓存/取消与清理故障。
- 离线 smoke 退出 0：真实宿主认证围栏、内置 `/api`、工作区及无工作区 open/poll/close、JSONL 文件和 version 2 恢复记录删除、普通会话哨兵保留、延迟复查不重建。
- 真实模型 smoke 退出 0：none 固定回答、recent/on-demand marker、all 超过 48k 的历史开头 marker，以及 byte-identical 完整历史前缀的第二问；无工作区两轮 send/poll 正确回忆 marker，close 后目录和记录消失，所属进程与临时根目录已清理。
- 主代理检查过 npm dry-run 的文件列表：8 个文件，压缩包约 36KiB；只包含运行时代码、manifest、许可与 README，设计、测试、脚本、CI 和截图不进入 npm 包。
- 最后关闭所属浏览器与宿主，确认没有遗留测试进程；隔离视觉测试根目录（含合成会话和凭据副本）已删除。真实用户配置、凭据库及会话未改动。

## 先 MVP，再扩展

Astra 单一负责架构收束，不重写已验证的宿主；职责、状态流与资源归属见 [architecture.md](architecture.md)。每轮代码冻结并重启真实宿主后才进行浏览器验收，避免热重载干扰结果。

### MVP

新开对话页右上入口 → 全局无工作区灰色输入框 → 宿主默认模型连续两轮 → 显式退出。

浏览器两轮均回答 `FROZEN_MVP_5638`；页面只有模型控件，没有继承或当前父模型控件。退出后对应临时 UUID 目录和记录消失，两个普通合成会话文件保留。

### 来源会话与侧栏

- recent 侧问、all 官方历史分页和当前父模型均返回来源 marker `UI_BTW_7391`，主草稿 `KEEP_DRAFT_8240` 保持不变。
- on-demand 用 literal `marker` 检索返回正确值。过窄连续短语可能不命中：这是有界字面工具，不保证语义召回，未命中不代表完整历史无相关内容。
- 停靠侧问后改为“无上下文”，临时子会话仍能回答上一轮 btw 问答，验证不是仅复制气泡。
- 多选两条助手消息送回来源草稿，原前缀保留；主会话仍为 1 turn，没有自动发送。
- 弹窗、收起、恢复保留同一临时 UUID 与四条消息，显式结束后记录清空。
- 原生设置页将 all、custom 自定义模型及 temp recent 默认值写入隔离 profile；关闭侧问按钮开关后来源页按钮消失，临时入口仍在。重启后 temp recent 默认值仍生效；全局聊天仍强制无父上下文。

## 界面与交叉验证

- 1280px：新开对话右上入口位置正确；模型 → 上下文 → 发送，单层输入，无重复说明；设置与全局模式符合批注。
- 390×844：深浅色弹窗均在视口内、无横向溢出；停靠转弹窗会折叠原生侧栏，`elementFromPoint` 确认弹窗处于实际可交互顶层。Esc 收起通过。
- 卡片、输入容器与非胶囊矩形使用 dsh 的 `superellipse(1.5)` 曲线；圆形/胶囊保持 round，旧浏览器回退普通 border-radius。
- terra 复验宿主的部分输出后失败、全 send 超时、缓冲/任务过期、明确 stop 四项，均与回归测试闭环。
- sol 复验前端请求/来源隔离、串行轮询、晚到 open 失败重试、正确 legacy、停靠承接、快速重进、设置 false 和 showOverlay，未发现确定残留缺陷。主代理独立运行测试并进行以上真实浏览器检查。

最终截图（只含合成数据）：

- [新开对话入口](verification/screenshots/new-session-entry.png)
- [无工作区独立临时模式](verification/screenshots/standalone.png)
- [窄屏浅色弹窗](verification/screenshots/temp-narrow-light.png)
- [窄屏深色弹窗](verification/screenshots/temp-narrow-dark.png)

设计批注逐项对应见 [design-acceptance.md](design-acceptance.md)。原画布、批注保留，不替用户删除。

## 旧进程兼容提示回归

原用户 web 进程早于新版宿主代码启动；本地插件链接和磁盘上的 `models` 注册均正确。只刷新前端会产生 `unknown method: models`。客户端已增加明确重启提示及重试回归，认证/网络错误不会被误报为版本问题。check、78 项测试、diff 检查及隔离宿主 smoke 重新通过。

### 用户授权后的实际服务闭环

用户明确选择“现在重启并检查”，授权短暂断开原 `dsh web`，同时限定只检查模型列表、不读取会话正文、不在真实存储中做删除测试。已在用户指定时间向原进程发送 SIGTERM 并等待正常退出，然后使用原 Node 可执行文件、原 `dsh web` 参数、原工作目录及原进程环境重启。未强杀、未改用户 profile 或模型设置。

**当前实际用户服务 `http://127.0.0.1:3080` 的已认证 `POST /btw/models` 成功：** HTTP 200，RPC envelope 的 `rpcId` 匹配且 `result.ok === true`；返回目录包含已授权的本地模型。不再是 `unknown method`。新进程随后仍正常运行。

本次实际服务检查：会话正文读取 0、模型调用 0、会话删除 0；认证令牌和 Cookie 只在检查进程内存使用，不输出到工具结果，保留的启动日志已脱敏。已提示用户刷新页面；不为了额外浏览器截图而打开可能呈现私人会话的页面。真实两轮聊天、浏览器交互和退出清理的证据仍采用上文隔离环境结果，以遵守已确认的隐私/清理边界，而不是扩大重启授权。

## 已知边界，不作超额承诺

- 全部对话是指定来源切点的已记录用户/助手/工具文本，不含未提交输出和附件二进制。缺页、超过 1Mi 文本或保守模型容量预算会明确拒绝，不静默截断。
- 本地历史缓存有界且按连接/来源/cursor 失效；重复请求使用稳定前缀，问题在末尾。btw RPC 未暴露 provider cache-read usage，因此**没有确认远端缓存命中率**。
- 临时存储仅支持已核验的 Linux / rc.1 默认 JSONL，未知或自定义存储在创建前拒绝；逻辑删除不等于安全擦除。详见 [存储边界](temporary-chat-storage.md)。
- Node loopback 守卫不是 OS 网络沙箱；有工作区的工具不是 OS 文件沙箱。无工作区模式不挂载文件/命令工具。
