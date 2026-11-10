# btw 架构（第一阶段）

零 build：`lib/client.js` 直接交付 `window.__ModuleLoader__.load`，不引入框架或状态机库。已有功能保留，以阶段验收收束，不拆掉重写。

## 职责

- **客户端视图**：入口、全局主面板、弹窗和侧栏只负责展示与调用动作；共用一个临时聊天 store，`presentation` 不等于资源生命周期。
- **客户端动作**：`openTemp` 只配置本地草稿；`beginTemp` 首次创建子会话；`sendTemp` 管单轮串行轮询；`closeTemp` 是显式结束、全局面板卸载、插件卸载的唯一清理入口。
- **宿主 `lib/index.js`**：模型解析、子 agent、发送截止时间、持久化恢复记录和安全删除。保持既有清理屏障与真实宿主适配，不由 UI 删除文件。
- **非 MVP 支路**：侧问有独立任务代次；recent 取 `useChat(s => s.legacy)`；all 走官方 `session.events` 固定 cursor 分页和有界内存缓存；on-demand 在 `context-search.js` 搜索授权快照。容量由宿主 `resolveModelInfo` 查询。

## 临时状态与所有权

`idle → configuring → opening → active → closing → idle`。首发开启失败回到配置并显示错误；清理失败进入 `error`，保留子会话 ID 供重试。收起和停靠只改变展示，不结束对话。

全局入口不带 cwd/父会话，强制无父上下文，不能选择“当前会话模型”。退出等待 close 成功才切回新会话页。

- `generation` 隔离开启/结束/卸载；`tempTurn` 隔离每轮回复，旧回包不能写入新一轮。
- 开启 attempt 持有原连接、上下文取消器、open promise 和子会话 ID；send/poll/close 始终使用这个连接。迟到 open 先交回 ID，再由同一 close 屏障释放，不另开清理支路。
- 单轮最多一个 poll 在途；最终 poll 等待旧 poll。完成/退出清除 timer；退出中重复请求共用 `closingTemp`。卸载先启动该屏障，再释放 UI 服务并清空本地文本；卸载后的清理失败依赖宿主已有恢复记录，不声称已经删除。

## 阶段顺序

1. **当前 MVP**：新对话右上入口 → 无工作区灰色聊天 → 宿主默认模型两轮 → 等待清理退出。自动化先行，真实宿主/浏览器由主代理单独复验。
2. 来源会话、侧问、收起/停靠、草稿送回与跨来源保护，逐项验收已有实现。
3. recent/all/on-demand、模型/设置、缓存与错误恢复；最后按设计批注做窄屏、深浅色及键盘验收。不以单阶段通过代表全部完成。
