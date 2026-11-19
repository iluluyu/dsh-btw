<p align="right"><a href="README.md">简体中文</a> · <a href="README.en.md">English</a></p>

# dsh-btw

**主任务不停，顺便问一句。** 独立多轮侧问、按需引用当前对话、无痕临时聊天，不打断 Agent，也不污染主会话历史。

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）打造的侧问（`/btw`）与临时聊天插件。

[功能](#功能) · [安装](#安装) · [设置](#设置)

## 功能

- **不打断主线** —— 主会话继续跑，点输入框旁「顺便问」或输入 `/btw` 随时开问，支持多轮对话与实时思考过程，不写进主会话历史。
- **三入口、三形态** —— 输入框按钮、`/btw`、右上角入口均可独立开关，分别指定打开在**输入框上方**、**右侧栏**或**浮动小窗**；任意入口续接同一个顺便问，保留位置与草稿。
- **按需引用当前对话** —— 上下文可选无、最近、按需或全部；按需模式只在发问时检索相关原文，需要时再补读邻近消息，引用内容可展开核对。
- **送回主对话草稿** —— 多选 btw 中的消息，一键插入来源会话输入框，不覆盖原稿、不自动发送。
- **原生临时聊天** —— 主页入口默认开启，直接打开 DSH 原生对话页，**安装即用，无需配置**；离开或关闭后后台清理，回到同一工作区的空白对话。
- **随手收放** —— 收起隐藏回原按钮，随时继续；`Esc`（主输入框有焦点时同样生效）与 `×` 立即结束并后台清理。

## 安装

**npm 发布版**

```sh
dsh plugin --profile web add dsh-btw      # Web
dsh plugin --profile desktop add dsh-btw  # 桌面版
```

安装后重启 `dsh web` 或桌面应用。

**GitHub 最新提交**

```sh
dsh plugin --profile web add github:iluluyu/dsh-btw
```

<details>
<summary><b>本地路径与卸载</b></summary>

```sh
dsh plugin --profile web add .                               # 插件目录内
dsh plugin --profile web add file:/absolute/path/to/dsh-btw  # 本地打包
dsh plugin --profile web remove dsh-btw                      # 卸载（桌面版将 web 换为 desktop）
```

</details>

## 设置

在 **插件 → dsh-btw** 中调整，默认上下文与模型由侧问和独立 btw 共用。

| 设置 | 选项与默认值 |
| --- | --- |
| 临时聊天 | 开 / 关；默认开启 |
| 上下文 | 无上下文 / 最近对话 / 按需引用当前对话 / 全部对话；默认「最近对话」 |
| 模型 | 跟随来源会话或指定模型；默认跟随 |
| 输入框「顺便问」按钮 | 开 / 关，输入框上方 / 右侧栏 / 浮动小窗；默认开启、输入框上方 |
| `/btw` | 开 / 关，输入框上方 / 右侧栏 / 浮动小窗；默认开启、输入框上方 |
| 右上角入口 | 开 / 关，输入框上方 / 右侧栏 / 浮动小窗；默认开启、右侧栏 |


## 许可

MIT © iluluyu
