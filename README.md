<p align="right"><a href="README.md">简体中文</a> · <a href="README.en.md">English</a></p>

# dsh-btw

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）提供旁路提问和临时聊天。两者都不写入主会话历史。

- **`/btw`**：主任务继续跑的时候提一个问题。答案出现在输入框上方的临时面板，Esc 关闭。也可以点发送按钮旁的 `btw` 胶囊。
- **临时聊天**：会话右上角入口。不继承当前上下文，工作目录是当前项目，关闭即焚。

## 安装

```sh
dsh plugin --profile web add dsh-btw
dsh plugin --profile web add github:iluluyu/dsh-btw
dsh plugin --profile web add .   # 插件目录下执行（相对路径相对当前执行位置）
dsh plugin --profile web add file:/absolute/path/to/plugin
```

重启 `dsh web` 并刷新。卸载：`dsh plugin --profile web remove dsh-btw`。

## 许可

MIT
