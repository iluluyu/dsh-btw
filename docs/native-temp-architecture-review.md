# 原生临时聊天：桌面优先的边界与实现决策

## 1. 宿主公开能力的限制

安装版 dsh `0.2.2-rc.1` 没有公开的逐 Session ephemeral/in-memory/non-persist 参数，也没有 Session 删除接口：

- `dsh-agent/lib/types/index.d.ts:49-117` 的工厂选项不含 persistence 开关；`dsh-agent-loop/lib/index.js:1641-1643` 从自身 runtime 解析 persistence，存在即创建 writer。
- `dsh-session-persistence/lib/types/index.d.ts:108-155` 只有 create/open/flush/stat/list；SessionController 的公开 RPC 也没有 delete/destroy。
- 绕开 Agent 工厂手工发布内存 Session 并不能排除投影落盘：`dsh-session-projection-cache/lib/index.js:293-317` 仍订阅 Session store。
- `uiWorkspace.archiveSession` 可以退出原生视图，但归档不是删除，不能把 archive 成功当作 burned。

因此，本次不移除 pre-create tombstone/拒写保护后继续声称“临时记录已清理”，也不冒充安全擦除。真正通用、无版本钉的原生临时 Session 需要宿主新增公开 capability。

## 2. 职责分层

### 原生 UI

composer、附件、权限、模型和消息渲染使用原生完整 Conversation。btw 只给本人 Session 的 composer card 和用户消息气泡加作用域虚线，不复制原生组件、不修改主会话。

### 工作区选择

使用公开 `workspaces.list` 与 `sessions.list` 投影，而不是根据 Web/桌面或启动目录猜测：当前 mainView 的成员归属优先；空白页按官方 New Session 的 recentWorkspace 规则选择（成员最大 updatedAt，空组 createdAt，同值保留宿主顺序）。

桌面已有默认工作区作为普通已有 item 被继承；Web 没有工作区时保留临时模式，等待原生选择真正提交（不能只看到新 workspace 注册就抢先导航）。当前 UI 只发送明确 workspaceId，不调用 workspaces.create/adopt；选择其他工作区的原生 blank 属于同一临时模式，过期 request 的 owner 在后台回收，不创建额外 btw 分组。底层旧 `{}`/cwd API 的独占恢复代码为兼容保留，不是新 UI 的兜底路径。

### 客户端生命周期

前台只有 `idle/choosing/opening/active` 模式意图，每个创建 request 独立拥有取消 token；后台 owner 回收表独立管理关闭屏障。退出前台模式不等待磁盘回收，新模式也不受旧 owner 的成功/失败回调影响。旧 request 的迟到 ID 仍有归属并在后台回收；真正的历史/面板导航会取消模式，而工作区选择提交的新 blank 会接续模式。

显式结束当前本人原生视图时调用公开 archiveSession（仅本人、仅当前会话页），先退出 mainView；后续 nativeClose 仍负责 writer barrier 与删除，且清理本人的 archive 标记。用户已切到其他会话、面板或正在卸载时不导航回旧页面。前台不显示清理进度或错误弹层。回收失败后台有限重试，超出上限继续保留 owner/恢复记录，后续操作或重启可恢复，诊断留在日志；不能把失败当作 burned，也不能跳过 burn。

### 宿主所有权与清理

UUID 的持久拒写标记先于 Agent 创建；close 顺序保持 retain → dispose → idle → 本人 JSONL → 已有 workspace detach/本人恢复记录。已有项目目录、其他 Session、共享附件不删。

Windows/NTFS 大文件 ID 的记录、校验和 sidecar unlink 都使用 BigInt，避免 Number 精度丢失导致正常目录被误判或替换文件漏检。记录格式不变；旧记录仍按持久所有权与进程死亡证据恢复。

### 版本绑定的存储适配

cache gate 是宿主存储适配层，不是 UI 模式判定。一个 backend 可以服务多个宿主/window scope；不能用全局 target 数量等于 1 作为启用条件。校验本 facility 的有效路由、domain 代次、已初始化 cache、活跃保护 unit 和 backend 身份。

读取 `facility.config` 在 SDK 类型中属于 private：这是精确版本钉死下的只读兼容适配，不是公开 routing API。禁止修改这个字段，禁止把未知版本当作兼容。默认 JSON backend/root 与 descriptor 钉死继续保留，显式外国路由不被强行覆盖。

配置策略通过公开 `internal/config` waterfall 施加在有效配置：实际浏览器已证实，欢迎页 Continue 的设置保存会重建原始 storage-domain 配置，冲掉一次性 Entry 修改。现在原始配置仍为默认 JSON，而每次解析的有效配置都保留保护路由；不会写盘或事后反复热修。首次 bind 暂时失败可以在下一次操作重试；一旦成功则 pin 该 domain，后续域代次变化必须由注入 scope 重建再授权，不能把旧 cache 偷换到新 domain。错误不再重复包装“原生临时聊天不可用”。

## 3. 验证边界

- 纯回归：桌面空白页/default/recent 工作区 shape、Web 无工作区、先临时模式后工作区、活动模式切区、后台回收期间重开、有限重试与静默恢复、导航隔离、UI 退出与 burn 分离、Windows 超过 2^53 的文件 ID、多个 cache scope、foreign route 拒绝、初始化失败重试及 cache reopen。
- 真实 Linux 隔离宿主：连续 8 次未发送的原生会话，在同一已有项目内创建；公开归档退出、并发关闭、真实插件重载；无新 btw 分组，日志/恢复记录/本人 archive 标记移除，用户项目与哨兵不变。
- CI 新增 Windows/macOS 的 filesystem/client contract job。尚未推送运行时不能声称已通过；这些 job 也不等同于 Windows/macOS 桌面应用 GUI 真机验收。
- 不承诺：宿主内存擦除、其他客户端或绕过 gate 的副本、共享附件、安全擦除、双进程共享 DSH_HOME、断电恢复、未知 SDK/存储后端兼容。
