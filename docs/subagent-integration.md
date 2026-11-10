# dsh subagent 与 btw 的适配边界

核对对象：本机安装的 dsh `0.2.2-rc.1`，包括 `@deepseek-ai/dsh-subagent` 的 README、类型和实现；未读取真实会话，也未调用模型。

## 选择

临时聊天通过 `ctx.agents.create()` 创建由 btw 自己控制的独立子 agent，使用独占目录、恢复记录和每条聊天自己的关闭清理屏障。三种 UI（小窗、侧边栏、全屏）只切换同一聊天的展示，不创建第二个 agent。侧问仍是一次性的 `llm.stream()`，不创建持久化会话。

有在线来源 agent 时，优先复用 dsh 公开的 `resolveChildDepth()`、`childSessionMeta()` 和 `captureDelegatedPolicyOverrides()`：将 `parentSession`、委派深度和 `isSeeded: false` 写入子会话，捕获父 agent 的显式权限范围，再通过 `appendDelegatedPolicyOverrides()` 写入子会话，审批始终锁为 `never`。不向父会话写目录或消息，不继承父 composition 或据此授予工作区工具。无来源时不虚构父会话。

宿主缺少这些辅助导出时保留独立 agent 兼容路径，至少固定 `approval/policy: never`。这不等同于完整的 `startActivation()` 委派或 fork；上下文仍采用用户授权的 none/recent/on-demand/all 参考文本，后续再评估历史种子继承。

## 为什么不直接调用 `ctx.subagents.startActivation()`

- 完整的本地委派要求在线父 agent；即使 `delivery: 'caller'`，创建后也会向父会话追加 `subagent/catalog` 事实。btw 只在子会话记录真实来源，不改动来源会话。
- fork 继承的是父会话的已完成历史，而 btw 的 recent/on-demand/all 使用用户授权的快照，并将来源文本作为不可信参考；两者不能无损互换。spawn 不继承上下文，仍需 btw 自己提供快照。
- 可续 subagent 的发送与恢复依赖父子关系；无工作区的全局临时聊天没有父会话。官方 `dispose()` 释放 activation，并不提供 btw 所需的会话文件删除保证。

因此不为了复用名字相似的 API 而改变隐私、上下文授权或清理语义。若将来 dsh 提供无父、可配置上下文和明确删除能力的公开临时会话接口，应重新评估。

## 核对入口

- `@deepseek-ai/dsh-subagent/README.zh.md`：本地与外部子级、消息/中断、activation 结算及父会话 catalog。
- `@deepseek-ai/dsh-subagent/lib/types/index.d.ts` 和 `child-agent.d.ts`：`startActivation`、请求类型及权限辅助函数。
- `@deepseek-ai/dsh-agent/lib/types/index.d.ts`：`agents.create` 和 `AgentHandle.dispose`。
- [临时聊天存储边界](temporary-chat-storage.md)：版本绑定、删除和异常恢复约束。
