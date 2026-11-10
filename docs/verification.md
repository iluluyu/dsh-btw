# 本地验证记录

## 环境与边界

- Linux，Node `26.12.1`，安装版 dsh `0.2.2-rc.1`。
- 使用临时 HOME、DSH_HOME、工作目录与独立 web profile。不读取或删除真实用户会话，不改真实 profile。
- 复用已配置的 `glm / glm-5.3-flash` 路由，仅发送合成问题。目标凭据单独提取到权限 0600 的隔离文件，不打印密钥；验证结束清理所属进程及临时目录。
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
- 原生设置页将 all、custom glm 模型及 temp recent 默认值写入隔离 profile；关闭侧问按钮开关后来源页按钮消失，临时入口仍在。重启后 temp recent 默认值仍生效；全局聊天仍强制无父上下文。

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

用户明确选择“现在重启并检查”，授权短暂断开原 `dsh web`，同时限定只检查模型列表、不读取会话正文、不在真实存储中做删除测试。已在 2026-11-10 11:29（本机时间）向原 PID 2630010 发送 SIGTERM 并等待正常退出，然后使用原 Node 可执行文件、原 `dsh web` 参数、原 `/home/luyu` 工作目录及原进程环境启动 PID 3299386。未强杀、未改用户 profile 或模型设置。

**当前实际用户服务 `http://127.0.0.1:3080` 的已认证 `POST /btw/models` 成功：** HTTP 200，RPC envelope 的 `rpcId` 匹配且 `result.ok === true`；返回目录包含 provider `glm` 的 `glm-5.3-flash`。不再是 `unknown method`。新进程随后仍正常运行。

本次实际服务检查：会话正文读取 0、模型调用 0、会话删除 0；认证令牌和 Cookie 只在检查进程内存使用，不输出到工具结果，保留的启动日志已脱敏。已提示用户刷新页面；不为了额外浏览器截图而打开可能呈现私人会话的页面。真实两轮聊天、浏览器交互和退出清理的证据仍采用上文隔离环境结果，以遵守已确认的隐私/清理边界，而不是扩大重启授权。

## 已知边界，不作超额承诺

- 全部对话是指定来源切点的已记录用户/助手/工具文本，不含未提交输出和附件二进制。缺页、超过 1Mi 文本或保守模型容量预算会明确拒绝，不静默截断。
- 本地历史缓存有界且按连接/来源/cursor 失效；重复请求使用稳定前缀，问题在末尾。btw RPC 未暴露 provider cache-read usage，因此**没有确认远端缓存命中率**。
- 临时存储仅支持已核验的 Linux / rc.1 默认 JSONL，未知或自定义存储在创建前拒绝；逻辑删除不等于安全擦除。详见 [存储边界](temporary-chat-storage.md)。
- Node loopback 守卫不是 OS 网络沙箱；有工作区的工具不是 OS 文件沙箱。无工作区模式不挂载文件/命令工具。
