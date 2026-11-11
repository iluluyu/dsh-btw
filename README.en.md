<p align="right"><a href="README.md">简体中文</a> · <a href="README.en.md">English</a></p>

# dsh-btw

Independent btw chats for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): ask a side question, try an idea, and keep the main task running without polluting its session history.

## Features

- **Composer btw / `/btw`**: an independent multi-turn chat while the main task keeps running. The fixed panel matches the native composer's width and resizes vertically only; the editor collapses after a reply and reopens from the circular arrow. Messages scroll inside, with native Markdown rendering.
- **One chat, several surfaces**: small window, sidebar and full screen are only UI changes — messages and drafts survive. The project-session header opens the native DSH sidebar by default; small windows can be dragged, resized and pinned, with position remembered per project.
- **Source-free btw uses the native DSH page**: the global entry opens a full native conversation (composer, `+`, permission and model pickers, thinking and rendering all come from the host). btw only adds a dashed outline and an “end temporary chat” status entry. **No configuration needed** — the temporary session joins the workspace that owns the current project, and it is cleaned up when you leave.
- **Models and context per entry**: the composer and the standalone entry keep separate defaults; with a source session the default follows its current model, otherwise the DSH default. Context scope: none, recent, on-demand search, or all recorded text.
- **Real thinking**: live reasoning expands while the model reasons and collapses when the answer starts.
- **Return to draft**: select messages and insert them into the source session draft; nothing is overwritten or sent automatically.
- **Minimize is not end**: minimizing hides back to the original btw chip and continues the same chat; Esc leaves the interface at once and keeps the chat and draft; × ends and cleans up, disappearing immediately with cleanup finishing in the background and surfacing only when it fails. Esc never destroys the temporary chat page.

## Install

```sh
dsh plugin --profile web add dsh-btw
```

Restart `dsh web` (or the desktop app), then refresh. Other sources:

```sh
dsh plugin --profile web add github:iluluyu/dsh-btw
dsh plugin --profile web add file:/absolute/path/to/dsh-btw        # packed tarball
dsh plugin --profile web add .                                     # inside the plugin directory
```

Uninstall: `dsh plugin --profile web remove dsh-btw`.

## Known boundaries

Temporary chats are stored locally for a short time and logically deleted on close — **never secure erasure**, and remote copies or shared attachment blobs are out of scope. Cleanup supports only the verified default JSONL storage of dsh `0.2.2-rc.1`; custom backends are rejected explicitly rather than silently accepted. A temporary workspace is not an OS sandbox; the ordinary preset's permission policy still applies. Cross-process mutual exclusion, concurrent hosts and power-loss recovery are not claimed. See [storage and cleanup boundaries](docs/temporary-chat-storage.md) and [cleanup algorithms](docs/native-cleanup-algorithms.md) (Chinese).

## Roadmap

- Real macOS verification (Windows and Linux are tested; macOS is covered only by platform-injected tests).
- Tighter panel and sidebar interaction (keyboard access, narrow layouts).
- Stronger cleanup boundaries: cross-process exclusion, power-loss recovery, shared attachments.
- End-to-end smoke test against a real provider model.

## Development

Layout and verification flow: [docs/verification.md](docs/verification.md); research history: [docs/handoff.md](docs/handoff.md). Restart the host after code changes — refreshing the browser does not load new plugin code.

## License

MIT
