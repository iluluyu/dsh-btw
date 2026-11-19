<p align="right"><a href="README.md">简体中文</a> · <a href="README.en.md">English</a></p>

# dsh-btw

**Keep the main task running. Ask a quick side question.** Independent multi-turn `/btw` chats, on-demand source context, and zero-config ephemeral temporary chats — without interrupting your agent or polluting session history.

Side questions (`/btw`) and temporary chats for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

[Features](#features) · [Install](#install) · [Settings](#settings)

## Features

- **Keep the main task running** — open a side chat anytime from the composer button or `/btw` with multi-turn support and live reasoning, kept out of the main session history.
- **Three entries, three layouts** — toggle the composer button, `/btw`, and top-right header entry independently and place each **above the composer**, in the **right sidebar**, or as a **floating window**; all three resume the active side chat with its draft intact.
- **On-demand source context** — choose `none`, `recent`, `on-demand`, or `all`; on-demand searches the source conversation only when you send, lets the model read nearby messages if needed, and keeps used excerpts expandable.
- **Insert back into the main draft** — select messages in btw and insert them into the source session's composer without overwriting or auto-sending.
- **Native temporary chat** — enabled by default on the home screen, opening a full native DSH conversation page with **zero configuration**; closing cleans up in the background and returns to a blank conversation in the same workspace.
- **Park or dismiss anytime** — minimize back to the trigger button to resume later; `Esc` (works even from the host composer) and `×` end the panel immediately and clean up in the background.

## Install

**From npm**

```sh
dsh plugin --profile web add dsh-btw      # Web
dsh plugin --profile desktop add dsh-btw  # Desktop
```

Restart `dsh web` or the desktop app after installation.

**Latest from GitHub**

```sh
dsh plugin --profile web add github:iluluyu/dsh-btw
```

<details>
<summary><b>Local paths &amp; uninstall</b></summary>

```sh
dsh plugin --profile web add .                               # inside the plugin directory
dsh plugin --profile web add file:/absolute/path/to/dsh-btw  # packed tarball
dsh plugin --profile web remove dsh-btw                      # uninstall (use desktop instead of web for desktop)
```

</details>

## Settings

Configure under **Plugins → dsh-btw**. Default context and model are shared across side questions and standalone btw.

| Setting | Options & defaults |
| --- | --- |
| Temporary chat | On / Off; default On |
| Context | None / Recent / On-demand / All; default Recent |
| Model | Follow source session or specific model; default Follow |
| Composer side-question button | On / Off, Above composer / Right sidebar / Floating window; default On, Above composer |
| `/btw` | On / Off, Above composer / Right sidebar / Floating window; default On, Above composer |
| Top-right header entry | On / Off, Above composer / Right sidebar / Floating window; default On, Right sidebar |

> Temporary chats are stored locally for a short time and logically deleted on close (not secure erasure); cleanup supports only the default JSONL storage of dsh `0.2.2-rc.1` / `0.2.2-rc.3` / `0.2.2-rc.5`. See [storage and cleanup boundaries](https://github.com/iluluyu/dsh-btw/blob/main/docs/temporary-chat-storage.md) (Chinese).

## License

MIT © iluluyu
