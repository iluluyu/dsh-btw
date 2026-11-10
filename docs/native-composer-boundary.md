# DSH 输入框复用边界（rc.1）

**现状：已接入原生页面。** 无来源 btw 经 `/btw nativeOpen` 创建 btw 独占的普通 root Session，前端用公开 `uiWorkspace.openSession(id)` 打开完整 DSH 原生 conversation；原生 composer、`+`、权限/模型选择、思考与消息渲染全部由宿主提供。btw 只额外做两件事：按 `[data-conversation-session="<owned id>"]` 作用域给 composer 卡与用户气泡加虚线描边；因原生 hero 页不渲染 header utilities，在右上角提供带对勾的「临时聊天」状态入口，点击结束。启用需显式 startup 路由（保留用户完整 `storage-domain` 配置，仅添加 `routes.session_projcache: btw-native-json` 后重启）；未绑定 gate 或路由被覆盖时 `nativeOpen` 明确报错拒绝创建，前端显示错误，不创建临时会话，旧 ask/open 协议保留可用。拒写门、workspace 注册与关闭顺序见 [清理算法](native-cleanup-algorithms.md)，本文件保留历史调研与其结论。

用户希望 btw 使用 DSH 原生输入框、发送按钮、`+` 和权限管理。接入前的实现让无来源 btw 在主区域的独立页面打开，输入框与用户消息采用虚线，退出触发既有 child 清理；发送控件使用原生风格的圆形向上箭头，并复用已验证可用的公开 `Menu`、`Button`、`Tooltip` 和 Markdown。那曾是 btw 自己的视图，不是 DSH 原生 conversation factory，也没有冒充可用的附件或权限功能。

## 公开能力

- `@deepseek-ai/dsh-client-ui-conversation` 的 `conversation.content` 是公开、按 session scope 渲染的完整 conversation factory（`lib/types/client/contract/slots.d.ts` 中 `conversation.content`）。它不是可独立导入的受控 composer。
- 源码中的 `InputBar`、发送按钮及权限选择器不是相应包公开导出的可直接复用组件；不可通过私有深层路径 import 或复制整块实现。
- DSH 的 `+` 绑定当前 composer 的命令菜单、文件选择/上传、附件草稿和生命周期。权限选择器绑定其所在 session 的权限操作，不能简单挪用来源会话的 slot，否则会影响来源而不是 btw child。

## 后续接入条件（历史调研）

两次静态检查与一次隔离宿主实证确认：rc.1 普通 session 历史读取和发送的正向对照成功，但 parentless subagent 使用同一路由读取历史、解析 agent 和发送均返回 `session/agent-busy`。subagent 地址要求真实父会话与 descriptor，无来源 child 不满足；公开 retain 未知字符串 ID 也会拒绝。这排除了把现有无父 **subagent** 当作普通 Session；也不排除直接新建普通 Session，后者已单独验证并接入（见上）。无论哪条路径，都不能只传 ID 假定 scope 已隔离，也不能让权限按钮写来源或全局默认值；未验证前不显示假 `+` 或无效权限选项。

## 普通 Session 的再次实证

用户希望新对话 btw 直接使用原生普通对话，并在结束后清理。已找到比 subagent 更直接的可行部分：btw 用 `agents.create()` 创建并持有普通 root Agent，宿主会自动发布其 Session；客户端公开的 `uiWorkspace.openSession(id)` 可直接打开原生完整 Conversation。隔离宿主测试中，普通 history 可读取；执行现有 dispose 与独占 JSONL 清理后，该 Session 从列表消失，另一个普通 Session 不受影响。关闭没有并发发送的正向路径得到验证。

当时未直接启用的原因是删除屏障：普通 Session 的 `session_projcache/sessions/<id>.json` 在 dispose 后仍然存在，可能含标题、用户问题等投影。公开 `table.delete(id)` 只排空已经入队的存储操作；组件级受控实验中，一个仍在等待 flush 的 checkpoint 可以在删除之后重新入队并恢复缓存。持有事件的并发冷读同样能在删除后写回；未找到能排空全部在途写入的公开屏障。上传的图片/文件 blob 还可能跨 Session 去重共享，不能直接删掉。不能把归档或一次延迟删除当成清理完成。

最终做法不是事后删缓存，而是 [清理算法](native-cleanup-algorithms.md) C 节的公开 backend 扩展：创建前先对本人 UUID 的 `session_projcache` 写入落持久拒写标记（pre-create tombstone），其他 key 透传；这样投影缓存从不落盘，关闭只需清理本人 JSONL 与独占 workspace。该方案已按显式启动路由接入产品（`nativeOpen`/`nativeClose`）；共享附件 blob 不删、不做安全擦除、不保证绕过 gate 的写入等边界不变。

此次调查仅使用隔离 HOME/DSH_HOME、合成数据与本地测试；未读取真实会话、凭据或访问外部供应商模型。
