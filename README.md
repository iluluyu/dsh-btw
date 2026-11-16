<p align="right"><a href="README.md">简体中文</a> · <a href="README.en.md">English</a></p>

# dsh-btw

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）提供独立的 btw 聊天：问一句、试一下，不打断主任务，也不写进主会话历史。

## 特性

- **输入框旁的 btw / `/btw`**：主任务继续跑，这里独立多轮聊。固定面板与原生输入框同宽、只调高度；回复后输入区收起，圆形箭头展开继续。消息在内部滚动，Agent 用原生 Markdown 渲染。
- **多种展示，同一个聊天**：小窗、侧边栏、全屏只是 UI 切换，消息和草稿都不丢。项目会话右上角的 btw 默认进 DSH 原生侧栏；小窗可拖动、缩放、固定，位置按项目记忆。
- **无来源 btw 用 DSH 原生页面**：全局入口直接打开原生普通对话页（composer、`+`、权限与模型选择、思考渲染都是宿主的），btw 只加虚线描边和右上角「临时聊天」状态入口。**安装即用，不改任何配置**；临时会话归到当前项目的工作区，离开即结束并清理，主动关闭后回到同一工作区的普通空白对话。普通与临时对话切换时沿用已选模式，临时对话中改选的模式也会带回普通对话。
- **模型与上下文分开设置**：输入框旁和独立入口各存一套默认值；有来源时默认跟随来源会话的模型，无来源用 DSH 默认模型。上下文范围可选无、最近、按需搜索、全部。
- **真实思考过程**：模型产生 reasoning 时先实时展开，回答开始后自动收起。
- **送回草稿**：「选择消息」多选后插入来源会话的草稿，不覆盖原稿、不自动发送。
- **收起 ≠ 结束**：收起只隐藏到原 `btw` 按钮，再点继续同一个聊天；Esc 与 × 一样：立即结束普通 btw 面板并后台清理，不保留可返回的旧窗口/草稿；失败时才重新浮出并说明原因。关闭原生临时聊天时优先回到同一工作区的普通空白对话，再后台清理；不恢复之前的历史会话。Esc 不要求焦点在 btw 内：焦点在主输入框时也能关掉（优先关焦点所在的 btw，否则关最近使用的那个）；原生菜单/下拉/dialog 的 Esc 不受影响，临时聊天页里 Esc 不做任何销毁动作。

## 安装

```sh
dsh plugin --profile web add dsh-btw      # Web
dsh plugin --profile desktop add dsh-btw  # 桌面版
```

装完重启对应的 `dsh web` 或桌面应用。此前使用本地 `file:` 包时，也可运行上述命令切回 npm 包。其它来源：

```sh
dsh plugin --profile web add github:iluluyu/dsh-btw
dsh plugin --profile web add file:/absolute/path/to/dsh-btw        # 本地打包
dsh plugin --profile web add .                                     # 插件目录内
```

卸载：`dsh plugin --profile web remove dsh-btw`；桌面版将 `web` 换成 `desktop`。

## 已知边界

原生临时模式可以先开启、再通过宿主选择工作区；选择完成后自动进入对应原生临时会话，也可直接继承当前/最近的已有工作区，不额外创建「btw」分组。退出和切换即时反映模式选择，记录回收独立在后台执行，不显示清理状态或错误弹层；后台任务会有限重试并保留恢复记录与诊断，不把归档或未确认的删除假报为成功。

临时聊天会暂存到本机，关闭时做逻辑删除，**不是安全擦除**，也不处理远端副本与共享附件 blob。清理只支持 dsh `0.2.2-rc.1` 和 `0.2.2-rc.3` 默认 JSONL 存储（rc.3 已在 Linux Web 和 Windows 桌面端验证）；自定义后端会明确拒绝而不是假装支持。临时工作区不是 OS 沙箱，普通 preset 的权限策略照旧生效。跨进程互斥、多宿主并发、断电恢复不在承诺范围。此前若手动配置过 `session_projcache: btw-native-json`，请移除该配置，让插件自动管理有效路由。细节见 [存储与清理边界](https://github.com/iluluyu/dsh-btw/blob/main/docs/temporary-chat-storage.md)、[清理算法](https://github.com/iluluyu/dsh-btw/blob/main/docs/native-cleanup-algorithms.md)。

## 路线图

- macOS 真机验证（目前 Windows / Linux 已实测，macOS 仅平台注入测试覆盖）。
- 面板与侧栏的交互细化（键盘操作、窄屏适配）。
- 清理边界推进：跨进程互斥、断电恢复、共享附件处理。
- 真实供应商模型的端到端冒烟。

## 开发

结构与验证流程见 [docs/verification.md](https://github.com/iluluyu/dsh-btw/blob/main/docs/verification.md)，历史调研见 [docs/handoff.md](https://github.com/iluluyu/dsh-btw/blob/main/docs/handoff.md)。改完代码必须重启宿主，刷新浏览器不会加载新代码。

## 许可

MIT
