# 原生普通 Session 阅后清理：算法与实证（rc.1）

## 最小建议与用户可感知语义

**能打开真正的 DSH 普通对话页，且已按显式启动路由接入产品。** btw 持有普通 root Agent，客户端 `uiWorkspace.openSession(id)` 的正向路径此前已验证，见 [输入框边界](native-composer-boundary.md)。后续隔离研究已启动完整安装版 Web 并通过真实 Agent/HTTP + 本地合成 adapter 测试，见 C；产品接入现状见 C 首节的「产品接入（nativeOpen / nativeClose）」。在默认宿主（未启用路由）中，仍不能承诺“退出后直到宿主退出都不再出现任何会话数据”。

当前约束下，启用路由后能支持的最小语义是 **“创建前拒写门（本人 UUID 的投影缓存在 JSON writer 之前被拒写，从不落盘）+ 本人 JSONL / 独占 workspace / 恢复记录清理 + 永久墓碑”**，不能作为完整阅后即焚上线；宿主内存、其他客户端、绕过 gate 的写入与共享附件 blob 不在保证内。默认宿主未启用路由时，`nativeOpen` 明确报错拒绝创建，无来源入口显示错误，不创建临时会话。以下墓碑/缓存清扫算法设计描述其推理与前提：

1. 创建前持久登记独占 Session；结束时先持久化墓碑，再禁止 btw 自己继续发送。
2. 释放本客户端 scope、停止本人任务、等待本人 Agent dispose 和已知持久化关闭，按[现有 rc.1 规则](temporary-chat-storage.md)删除独占 JSONL。
3. 保留墓碑并报告缓存清理尚无受支持接口。**不得通过 diagnostic `DomainFacility.get()` 借用宿主 domain 后删除 projection row**：方法可调用不等于取得宿主拥有的写入权限。只有获得明确受支持的宿主清理 capability，或在启动前通过公开扩展合法拥有 backend 生命周期后，才讨论缓存精确清扫与恢复。**列表/JSONL 消失不表示缓存已永久删除**；缓存可能短暂重现，其他客户端/在途请求/JS 引用仍可能持有内容。
4. 不允许把一次扫描为空、固定等待或当前 table.delete 成功标为“全部清理完成”。默认部署最多承诺“本人日志已删除，宿主缓存不保证删除”；不能在没有受支持清理能力时宣称“缓存持续清理中”。只有额外清理能力获支持且满足下文静默前提后，才讨论 eventual cleanup。

**单路径文件系统哨兵不采用。** 实测目录哨兵可以阻止本记录最终 publish，且本次普通失败没有破坏其他 Session 或全域扫描；但它改造的是宿主私有缓存布局，atomic writer 仍先生成含内容的共享目录临时文件，崩溃可留下无法安全归属的匿名文件。既不满足即时无残留，也不在已接受的 JSONL 独占目录删除范围内。

若产品必须无上述降级，不应启用该路由；无来源入口不可用。产品实现见 `lib/native-cache.js`（拒写门 backend）、`lib/native-cache-workspaces.js`（专属 workspace 注册）与 `lib/index.js`（`nativeOpen`/`nativeClose`）；本报告未修改用户宿主配置，路由由用户显式添加。

## 可行性等级

| 方案 | 活跃宿主中即时保证 | 失败恢复 / 限制 | 判定 |
| --- | --- | --- | --- |
| 原生普通页 + dispose + 一次 delete | 不能；已确定性复现复活 | 无持久墓碑则漏删 | 不满足强语义 |
| flush / 插件本地 epoch / listener 门闩 | 只能约束本人调用；不能拦住全部 producer | 冷读与其他客户端绕过 | 不满足强语义 |
| 墓碑 + 精确清扫 + 通知/周期复核 | 有暴露窗口，不保证无宿主内存残留 | 还需明确受支持的 cache 清理权限；当前未具备 | **条件算法，当前不能宣称可实施完整清理** |
| 本记录目录哨兵 | 阻止 final record，不阻止临时文件/旧内存 | 正常重开实验通过；进程中断仍有洞 | **按本任务约束排除** |
| 公开 backend 扩展 + 每 key 持久拒写门 | pre-create 独占 UUID 的单进程隔离原型通过；不清全部内存 | 真 CLI 自身 bundle 路由通过；多宿主锁与 crash 未覆盖 | **已按显式启动路由接入产品（nativeOpen/nativeClose）** |
| session-local storage / 独立进程 | 当前宿主无已验证的逐 Session 全链路隔离选项 | 独立宿主可隔离，但不是原宿主普通页的透明替换 | 不作现成功能承诺 |

“即时保证”特指返回清理完成以后，在宿主仍活跃期间不再产生该 Session 的受管持久副本；不是内存安全擦除，也不是从未落盘。后台继续执行清扫是 eventual，不是即时。

## 范围、方法、证据来源

仅 Linux 安装版 `0.2.2-rc.1`，默认 JSONL 与 per-record JSON cache。源码只读；最初反例实验新建 `/tmp/btw-native-cleanup-*` 并设置隔离 HOME、DSH_HOME、XDG 路径，使用本地 projection/flush adapter，无 HTTP 或运行服务。C 的后续实验另用 `/tmp/btw-native-backend-*`，新增完整 Web、真实 root Agent 和 localhost HTTP，只有 LlmAdapter 为本地合成实现；没有凭据、供应商请求或宿主 monkey patch。本次按源码定位 → 可证伪算法 → 门闩实证 → 不变量/反例组织；关键脚本经独立复核。

以下包路径均相对安装包公共依赖根：

```text
<dsh 安装根>/node_modules/@deepseek-ai/
```

- **P1** `dsh-session-projection-cache/lib/index.js:263–292`：write 先取 checkpoint、markClean，再等待 sessions.flush，最后 put；coldSnapshot 对调用者已持有的 events restore，fire-and-forget put，无墓碑检查。
- **P2** 同文件 `:295–357`：disposed listener 调用 flushSoft 但不 return 其 Promise；清 timer/dirty 不等于排空异步 producer；put 会 detached-copy rows。
- **P3** `dsh-session/lib/index.js:1900–1995`：detach 从 store 删除引用并发通知；session/created、disposed 不是 cache-write join。flush 等待 durability listeners，但不等待这些 listeners 外部、尚未排进 domain 的后续操作。
- **P4** `dsh-storage-domain/lib/index.js:110–310`：domain 单写链，durability 后更新内存再发 domain/changed。普通失败链会继续；unknown-state 才隔离整个 domain。delete 发现当前内存没有 key 就直接 false，不访问磁盘。
- **P5** 同文件 `:346–445`：DomainFacility.get 的文档明确为 **Diagnostic surface**；typed consumers 持有自己 open 得到的 handle。get 虽暴露现有 domain，不等于向旁观插件授予对宿主 domain 的受支持写入权限。再次 open 同名 domain 拒绝，因此不能通过重新 open 合法取得同一个宿主 handle。routes 按 domain 名，不是按 Session；close 是整个 domain 生命周期，不能为一个 Session 关闭共享 domain。
- **P6** `dsh-storage-json/lib/index.js:25–45,350–451,477–600`：writer 先写同目录 `.<randomUUID>.tmp`、fsync，再 rename 到 `<key>.json`。loader 遍历 `.json`，readRecord 吞读失败；delete 先 rename 为 `.json.deleting` 再清理，失败恢复不确定时可进入 unknown-state；backup 为 `.json.bak.<stamp>`。JSON backend 自身不提供跨进程同 key 写入屏障。
- **P7** `dsh-storage/lib/types/index.d.ts`：backend.register / backend service key 是公开扩展点；routing 需在 domain open 之前配置，不能把运行中的私有对象替换/修改当公开方案。
- **P8** `dsh-attachment-local/lib/index.js:296–298,416–459,498–556`：附件用 hash 寻址，共享对象、暂存与硬链接发布，不由 Session 的 UUID 目录独占。禁止直接按引用删 blob。

## 确定性隔离实验（已完成）

命令：`node /tmp/btw-native-cleanup-probe.mjs`，退出码 **0**。脚本和数据均在本次结束删除；完整脚本附本文末，可重新提取到 `/tmp` 运行。使用真实安装包 SessionProjectionCache、DomainFacility、JsonStorageBackend，假的只是本地合成 projection 与带 Promise 门闩的 sessions.flush。没有替换宿主方法。

```text
PASS delayed flush producer restores row after awaited delete (explicit gate, no sleep)
PASS table delete evicts current map, but previously held JS record still contains synthetic content
PASS coldSnapshot after delete restores row (local projection adapter; not external HTTP route proof)
PASS independent domain map can restore disk row; missing-key delete in first map does NOT remove it
PASS directory sentinel blocks own publish; ordinary failure does not poison shared write queue; no temp remains after handled failure
PASS reopen/global scan skips directory sentinel, other session survives and next write succeeds; table delete does not remove absent sentinel
NOTE crash during writeAtomic temp-before-rename not injected: source shows anonymous shared-directory temp can survive SIGKILL
CLEANED isolated HOME/DSH_HOME/storage root
```

### 1. 删除屏障与引用反例

用 entered/release 两个 Promise 控制 flush：`write(A)` 已 snapshot 内容但停在 flush → `await table.delete(A)` 已返回 → release flush → `await write(A)` → 磁盘与 table 都重新有 A。**无 sleep、无概率竞争**。增加一次 flush 或两次 delete 不能改变这个反例：最后一次 delete 后仍可能有一个尚未排队的 producer。

随后删除 row，但保留之前 `get(A)` 返回的 JS 对象；对象仍有文本。table 删除能释放自己 Map 的引用，不能撤回已经返回给别人、checkpoint 闭包、pending response 或客户端的对象。dispose / release 不是 JS 字符串擦除 API，GC 时机也不是删除完成证明。

coldSnapshot 在 delete 后按本地 adapter 写回，也通过 domain/changed 精确等待完成。**这是组件级证据，不声称重现了真实外部 HTTP 路由的调度**。源码上的完整 events 参数已足以构成外部调用者持有事件的反例。

### 2. 多宿主 / 多客户端

两个独立 DomainFacility + backend 指向同一隔离目录（模拟两个进程的独立内存，不是实测两个 OS 宿主）：第二个打开时持有 A；第一个 delete 后第二个仍读得 A，并能 put 恢复磁盘。第一个 Map 已无 A，重复 table.delete(A) 返回 false，**磁盘残留不消失**。因此仅用本进程 domain/changed 和 delete 的恢复器不充分。

同一宿主多个浏览器也能保留已读内容或发新请求。插件本地 closed/epoch 只能约束 btw RPC；原生普通页另有发送/上传/权限操作路径。未找到覆盖全部读取、恢复 Agent 和 checkpoint 的公开 per-session 拒绝门；不能以隐藏入口、取消自己请求或收到 disposed 事件当作全客户端撤销。

### 3. 本 Session 文件系统哨兵

实验先用 table.delete 清掉本人 row，再 `mkdir(<A>.json,0700)`。cache.write(A) 在 rename 阶段失败；后续其他 B 的 put 成功、内存与磁盘正确，普通错误未将 domain 隔离。正常失败 catch 清掉了临时文件。关闭/reopen 同一 domain 后扫描跳过该目录，B 正常、C 仍可写；A 不在内存，因此 table.delete(A) 也不移除哨兵。

**通过的只是上述路径，不是方案可用性认证**：

- mkdir 与旧文件清理不是公开的 per-session cache capability，而是宿主私有路径干预；只校验本人 UUID 仍不能使这个机制成为公开接口。
- 内容先写在共享 `sessions/.<randomUUID>.tmp` 中，然后才撞目录失败：失败处理前有暴露窗口；SIGKILL 不执行 catch，tmp 可能长期残留。名字不带 Session ID，不能在共享目录按通配符删除，也不能只凭内容猜测归属。
- 预置只读普通文件或 symlink 不能阻止 rename-over-target；FIFO 有扫描阻塞风险，不测试/不采用；禁止 chmod/替换共享父目录、immutable 属性或全域不可写。把 target 换成目录虽然有效，但并不隔离 temp。
- 其他进程可能仍有旧 row，或执行 delete/backup 把哨兵移走。若 delete 的恢复失败为 unknown-state，影响的是整个 domain；不能推断“所有文件系统故障都 fail-soft 且仅影响本人”。
- 正常 reopen 实验通过；**真实进程死亡/电源中断/文件系统 I/O 故障下的哨兵与恢复：未验证**（未注入）。crash 缺口由 P6 的明确 publish 次序推出，不冒充崩溃实证。
- **哨兵与其他进程并发 delete/backup 的交互、unknown-state 跨会话影响：未验证**；不从普通失败路径推断这些故障也安全。

结论：按用户约束排除，不建议为了上线尝试更多私有 FS 干预。

## 算法比较及证明义务

### A. 同步屏障 / epoch

理想算法需要在同一线性化点完成：拒绝新读写 → 等待全部已准入操作结算 → 驱逐所有 row/引用 → 删除。若所有 cache producer 都在 `put` 前核对共享 epoch，旧 epoch 操作可以拒绝；rc.1 默认 producer 没有这项核对（P1、P2）。btw 自己计数的 inFlight 不包括 native API、cold readers 和其他进程。session/flush 是日志 durability，不是 cache producer admission。domain.close 可拒绝后续 enqueue，但关闭所有 Session 的 cache，违反约束。

**不变量缺口**：不能证明“返回之后没有仍被许可的 producer”。无论循环次数或等待多久，这个安全性证明不成立。

### B. 持久墓碑 + 精确清扫（需额外受支持清理 capability）

状态机：`owned → closing → log-removed/cache-pending → quiescent-cleaned`；失败保留 closing/pending。墓碑不存正文，含随机 UUID、backend/version/root 与目录身份、owner boot ID/PID/start ticks、清理阶段；发布与更新用临时文件 + fsync + 独占发布/安全替换 + 父目录 fsync。先有恢复记录再创建 Session，关闭时先落墓碑再执行破坏性动作；仅标记内存不算 crash recovery。

清扫步骤：

1. 在创建/关闭流程中序列化本人 open/send/close，禁止本人新发送，等创建结算；取消、等待本人任务与 handle.dispose；验证默认 JSONL 和本人独占目录，执行现有安全删除并 fsync。失败保留记录，不重新允许发送。
2. **当前不能执行宿主 cache row 删除作为受支持插件算法。** `storageDomain.get('session_projcache')?.table('sessions').delete(id)` 只是可调用的诊断对象路径，不是宿主所有者授予的清理 capability；本报告不认可用它写入、删除或关闭宿主 domain。上述组件实验对测试自己 open 的 handle 操作有效，但不能据此推出 btw 获得生产宿主 handle 的写入授权。若未来提供明确的 per-session cache delete capability，再要求其排空已入队写并驱逐本人 row；依然不够解决尚未入队的 producer。
3. **仅在前述清理 capability 获明确支持后**，才可监听 domain/changed 的本人 put 后再排一次合法 delete；事件订阅权限本身不授予删除权限。注意事件发生在 durable write 后，因此已经有暴露窗口。另用周期/启动/恢复复核补偿丢通知；watch 只作 wakeup，不作屏障，需处理 overflow、目录重建与自身事件循环。
4. 对磁盘已存在但本 Map 缺失的 row，公共 delete 是 no-op（实证）。若不另获明确授权的、版本绑定的 cache 精确路径适配，**不能宣称清掉该类磁盘残留**。即使获得适配，也只能清所有权可验证的本人 `.json`、可归属 `.json.deleting` / `.json.bak.*`，不碰共享匿名 `.tmp`；没有充分依据则保留 pending 并报错。
5. owner 死亡用 boot ID/PID/start ticks 判断，未知/权限失败不猜死；恢复 claim 用独占文件和身份校验避免多个恢复器互相删除。清理普通 Session 哨兵数据必须保持不变；不扫真实用户会话以猜测归属。
6. active owner 的 pending 墓碑不因“一次空扫描”删除。owner 重启后先恢复再允许新的本人临时会话；旧写者全死、已知目录无残留且父目录已同步，才可结束对应受管范围的恢复。外部仍有 writer / reader 时不能宣称终态。

**安全不变量**：只删除持久所有权记录证明属于自己的工件；共享 blob、匿名 temp、陌生文件不删；失败不丢墓碑。

**活性前提**：最终某时刻所有读写 producer 停止，权限/存储恢复，恢复器继续运行且能够枚举全部受管工件。还必须先有明确受支持的 cache 清理 capability/适配授权；diagnostic get 不满足此前提。在这些前提下，有限残留可由最终一次成功扫描删除，得到 eventual cleanup。无限 cold read、其他活宿主持有 row、无恢复器运行、匿名 temp 无法归属或永久权限失败，都使全量收敛承诺不成立。定时器只是重试调度，绝不作为完成屏障。

**可报告完成的粒度**：本人 JSONL 删除确认可独立报告；当前条件下不能报告已合法清除宿主 cache，更不能报告“所有副本已删”。即使未来拿到合法 capability，row 删除也只能报告瞬时状态。清理失败或能力缺失须明确显示，不把关闭按钮已消失等同 burned。

### C. 公开 backend 扩展：已接入产品

公开 registry / routing 允许在 **domain 首次打开前** 将 `session_projcache` 路由到 btw 提供的 backend，底层仍委托 JSON，只对有本人有效墓碑的 key 拒写，其他 key 原样代理。这不是替换运行中对象，不必改宿主源码，也不等于全局禁缓存；**routing 会影响该 domain 的所有 Session 的 backend 路径，只是不关闭其他 Session 的缓存**。改变启动 composition 是额外部署条件：产品 bundle 只注册 backend，绝不覆盖用户配置，路由必须由用户显式添加。

#### 产品接入（nativeOpen / nativeClose）

- **启用**：在启动配置中保留用户**完整** `storage-domain` 配置（含 `backend` 与已有 `routes`），仅添加 `routes.session_projcache: btw-native-json` 后重启宿主（rc.1 的 patch config 是整体替换，无深合并）。未绑定 gate 或路由被覆盖时，`nativeOpen` 明确报错拒绝创建；旧 ask/open 协议保留可用，前端显示错误，不创建临时会话。
- **创建**：`nativeOpen` 接受 `{}` 或 `{workspaceId}`。指定已有工作区时，以公开 registry 验证身份并使用该工作区 cwd，创建独立 root Session；只挂接自己的 Session，不复制来源历史或草稿。未指定时使用独占空目录 `$DSH_HOME/.btw-native-workspaces/_no-cwd/<UUID>` 和专属 workspace 注册。两种方式都先核对 UUID 全新并在任何 Session 存在前落持久拒写标记，再由 `agents.create()` 创建普通 root Session 并调用 `attachSession`。
- **关闭**：`nativeClose` 需要 `{sessionId}` 且必须返回 `burned: true`（未确认 burned 视为失败）。关闭时先保留拒写标记并等待 Agent dispose/idle，再清理本人 JSONL 和 workspace 成员关系；已有工作区仅 detach 本人 Session，不删除用户目录或其他会话。专属 workspace 则移除注册和独占目录，最后清理本人恢复记录与 archive/pin 条目。
- **残留边界**：隔离浏览器实测，关闭后 session 目录、project 目录、workspace 目录、records 全无，workspace registry 回到空，只剩 `.btw-native-deny/<uuid>.json` 永久墓碑（按设计保留）；临时 workspace 打开期间作为「btw」分组出现在宿主工作区列表，关闭即消失。
- **不承诺**：不是 OS 沙箱（普通 preset 权限策略仍适用）；共享附件 blob 不删；不做安全擦除；不保证绕过 gate 的写入；跨进程互斥/并发宿主/断电等场景未覆盖。
- **验证**：`npm run check`、`npm test`（198/198）、`git diff --check`、`node scripts/native-cache-backend-probe.mjs`、`node scripts/native-cache-cross-process-probe.mjs`、`node scripts/smoke-isolated.mjs`、`npm pack --dry-run`（15 files）均通过；隔离 Web 宿主实测打开→原生发送→回答→结束→无残留。

研究脚本：`scripts/native-cache-backend-probe.mjs`；真实 CLI fixture：`test/fixtures/native-cache-backend-host.mjs`。以下为本轮新增记录，区别于前文已删除的 `/tmp` 反例脚本；研究阶段未接入 `lib/` 或修改用户配置，产品接入（`lib/native-cache.js` 等）见上节。

#### 启动路由与配置优先级（rc.1 实查 + 真 CLI 验证）

- `dsh-base/cordis.patch.yml` 的 `storage-domain` 默认 `config.backend: json`，cache 服务在 `Service.init` 首次 open `session_projcache`。`storage-domain.apply` 会等待 **默认 backend 及所有 routes backend 的 lifecycle service key**，故新插件需先 `storage.backend.register('btw-research', backend)` 再提供 `storageBackendServiceKey('btw-research')`。
- `dsh/lib/profile-boot-*.js` 和 `dsh-app-boot/lib/index.js:1899–1921`：全部 bundle patch（manifest 顺序）→ profile patch → HOME patch → CLI `--patch`（参数顺序）→ telemetry 环境开关；先合成 entry tree，再激活插件。**后加入的 bundle 可以用自己的 patch 覆盖 `storage-domain` 的 config**，不要求手改用户 profile patch 才能路由。本轮真实 CLI 使用隔离 custom profile，base bundle 插入安装版 storage/domain/cache，扩展 bundle 自己插入 backend 行并设置 route；profile/HOME/CLI 仅覆盖 fixture 的 precedence 哨兵，route 不在这些用户层中设置。宿主 readiness 后断言拿到 `cli-last`。
- **config 整体替换，不是深合并**（`cordis-plugin-include.applyPatches`）。第一次只给 routes 的实验确实失败，丢失必需的 backend；修正为完整 `{ backend: 'json', routes: { session_projcache: 'btw-research' } }` 后真 CLI 通过。生产已有其他 routes 时必须保留完整配置；固定 bundle patch 无法自动安全合并未知用户 routes。后续 bundle/profile/HOME/CLI 覆盖成默认 route、未知 backend、禁用该插件，均不能承诺屏障；必须拒绝创建临时会话而非静默降级。
- **仅 insert/register 不足以生效**；产品 `cordis.yml` 有意只 insert 并注册 backend，不覆盖用户 `storage-domain` 配置，因此默认产品仍不受该门保护。路由由用户按 README 显式添加并重启；缺失时 `nativeOpen` 报错拒创，前端显示错误。运行中注册新名字不会迁移已 open domain；没有受支持的热替换/逐 key route。已启动的默认宿主、旧 writer 不经 wrapper、或无法控制最终 startup composition 时，不可作此承诺。后续 bundle/profile/HOME/CLI 覆盖成默认 route、未知 backend、禁用该插件，均不能承诺屏障；必须拒绝创建临时会话而非静默降级。

#### 完整 Web 续测（增量记录）

新增 `test/fixtures/native-cache-backend-web.mjs`；`node scripts/native-cache-backend-probe.mjs --web` 可单独复现，默认命令现也执行 Web。**最终整套命令退出 0，无 Web 阻塞。** 真正以安装版 `dsh --profile web --patch <隔离 patch> --host 127.0.0.1 --port 0 --no-open` 启动，保留 shipped Web composition，不替换 sessions/sessionProjections/Agent loop。overlay 只增加 fixture、完整 storage-domain config 的目标 route、合成默认模型；默认 JSON storage root 保持 `$DSH_HOME/storages`，其他 domain 继续原 backend。routing 使所有 Session 的 projection cache 都经过 wrapper，但仅封禁独占 UUID，其他 key 不禁缓存。

- wrapper 先核对两个新 UUID 无旧 cache row、持久 seal blocked UUID，再提供 backend lifecycle key；真实 domain 首次 open 后，测试专属 RPC 调公开 `AgentRegistry.create` 创建两个无 parent 的 root Agent（不是 synthetic Session 对象，也不是调用普通 create RPC）。原生 `/api/session/prompt` 为两者各送一轮，`wait` 等待 idle，`events` 验证真实 user/message 与 assistant/message 中的合成文本，并拒绝 turn/end error。`/api/session/list` 核对被保护 Session 和普通对照 Session 均可见，为之后的原生导航提供必要条件。实际 HTTP 经 launch token → cookie 认证。
- LLM 仅本地 `SyntheticAdapter`，合成回答 `SYNTHETIC-LOCAL-REPLY`，本次共 4 次 dispatch（包含宿主辅助模型调用）。公开 `llm/stream` waterfall 在 dispatch 前拒绝非 synthetic provider；不 monkey-patch、不调用真实模型、没有 OS 网络 namespace 保证。
- 测试通过 cache 公共 read API `cachedSnapshot`、domain/changed 事件、wrapper delegate 前边界以及真实文件确认 blocked 从未进入 cache Map、没有 successful put、未调用 JSON writer，因此不生成 blocked 正文 tmp。普通对照 Map/JSON 正常。公开 handle cancel/dispose 后，测试先观察目标 `session/disposed`，再等待后续拒写通知和正常 checkpoint 队列屏障，验证 blocked 仍空、普通对照 JSON bytes 不变。该 Web 断言未单独标识拒写任务的触发源；精确 disposed producer 的路径由前述组件级实验覆盖。没有 diagnostic get/delete 或删除任何 cache row。
- detached 专属进程组 SIGTERM，超时 SIGKILL，等待 launcher exit 并检查进程组消失；宿主退出后 cache 目录只有正常对照的 JSON、无 blocked 文件或 tmp/backup/deleting，最后强制删除整个隔离 root。未做日志/附件的会话级清理承诺。

最终测试输出（已保留，不保留带认证 token 的启动日志）：

```text
PASS WEB full installed web composition: authenticated HTTP; pre-sealed UUID then two real root Agents
PASS WEB real /api/session/prompt + wait/events/list for both Sessions; local synthetic adapter calls=4; blocked Map/disk/tmp absent, normal cache present
PASS WEB abort/dispose owned Agents; post-detach cache write denied; control cache bytes unchanged
CLEANED Web launcher exited; owned detached process group terminated
PASS WEB after host exit: only control cache record, no blocked record or JSON temp residue
UNCOVERED cross-process mutual exclusion, concurrent hosts, SIGKILL/power-loss recovery, real provider/model, browser UI and non-cache cleanup
CLEANED isolated HOME/DSH_HOME
```

过程中实际失败已修复：① adapter exact-model 元数据漏 `name` 导致 `turn/end` 报 `INVALID_MODEL_INFO`，回答断言正确失败（没有把 accepted/idle 当作成功）；② native list 参数名为 `_request` 而不是 `request`，gateway 报 `arguments-invalid: missing "_request"; unexpected "request"`。修正 fixture/测试调用后上述整套实跑通过，没有修改宿主实现。

#### 独立双进程与 SIGKILL 反例

另运行 `node scripts/native-cache-cross-process-probe.mjs`，使用真实 JSON backend、独立 OS 进程和 IPC 门闩，不运行真实用户宿主、不请求模型：

- **关闭时才标记并不安全**：进程 A 在检查无标记后暂停；进程 B 创建并 fsync 标记；A 放行后仍成功落盘，确定性证明原型的进程内 Promise 锁不是跨进程屏障。
- **创建前标记**：先持久标记，再启动新的写入进程，该写入在 JSON backend 前被拒；未标记的普通会话仍能写入。
- **受限 SIGKILL**：标记创建与文件、目录 fsync 成功后杀掉标记创建子进程；另一个新进程仍能读取标记并拒写。此项不模拟写标记中途被杀、OS 宕机或电源丢失，也不覆盖真实并发 DSH 宿主或不经过 wrapper 的 writer。
- **损坏标记**：注入不完整 JSON 后，目标写入在调用底层 JSON writer 前失败，没有创建缓存文件；这验证拒绝放行，不代表损坏记录可自动恢复。
- **未知 cache descriptor**：分别注入版本、布局、表、global 和兼容版本不匹配；均在打开底层 backend 之前失败。不同名的普通 domain 不受该限制。

脚本以随机 UUID 和隔离 HOME/DSH_HOME 操作，进程与临时目录均清理；不把上述结果等同完整跨进程锁或崩溃恢复验证。

#### 复现命令与通过记录

```sh
node --check scripts/native-cache-backend-probe.mjs
node --check scripts/native-cache-cross-process-probe.mjs
node scripts/native-cache-backend-probe.mjs
node scripts/native-cache-cross-process-probe.mjs
```

在 `btw/` 执行，安装版强制核对 `0.2.2-rc.1`，退出 **0**；脚本创建并最终删除 `/tmp/btw-native-backend-*`，子进程使用白名单环境，隔离 HOME/DSH_HOME/XDG（Web 另隔离 TMPDIR、DSH_AGENTS_HOME），不传凭据/代理；测试 preload 的 Node socket 防护拒绝非 loopback，但不是 OS 网络沙箱，不能覆盖原生库或子进程网络。Web 只绑定 localhost，LLM waterfall 禁止真实供应商模型。

以下保留首次 component + custom CLI 阶段的输出；完整 Web 续测与独立双进程结果见上文：

```text
PASS component pre-create UUID gate: create/live/cold/disposed rejected BEFORE delegate, no cache Map/event/tmp; B queue works
PASS component deterministic flush-late write rejects, no false success/map/event/disk resurrection
PASS component cold/disposed fail-soft producers denied underneath; delete allowed; B queue and bytes intact
PASS component close/reopen keeps tombstone and normal session
PASS component fresh OS process: pre-create and closing tombstones deny; B loads and writes
HOST registered backend + durable pre-create marker BEFORE domain activation
PASS HOST real CLI startup/registry/route/dependency barrier and CLI-last precedence; A rejected, B durable, no A map/event
UNCOVERED cross-process mutual exclusion, concurrent hosts, SIGKILL/power-loss recovery, native Web/HTTP and all non-cache artifacts
CLEANED isolated HOME/DSH_HOME
```

**证据分层**：component 使用真实安装版 BackendRegistry、DomainFacility、JsonStorageBackend、SessionProjectionCache；假的是本地 sessions/projection adapter 和 Promise 门闩。没有假设 flush 排空所有 producer。晚写实验确切停在 flush，墓碑 durable + 测试自有 handle 删除之后才 release，直接 `cache.write` Promise 必须 reject `BTW_TOMBSTONED`，没有后续 put 事件/Map/磁盘复活；此关闭后封禁只是回归对照，不是推荐部署流程。cold/disposed 路径由 cache 自己 fail-soft catch，测试等待 wrapper 的拒写通知而非 sleep，并核对随后 B 写队列及原始 JSON bytes 不变。推荐 pre-create 路径另用随机 UUID，先核对无旧 row/文件、同步标记、再构造合成 Session，create/live/cold/disposed 从未成功 put，不需要关闭时 get/delete/evict。此 harness 诊断访问仅用于它自己组成的 domain 的断言/关闭回归，不给生产旁观插件授予 handle 权限。

**此前 custom CLI 验证范围**：真的 `dsh native-probe --patch <sandbox-overlay>` 子进程、真实 launcher/profile composition/Loader/依赖屏障、公开 registry 和安装版 cache；该项 Session 与 projection 仍是 synthetic adapter。后续完整 Web 的真实 Agent、HTTP 和本地 LLM adapter 证据单列上节，不与此混淆；两者均不证明产品完整阅后清理。

**wrapper 边界**：只接受当前已知 `session_projcache` descriptor（v7、兼容 3/4/5/6、`per-record`、仅 `sessions`、无 global），未知 descriptor 在 delegate open 前失败，绝不静默放行。已通过双进程研究脚本单独注入版本、布局、表、global 与兼容版本变体；其他 domain 不施加此限制，普通 key 委托 JSON，普通会话 B 的透传已实测。未另测试其他 domain 的完整 backend 合约。拒写在 JSON put 调用之前，标记只存版本/domain/table/key；初始拒写时目录枚举完全不变，没有正文 tmp。底层错误不伪装成功，拒绝也不抛 `unknown-state` 隔离共享 domain。

**未覆盖/不声称通过**：跨 OS 进程互斥（只有同进程 Promise 每 key 锁）；多个活宿主、旧默认 backend writer；SIGKILL/电源/IO 故障与锁恢复；UUID 竞争碰撞（仅新 sandbox absence 断言，不是跨宿主独占协议）；旧 cache row 的 loadAll 过滤虽已实现但未单独注入残留测试；外部持有 Map/events/页面引用；真实供应商模型、浏览器 UI；日志、附件、draft、权限与其他持久域的清理。新 OS 进程重启测试是顺序正常退出后重开，不是 crash 实证。墓碑 wx 创建 + file/dir fsync；撕裂或损坏标记读失败会拒绝，而非解除门，不宣称崩溃恢复完备。标记不回收，长期保留。

**优先简化路径：创建前门。** 在独占、从无 cache row 的随机 UUID 上，先持久登记拒写标记，再调用 root Agent 创建；公开 `CreateAgentOptions.sessionId` 允许调用者预选 ID。整个生命周期拒绝该 ID 的 put（抛错，绝非成功 no-op），在调用 JSON writer 之前检查，因此没有正文临时文件、没有成功的 domain Map 更新。此路径不需要关闭时 diagnostic get/delete/evict。标记长期保留；不因关闭或一次空扫描回收。旧 row、UUID 碰撞、旧默认 backend writer 或不受控多宿主使该前提不成立，不能套用“从未缓存”。本轮真实 Agent + 原生 HTTP 发送已通过（仅本地合成模型）；跨宿主独占证明仍未覆盖。

正确算法需在 durable put 前、生成 temp 前核对持久门；跨进程共享每 key 的锁覆盖“检查墓碑—写入”，关闭方同锁落墓碑并等待在途写，所有未来旧进程也必须遵守。删 row 必须仍可穿过拒写门；不要把拒绝 put 当成功 no-op，否则 domain 会把内容保存在内存。loadAll 要过滤本人封禁 key 并保留其他数据；错误只拒本 key，不返回 unknown-state 污染全域。墓碑必须随 backend 一起存续，不能随插件卸载消失后继续跑默认 writer。

若全部 writer 都经此 backend，则可证明：关闭持锁落墓碑之后，旧写已结束，新写先被拒绝；精确删除后不会再持久化该 key。**但它仍不能清掉别的进程已加载的 Map、已返回的 events/页面、附件和日志**。旧宿主仍走默认 JSON、路由热替换、锁命名空间不一致或启动恢复顺序不受控都会破坏证明。本轮仅实现上述单进程隔离研究；跨进程关闭屏障未实现/未验证，不将其当成默认方案已经解决。

### D. 仅本 Session 存储 / 独立进程

默认 storage-domain 路由粒度是 domain、附件 root 也不是 per-session；创建一个 scoped Agent 不会自动隔离这些服务。未验证有公开单 Session 选项把 projection、draft、attachment、permissions、API observation 全部重定向到独占目录；替换 scoped 私有 service 不算。

独立 DSH_HOME + 独立宿主进程 + 进程树退出确认 + 独占目录删除可以为“其独占的受管文件”构造更强屏障，crash 后由外部恢复器等它确实死亡再删；但浏览器需连接独立宿主，不是原宿主中 openSession 一个 ID 就透明完成。还须隔离客户端连接/缓存、工具输出、附件和权限默认值；未实测，不建议当最小插件实现。

## 权限、附件与无法承诺的范围

普通页本身带完整原生 composer，但功能可用不等于生命周期可焚毁。权限更改必须只写本人 Session；全局“记住允许”、来源 Session 与宿主默认值不能替用户恢复或删除。附件 upload 可能在发消息之前产生，hash blob 可跨 Session 共享；在没有公开引用计数删除/独占附件后端和所有 writer 屏障前，不删除任何共享 blob，也不能宣称附件已焚毁。

OS 同用户攻击者、磁盘介质安全擦除、swap/core、备份、外部供应商、工具写入项目文件、宿主日志、客户端已展示/复制的内容不在逻辑删文件保证内。未调查完所有宿主缓存，不把这六个实验提升为“原生 Session 所有工件清单已穷尽”。

## 实验复现脚本

以下脚本只导入安装代码并写自己的 `/tmp`；复制到 `/tmp/btw-native-cleanup-probe.mjs` 后运行上述命令即可。没有固定 sleep；安装目录不同需相应调整 `base`。

```js
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
const root = await mkdtemp('/tmp/btw-native-cleanup-');
Object.assign(process.env, { HOME: root, DSH_HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'), DSH_TELEMETRY_DISABLED: '1' });
const base = '<dsh 安装根>/node_modules/@deepseek-ai/';
const { Context, Service } = await import(base + 'cordis/lib/index.js');
const { JsonStorageBackend } = await import(base + 'dsh-storage-json/lib/index.js');
const { DomainFacility } = await import(base + 'dsh-storage-domain/lib/index.js');
const { SessionProjectionCache, projectionCacheDomainSpec } = await import(base + 'dsh-session-projection-cache/lib/index.js');
const defer = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
let backend, domain, second;
try {
 const ctx = new Context();
 backend = new JsonStorageBackend(join(root, 'storage'));
 ctx.provide('storage', { backend: { get: () => backend } });
 const facility = new DomainFacility(ctx, { backend: 'json' });
 ctx.provide('storageDomain', facility);
 const entered = defer(), release = defer();
 const session = { id: 'owned-a', header: { version: 4, createdAt: 1, isSeeded: false }, inheritedEventCount: 0 };
 ctx.provide('sessions', { get: id => id === session.id ? session : undefined, flush: async () => { entered.resolve(); await release.promise; } });
 let value = 'SYNTHETIC-ONLY';
 const rows = () => ({ title: { ver: 0, seq: 0, val: { text: value } } });
 ctx.provide('sessionProjections', { checkpoint: rows, restore: () => ({ checkpoint: rows(), snapshot: { synthetic: value } }), viewCheckpoint: r => r });
 const cache = new SessionProjectionCache(ctx, { writeEveryEvents: 50, writeIntervalMs: 100000 });
 await cache[Service.init]();
 domain = facility.get('session_projcache');
 const table = domain.table('sessions');
 const path = join(root, 'storage/session_projcache/sessions/owned-a.json');
 const checkpoint = cache.write(session);
 await entered.promise;
 assert.equal(await table.delete('owned-a'), false);
 release.resolve(); await checkpoint;
 assert.ok((await readFile(path, 'utf8')).includes(value));
 console.log('PASS delayed flush producer restores row after awaited delete (explicit gate, no sleep)');
 const heldRecord = table.get('owned-a');
 await table.delete('owned-a');
 assert.equal(table.get('owned-a'), undefined);
 assert.ok(heldRecord.rows.title.val.text.includes(value));
 console.log('PASS table delete evicts current map, but previously held JS record still contains synthetic content');
 const changed = defer();
 const unlisten = ctx.on('domain/changed', c => { if (c.key === 'owned-a' && c.operation === 'put') changed.resolve(); });
 cache.coldSnapshot({ ...session.header, id: session.id }, 0, []);
 await changed.promise; unlisten();
 assert.ok(table.get('owned-a'));
 console.log('PASS coldSnapshot after delete restores row (local projection adapter; not external HTTP route proof)');
 // Two independent facilities represent the separate in-memory maps of two host processes.
 const ctx2 = new Context(); second = new JsonStorageBackend(join(root, 'storage'));
 ctx2.provide('storage', { backend: { get: () => second } });
 const f2 = new DomainFacility(ctx2, { backend: 'json' });
 const d2 = await f2.open(projectionCacheDomainSpec), t2 = d2.table('sessions');
 await table.delete('owned-a');
 assert.ok(t2.get('owned-a'));
 await t2.put('owned-a', t2.get('owned-a'));
 assert.equal(table.get('owned-a'), undefined);
 assert.equal(await table.delete('owned-a'), false);
 assert.ok((await readFile(path, 'utf8')).includes(value));
 await t2.delete('owned-a'); await d2.close(); await second.close(); second = undefined;
 console.log('PASS independent domain map can restore disk row; missing-key delete in first map does NOT remove it');
 await mkdir(path, { mode: 0o700 });
 await assert.rejects(cache.write(session), e => ['EISDIR', 'ENOTDIR', 'EEXIST'].includes(e.code));
 assert.equal(table.get('owned-a'), undefined);
 const sibling = { identity: { formatVersion: 4, createdAt: 2, isSeeded: false, inheritedEventCount: 0 }, rows: rows() };
 await table.put('unrelated-b', sibling);
 assert.deepEqual(table.get('unrelated-b'), sibling);
 assert.deepEqual((await readdir(join(root, 'storage/session_projcache/sessions'))).sort(), ['owned-a.json', 'unrelated-b.json']);
 console.log('PASS directory sentinel blocks own publish; ordinary failure does not poison shared write queue; no temp remains after handled failure');
 await domain.close(); domain = await facility.open(projectionCacheDomainSpec);
 const reopened = domain.table('sessions');
 assert.equal(reopened.get('owned-a'), undefined);
 assert.deepEqual(reopened.get('unrelated-b'), sibling);
 await reopened.put('unrelated-c', sibling);
 assert.equal(await reopened.delete('owned-a'), false);
 assert.equal((await lstat(path)).isDirectory(), true);
 console.log('PASS reopen/global scan skips directory sentinel, other session survives and next write succeeds; table delete does not remove absent sentinel');
 console.log('NOTE crash during writeAtomic temp-before-rename not injected: source shows anonymous shared-directory temp can survive SIGKILL');
} finally {
 await domain?.close(); await second?.close(); await backend?.close();
 await rm(root, { recursive: true, force: true });
 console.log('CLEANED isolated HOME/DSH_HOME/storage root');
}
```
