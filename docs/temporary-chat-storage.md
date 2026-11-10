# 临时聊天：存储与退出清理

## 范围

当前适配器只识别 Linux 上 dsh `0.2.2-rc.1` 的默认 JSONL 实现。它绑定了安装版 `dsh-session-persistence-jsonl`、`dsh-agent-loop`、`dsh-home-paths` 的版本及运行时后端标识；不是通用删除 API。自定义根目录、未知后端和其他版本会在创建前拒绝临时聊天，侧问仍可使用。

默认根目录由活动安装的 `dshHomePath("sessions")` 获取，不猜测 home：

```text
$DSH_HOME/sessions/<project-key>/<uuid>/session.v4.jsonl[.zstd]
$DSH_HOME/.btw-temp-records/<uuid>.json
```

临时会话有工作区时使用其明确路径；没有工作区时保持无 cwd，仅加载文本 persona，不加载 bash/fs 工具，不回退到用户 home。

## 原生普通 Session（显式启用）

无来源 btw 可选用 DSH 原生普通对话页：`/btw nativeOpen` 创建 btw 独占的普通 root Session，前端用公开 `uiWorkspace.openSession(id)` 打开完整原生 conversation（composer、`+`、权限/模型选择、思考与消息渲染均由宿主提供）。路由由插件启动时自动绑定（内存合并，绝不写用户配置）；用户显式路由到其他 backend 或 gate 未绑定时 `nativeOpen` 明确报错拒绝创建，前端显示错误，不创建临时会话，旧 ask/open 协议保留可用。

创建前必须先对本人 UUID 落持久拒写标记（pre-create tombstone，gate 对本人 UUID 的 `session_projcache` 写入拒写、其他 key 透传），再创建 Session，因此投影缓存从不落盘。优先使用当前 Session 所属工作区并仅挂接本人 Session；无工作区时 cwd 是独占空目录，并为该目录建立专属 WorkspaceRegistry 注册 + `attachSession`。不从 HOME 或启动 cwd 猜测工作区：

```text
$DSH_HOME/.btw-native-deny/<uuid>.json            # 永久拒写墓碑（按设计保留，不回收）
$DSH_HOME/.btw-native-records/<uuid>.json         # 原生会话恢复记录
$DSH_HOME/.btw-native-workspaces/_no-cwd/<uuid>/  # 独占空 workspace（原生 cwd）
$DSH_HOME/.btw-native-workspace-records/          # workspace 注册/意图 sidecar
```

`nativeClose` 需要 `{sessionId}` 且必须返回 `burned: true`。关闭顺序：拒写标记 retain → `dispose` → `whenIdle` → 删本人 JSONL 与空目录 → 移除专属 workspace 注册（先注册后目录）→ 删恢复记录 → 只清理本人 archive/pin 条目。隔离浏览器实测：关闭后 session 目录、project 目录、workspace 目录、records 全无，workspace registry 回到空，只剩 `.btw-native-deny/<uuid>.json` 永久墓碑；临时 workspace 打开期间作为「btw」分组出现在宿主工作区列表，关闭即消失。算法与实证见 [原生清理算法](native-cleanup-algorithms.md)。

不承诺：不是 OS 沙箱（普通 preset 权限策略仍适用）；共享附件 blob 不删；不做安全擦除；不保证绕过 gate 的写入；跨进程互斥/并发宿主/断电等场景未覆盖。验证：`npm run check`、`npm test`（198/198）、`git diff --check`、`scripts/native-cache-backend-probe.mjs`、`scripts/native-cache-cross-process-probe.mjs`、`scripts/smoke-isolated.mjs`、`npm pack --dry-run`（15 files）均通过；隔离 Web 宿主实测打开→原生发送→回答→结束→无残留。

## 创建与清理

1. 校验默认后端、根目录、祖先及符号链接；用随机 UUID 独占创建叶目录。
2. 创建 agent 前持久化独立、不可变的 version 2 恢复记录，包含默认 root、目录 dev/ino、进程 boot ID/PID/start ticks。先写临时文件并 fsync，再以独占 hard link 发布；不共享数组 marker。
3. 创建完成交叉核对 persistence stat 的会话 ID、cwd 和可用的 JSONL location。pending session 可能尚无 location；只有独占预留且身份未变的目录可作为删除依据。
4. 显式结束时同步禁止新消息，取消按需检索，等待 `handle.dispose()`、发送任务及持久化关闭。然后重新校验后端、路径和目录身份，拒绝符号链接与特殊文件，只删除自有 UUID 目录。
5. 确认目录不存在并同步父目录后，才移除恢复记录、返回 `burned: true`。dispose、校验或删除失败会保留记录并报告错误；用户可重试关闭，不会继续向失败会话发送。
6. 创建失败也经过关闭/删除屏障。插件卸载先等正在创建的任务结算，再逐一清理；不会用固定延迟假定写入停止。

启动恢复只处理格式和目录身份有效、所属进程已经死亡且当前未被 agent 持有的记录。Linux boot ID 与进程启动 ticks 用于避免 PID 复用。无法判定存活状态、破损记录和旧 `.btw-temps.json` 均保留，不猜测删除。

弹窗/侧栏切换或收起仅改变视图，不销毁会话；显式结束或退出临时模式才触发清理。进程突然终止可能留下临时文件，需后续有效实例完成恢复，因此不能承诺“从不落盘”或“绝对无痕”。

## 安全边界

- 删除范围只有插件独占预留、记录且身份一致的临时 UUID 目录，绝不删除整个项目、sessions 根或普通会话。
- 检查不等于抵御同权限攻击者。用户已接受同用户恶意并发替换父目录的理论 TOCTOU 风险。
- 逻辑删除不等于介质安全擦除，不保证消除模型服务、宿主日志、备份或工具输出中的副本。
- 有工作区时工具属于用户明确的项目访问能力，不是 OS 沙箱；无工作区不会悄悄启用文件访问。

## 验证

`test/host-features.test.js` 使用隔离存储及故障注入，覆盖 dispose/创建/登记/删除失败、并发 close/send、pending 无 location、目录替换、后端更换、未知版本、PID 复用、恢复与普通会话哨兵。

`node scripts/smoke-isolated.mjs` 启动真实安装版宿主，仅在临时 HOME/DSH_HOME 验证认证围栏、工作区/无工作区 open/poll/close、物理文件与 version 2 记录删除及延迟复查；不调用模型。Node loopback 网络守卫不是 OS 网络沙箱。

真实模型联调与浏览器验收分别记录，不以 mock 测试代替。
