# btw 交接记录

更新：2026-11-10（本机时间）。本轮实现、测试和独立验收已完成；**后续由用户接手，不自动追加功能或重启服务**。

## 1. 当前状态

- 仓库：`/home/luyu/dsh-plugin/btw`，分支 `main`。
- 交接文档提交前的 HEAD：`4b4163b`；工作树干净。
- npm 版本仍是 **`0.0.3`**，没有发布、没有 bump、没有 push，也没有合并远端 PR。
- 本机 web profile 使用 `link:/home/luyu/dsh-plugin/btw`；npm 上同版本不含本轮本地改动。
- 目标任务 7/7 完成，独立审计最终通过。没有遗留的实现代理或待完成开发任务。

### 相关提交

| 提交 | 内容 |
| --- | --- |
| `e2a0624` | 核心实现：上下文、模型、临时聊天、草稿送回、安全清理、测试与设计对照 |
| `d3df3b6` | 旧宿主 `unknown method: models` 的明确提示、重试及错误分类回归 |
| `4b4163b` | 用户授权重启后的真实服务验证记录 |

本文件另以独立文档提交保存；最新提交 ID 可用 `git log -1 --oneline` 查看。

## 2. 已交付能力

- 新开对话页**右上角**临时聊天入口；无工作区可直接使用灰色独立聊天，不显示来源继承/当前父模型，不加载文件或命令工具。
- 会话内侧问、临时聊天、弹窗/右侧栏；收起或切换视图保留同一对话，显式结束才等待清理。
- 上下文：无、最近对话、按需搜索最近快照、全部已记录对话。
- 模型：宿主默认、来源会话当前模型、自选模型；侧问和临时聊天有各自默认设置。
- 多选消息送回来源会话草稿，保留已有内容、不自动发送；来源及修订不匹配则拒绝插入。
- 统一 G2 圆角；单层输入；模型 → 上下文 → 发送；深浅色及窄屏检查。
- 默认 JSONL 临时目录归属校验、先登记、等待停止写入后删除、失败保留恢复记录、启动恢复。

## 3. 架构与文件入口

先读 [architecture.md](architecture.md)，不要重新大改已验证架构。

| 文件 | 职责 |
| --- | --- |
| `lib/client.js` | 零 build 的 ModuleLoader 前端；视图、设置、请求代次、单轮轮询、完整历史分页/缓存 |
| `lib/index.js` | `/btw` RPC、模型解析、子 agent、超时/输出限制、安全存储生命周期 |
| `lib/context-search.js` | 在授权最近文本快照中执行有界只读字面检索 |
| `test/` | 协议形状、竞态、缓存、草稿与存储故障回归 |
| `scripts/smoke-isolated.mjs` | 隔离、无模型的真实宿主与物理清理验证 |
| `scripts/smoke-model.mjs` | 显式指定已有 glm 配置/凭据，仅发送合成问题的真实模型验证 |

关键约束：`presentation` 不等于会话生命周期；`closeTemp` 是唯一释放入口；开启 attempt 固定连接归属；每轮 poll 串行且有独立 token。近期正文来自 `useChat(s => s.legacy)`，完整历史使用显式注入的 `remote.session.events`，模型容量来自 `resolveModelInfo(...).context.contextWindow`。

## 4. 验证结果

详见 [verification.md](verification.md)；原批注对应 [design-acceptance.md](design-acceptance.md)，截图在 `docs/verification/screenshots/`，可编辑画板与原批注在 `docs/designs/btw-context-and-model/`。

- `npm run check`、**78 项测试**、`git diff --check`：通过。
- 隔离真实宿主 smoke：认证、工作区/无工作区创建、轮询、关闭、文件/记录删除、哨兵保留及延迟复查通过。
- 真实 `glm / glm-5.3-flash`：none/recent/on-demand/all、超过 48k 的旧文本证据、同前缀第二问、临时两轮及退出清理通过。
- 冻结后真实浏览器：入口、上下文/当前模型、停靠后承接、两条消息送回且保留原草稿、设置持久化/开关、视图共享、窄屏顶层遮挡修复及深浅色通过。
- sol/terra 交叉复验发现的问题已有回归闭环；Astra 收束架构与单项修复，主代理核验实际文件和运行结果。
- npm dry-run：8 个文件，压缩约 36KiB；设计、测试、脚本、CI 和截图不进 npm 包。远端 CI / Node 24 尚未运行。

快速离线回归：

```sh
cd /home/luyu/dsh-plugin/btw
npm run check
npm test
node scripts/smoke-isolated.mjs
git diff --check
```

真实模型脚本会发送请求，按需要显式运行；不打印或提交凭据：

```sh
node scripts/smoke-model.mjs \
  "$HOME/.dsh/profiles/web/cordis.patch.yml" \
  "$HOME/.dsh/.credentials.yaml"
```

## 5. 当前用户服务：保持运行

用户已明确授权重启并检查，**不是遗留测试服务**：

- 地址：`http://127.0.0.1:3080`。
- PID：交接时为 `3299386`，启动于 2026-11-10 11:29；原参数 `dsh web`，工作目录 `/home/luyu`，保留原进程环境。
- 启动日志：`/tmp/btw-authorized-web-XHasE6/web.log`，启动令牌已脱敏；不要把日志或凭据库直接复制进提交。
- 真实服务已认证 `POST /btw/models` 返回 HTTP 200、正确 RPC envelope，包含 `glm/glm-5.3-flash`。
- 本次真实服务检查没有读取会话正文、调用模型或删除会话文件。两轮/删除测试仍在隔离目录完成。

`unknown method: models` 原因是旧宿主进程早于代码更新启动：前端刷新不等于宿主更新。该旧进程已正常停止，新进程已验证。用户接下来刷新原页面即可；本轮不再停止服务。

以后若需要停止上述 PID，先用 `ps -p 3299386 -o pid,lstart,args` 确认身份，不能照抄过期 PID，更不要使用 `pkill -f "dsh web"`。实际再次重启前需确认用户任务已结束。

## 6. 已知限制与后续处理边界

- 全部对话只含指定来源切点的已记录用户/助手/工具文本，不含未提交生成文字及附件二进制。缺页、超过 1Mi 文本或保守模型容量预算直接拒绝，不静默截断。
- 本地缓存有界并按连接/来源/cursor 失效，问题放在稳定历史前缀之后；**未确认远端 provider 缓存命中率**，不要把本地命中或稳定前缀说成远端命中。
- on-demand 是有界字面检索，不保证语义召回；过窄短语可能未命中，不代表完整历史不存在相关内容。
- 临时清理仅支持已核验的 **Linux / dsh 0.2.2-rc.1 默认 JSONL**。未知/自定义后端拒绝，逻辑删除不等于安全擦除；旧不可信 marker 不会猜测删除。见 [temporary-chat-storage.md](temporary-chat-storage.md)。
- 同用户恶意并发替换路径的理论 TOCTOU 风险已说明并被接受；不能宣传为 OS 沙箱或“绝对无痕”。
- 所属隔离测试进程、浏览器、合成会话与凭据副本已清理；原画布和用户批注保留，不替用户删除。

接下来由用户试用/决定 push 或发布；本轮没有发布计划。后续若有具体 bug，先固定一条最短复现、核对实际安装版 API、加回归再修复，不再并行堆功能或重写整个架构。真实会话正文与破坏性清理测试仍是边界，后者只在隔离 HOME/DSH_HOME 中进行。
