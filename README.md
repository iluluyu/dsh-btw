<p align="right"><a href="README.md">简体中文</a> · <a href="README.en.md">English</a></p>

# dsh-btw

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）提供旁路提问和临时聊天。两者都不写入主会话历史。

- **`/btw`**：主任务继续跑的时候提一个问题。答案出现在输入框上方的临时面板，Esc 关闭。也可以点发送按钮旁的 `btw` 胶囊。
- **临时聊天**：新开对话页右上角可独立开启，无需工作区；会话内也可打开弹窗或停靠侧栏。收起保留对话，显式结束后等待清理。
- **模型与上下文**：在输入区选择本次模型与上下文；插件设置分别保存侧问和临时聊天默认值。宿主默认与当前会话模型是不同选项。
- **上下文范围**：无、最近对话、按需搜索最近快照、全部对话。全部模式只读来源会话已记录的用户/助手/工具文本，不包含未提交的生成内容或附件二进制；缺页、超出 1Mi 文本上限或模型保守容量预算时明确拒绝，不静默截断。
- **送回草稿**：多选旁路消息，插入来源会话的草稿，不覆盖原稿、不自动发送。

临时聊天会暂存到本机。清理只支持已验证的 Linux / dsh `0.2.2-rc.1` 默认 JSONL 根目录，不承诺安全擦除或消除远端副本；自定义后端会明确拒绝。无工作区模式不加载文件/命令工具。详见 [存储与清理边界](docs/temporary-chat-storage.md)。

## 安装

```sh
dsh plugin --profile web add dsh-btw
dsh plugin --profile web add github:iluluyu/dsh-btw
dsh plugin --profile web add .   # 插件目录下执行（相对路径相对当前执行位置）
dsh plugin --profile web add file:/absolute/path/to/plugin
```

重启 `dsh web` 并刷新。卸载：`dsh plugin --profile web remove dsh-btw`。

## 本地开发与兼容性

当前工作区已适配 dsh `0.2.2-rc.1`：使用独立 `/btw` RPC 通道，避免占用宿主 `/api`；所有 UI 槽位均延迟注入。临时聊天通过宿主提供的安装锚点解析内置工具包，不依赖旧安装目录的符号链接。

npm 的 `0.0.3` 不包含这些未发布修复。开发验证请使用上面的本地目录安装方式；本地版本号暂不提升，验证后再统一发 patch。

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
