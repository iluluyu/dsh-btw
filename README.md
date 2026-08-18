# dsh-btw

Side questions and temporary chat for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) web.

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）web 端提供的旁路问答与临时聊天插件。

---

## Why

When the main agent is deep in a long task, you often want to ask one quick thing — *which config file did we settle on?* — without derailing it; and sometimes you want a short, throwaway conversation to get familiar with the project at hand. Both should leave the main session untouched: no interruption, no history pollution.

主任务运行途中随手插一句旁路问题，或开一段用完即焚的对话快速摸清当前项目——两者都不打断主 Agent，也不写入主会话历史。

## Features

### `/btw <question>` — side question

Ask one question against the current session context while the main agent keeps working. The answer renders in a transient panel above the composer; nothing enters session history.

在主任务继续运行的同时，基于当前会话上下文提一个问题；答案显示在输入框上方的临时面板，不进入会话历史。

### Temporary chat — 临时聊天

A top-right entry opens an ephemeral conversation: no parent context, not persisted, gone on close. Its working directory is the current project, so it doubles as the fastest way to learn what a repo is about. Reference UI: [docs/reference](docs/reference/chatgpt-temporary-chat.png).

右上角入口开启一段阅后即焚的对话：不继承父上下文、不落盘、关闭即消失；工作目录指向当前项目，天然适合"快速了解这个项目是干什么的"。

## Status

`0.1.x` side questions in development. Design notes and ecosystem research: [docs/research/RESEARCH.md](docs/research/RESEARCH.md).

## Install

```sh
dsh plugin --profile web add dsh-btw
```

Restart `dsh web` and reload.

## License

MIT
