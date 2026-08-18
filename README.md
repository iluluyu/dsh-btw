# dsh-btw

**Name reservation for the upcoming `/btw` plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).**

This 0.0.1 release is a safe no-op placeholder — installing it changes nothing. It reserves the npm name and the settings-page id (`btw`) for the feature family below.

**为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）规划的 `/btw` 插件占位包。0.0.1 是安全的空操作——安装与否无任何影响，仅占住 npm 名与设置页 id（`btw`）。**

## Roadmap

| Stage | Feature |
|:---|:---|
| 0.1.x | `/btw <question>` — one-shot side question sharing the parent session context; answer renders in a transient panel above the composer; never written to session history |
| 0.2.x | Temporary chat mode — top-right entry, ChatGPT-style ephemeral conversation (no parent context, not persisted, gone on close), cwd pointing at the current project for quick "what is this repo" questions |

## Install (when 0.1.0 lands)

```sh
dsh plugin --profile web add dsh-btw
```

## License

MIT
