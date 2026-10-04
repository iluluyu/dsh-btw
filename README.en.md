<p align="right"><a href="README.md">简体中文</a> · <a href="README.en.md">English</a></p>

# dsh-btw

Side questions and temporary chat for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). Neither enters the main session history.

- **`/btw`**: ask one question while the main task keeps running. The answer sits in a temporary panel above the composer. Esc closes it. The `btw` chip next to Send does the same.
- **Temporary chat**: the entry at the top right of the session. No parent context, working directory is the current project, gone on close.

## Install

```sh
dsh plugin --profile web add dsh-btw
dsh plugin --profile web add github:iluluyu/dsh-btw
dsh plugin --profile web add .   # run from the plugin directory; relative paths are anchored to the invoking directory
dsh plugin --profile web add file:/absolute/path/to/plugin
```

Restart `dsh web` and reload. Uninstall: `dsh plugin --profile web remove dsh-btw`.

## License

MIT
