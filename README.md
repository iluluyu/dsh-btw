<p align="right"><a href="README.md">简体中文</a> · <a href="README.en.md">English</a></p>

# dsh-btw

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）提供独立的 btw 聊天，不写入主会话历史。固定面板、浮窗、侧边栏和全屏是同一聊天的不同 UI。

- **输入框旁的 btw / `/btw`**：在主任务继续运行时开启独立多轮聊天。固定面板与原生输入框左右对齐、默认高 200px，只调整高度；回复后输入区收起，圆形箭头可展开继续。消息内部滚动，用户保留气泡，Agent 使用原生 Markdown 正文。首问创建独立 child，后续问答追加并保留其真实历史，不是每问重开。
- **独立 btw**：项目会话右上角的 btw 默认打开并选中 DSH 右侧栏；新开对话页也可独立开启；无来源 btw 打开 DSH 原生普通对话页（需显式启用，见下），默认沿用当前工作区，没有工作区时使用独占临时工作区；未启用时明确报错，虚线区分输入框和用户消息，离开或关闭时清理。支持多个独立的 btw，小窗并排或错开放置，直接点击窗口继续，不需要编号聊天切换器；在**小窗、侧边栏、全屏**间切换只换 UI，不丢失消息与草稿，关闭只清理当前聊天。
- **模型与上下文**：首次发送前选择这条聊天的模型与上下文；设置分别保存输入框旁和独立入口的默认值。模型菜单统一为「默认」及自选模型：有来源时默认跟随来源会话当前模型，无来源时使用 DSH 默认模型。
- **收起与结束**：收起只隐藏到原 `btw` 按钮，再点直接继续同一 child、消息和草稿，没有恢复页面。X / Esc 才结束并清理；结束后再开是空白聊天。
- **窗口默认行为**：设置中选择独立入口的默认模式、小窗是否固定和是否记忆位置；项目会话标题栏入口优先打开侧栏。小窗默认固定，用钉子切换可拖动状态。拖动小窗边缘或四角调整宽高，不使用宽度滑杆；固定面板的全屏进入 DSH 原生侧栏全屏，退出回原面板；侧栏使用 DSH 原生控件，侧栏中新建继续留在侧栏。关闭侧栏中的 btw 会结束并清理当前聊天；只有该标签时收起侧栏。只按项目在浏览器记忆位置与尺寸，不保存聊天正文；窗口限制在视口内。没有来源会话时不能使用会话侧栏，默认侧栏会安全回到小窗。
- **上下文范围**：无、最近对话、按需搜索最近快照、全部对话。全部模式只读来源会话已记录的用户/助手/工具文本，不包含未提交的生成内容或附件二进制；缺页、超出 1Mi 文本上限或模型保守容量预算时明确拒绝，不静默截断。
- **送回草稿**：从聊天右上角「选择消息」进入多选，插入来源会话的草稿，不覆盖原稿、不自动发送。
- **思考过程**：模型产生真实 reasoning 时，回复前实时展开思考，思考结束后自动收起；折叠行、思考图标和正文分别复用 DSH 公开 DisclosureRow、图标和 reasoning Factory；宿主缺少这些组件时安全回退。没有提供时不编造；实时片段不会写回来源草稿，最终历史仍以成功提交的内容为准。
- **原生页面接入（无来源 btw）**：全局 btw 入口经 `/btw nativeOpen` 创建 btw 独占的普通 root Session，前端用公开 `uiWorkspace.openSession(id)` 打开完整 DSH 原生 conversation——原生 composer、`+`、权限/模型选择、思考与消息渲染全部由宿主提供。btw 只额外做两件事：按 `[data-conversation-session="<owned id>"]` 作用域给 composer 卡与用户气泡加虚线描边；由于原生 hero 页不渲染 header utilities，在右上角提供带对勾的「临时聊天」状态入口，点击结束并清理。启用需显式 startup 配置（bundle 只注册 backend，绝不覆盖用户配置），未绑定 gate 或路由被覆盖时 `nativeOpen` 明确报错拒绝创建，旧 ask/open 协议保留可用。详见 [输入框复用边界](docs/native-composer-boundary.md) 与 [清理算法](docs/native-cleanup-algorithms.md)。
- **原生风格设置**：参考 outline 的分组设置行，分为聊天默认、窗口行为、入口；复用公开 Menu，支持深浅色与窄屏。设置卡单独懒加载，未打开时不加载。

临时聊天会暂存到本机。清理只支持已验证的 Linux / dsh `0.2.2-rc.1` 默认 JSONL 根目录，不承诺安全擦除或消除远端副本；自定义后端会明确拒绝。旧 child 的无工作区模式不加载文件/命令工具；原生普通 Session 则使用宿主原生权限策略。详见 [存储与清理边界](docs/temporary-chat-storage.md)。

## 安装

```sh
dsh plugin --profile web add dsh-btw
dsh plugin --profile web add github:iluluyu/dsh-btw
dsh plugin --profile web add .   # 插件目录下执行（相对路径相对当前执行位置）
dsh plugin --profile web add file:/absolute/path/to/plugin
```

重启 `dsh web` 并刷新。卸载：`dsh plugin --profile web remove dsh-btw`。

可选：启用无来源 btw 的 DSH 原生页面。rc.1 的 patch config 是整体替换，请在启动配置中保留用户**完整**的 `storage-domain` 配置（含 `backend` 与已有 `routes`），仅添加 `routes.session_projcache: btw-native-json`，然后重启 `dsh web`；插件 bundle 只注册 backend，不会替你改配置。未启用时无来源入口显示错误，不伪装为原生页面。

启用后的清理边界：`nativeClose` 清理本人 JSONL 和恢复记录，并只从已有工作区移除本人 Session；无来源工作区时的独占临时 workspace 随关闭移除。拒写标记 `.btw-native-deny/<uuid>.json` 按设计永久保留。共享附件 blob 不删、不做安全擦除、不是 OS 沙箱（普通 preset 权限策略仍适用），跨进程互斥/并发宿主/断电场景不承诺。DSH 的工作区切换会导航到另一会话，不会原地更改当前 Session 的 cwd；离开临时会话会结束并清理它。

## 本地开发与兼容性

当前工作区已适配 dsh `0.2.2-rc.1`：使用独立 `/btw` RPC 通道，避免占用宿主 `/api`；所有 UI 槽位均延迟注入。临时聊天通过宿主提供的安装锚点解析内置工具包，不依赖旧安装目录的符号链接。

npm 的 `0.0.3` 不包含这些未发布修复。开发验证请使用上面的本地目录安装方式；本地版本号暂不提升，验证后再统一发 patch。

更新本地代码后也必须重启 `dsh web`，不能只刷新浏览器。若模型菜单提示 `unknown method: models`，说明运行中的宿主未提供新版方法；待任务结束后重启宿主并刷新，再重试加载模型。

```sh
npm run check
npm test
node scripts/smoke-isolated.mjs
# 可选：真实模型测试，只发送合成问题；显式指定已有 glm 配置和凭据文件
node scripts/smoke-model.mjs /path/to/cordis.patch.yml /path/to/.credentials.yaml
```

PR 审查与验证记录见 [docs/pr-1-review.md](docs/pr-1-review.md)。

## 许可

MIT
