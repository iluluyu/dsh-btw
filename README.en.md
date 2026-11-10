<p align="right"><a href="README.md">简体中文</a> · <a href="README.en.md">English</a></p>

# dsh-btw

Independent btw chats for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh), without changing the main session history. The fixed panel, floating window, sidebar and full screen present the same chat.

- **Composer btw / `/btw`**: start an independent multi-turn chat while the main task runs. The fixed panel stays aligned with the native composer, defaults to 200px high, and resizes vertically only. Its editor collapses after a reply and can be reopened with the circular arrow; messages scroll internally with user bubbles and native assistant Markdown. The first send creates one child; later turns append and use its retained history.
- **Standalone btw**: the project-session header opens and selects the native DSH sidebar by default. New Session can start a source-free chat in the main area without a workspace; it opens the full native DSH ordinary conversation page when explicitly enabled (see below), inheriting the current workspace when available; otherwise it reports an error. Dashed outlines distinguish the native input and user messages, and leaving or closing cleans up the temporary Session. Independent small windows stay visible and are focused by clicking, without a numbered chat switcher. Switching a chat between **small window, sidebar and full screen** preserves its messages and drafts. Closing ends and cleans up only that chat.
- **Models and context**: choose before the first send. Settings keep separate defaults for the composer and standalone entries. The single Default option follows the source session's current model when there is a source, or the DSH default otherwise. Explicit model selection remains available.
- **Minimize versus end**: minimize back to the original btw chip, then click it to continue the same child, messages and draft directly. There is no restore screen. X / Esc ends and cleans up; reopening after end starts empty.
- **Window defaults**: choose the standalone default mode, pinning and position memory in settings; the project-session header opens the sidebar. Small windows start pinned; unpin to drag. Drag a small window's edges or corners to resize both dimensions; there is no width slider. The fixed panel's fullscreen uses the native DSH sidebar and returns to the fixed panel on exit. Sidebar chrome is native; new chats opened there stay there. Closing the only btw tab also collapses the sidebar. Only numeric position/size is remembered per project in the browser, never chat text. Restored positions stay within the viewport. Without a source session, session-sidebar mode is unavailable and safely falls back to a small window.
- **Context scope**: none, recent, on-demand search over a recent snapshot, or all recorded conversation text. All mode passively reads source-session user/assistant/tool text, excluding uncommitted generation and attachment binaries. Missing pages, the 1Mi text limit, or a conservative model-capacity budget cause explicit rejection, never silent truncation.
- **Return to draft**: enter selection mode from the chat header, then insert selected messages into the source session's draft without replacing existing text or sending automatically.
- **Thinking**: when the model emits reasoning for this child, the real thinking is shown live and collapses automatically when it finishes. Its disclosure row, thinking icon and content use DSH's public components and reasoning Factory, with a safe fallback on older hosts. Nothing is invented when reasoning is unavailable; live snippets are not inserted into the source draft, and completed history remains authoritative.
- **Native page integration (source-free btw)**: the global btw entry calls `/btw nativeOpen` to create an ordinary root Session owned exclusively by btw, and the frontend opens the full native DSH conversation via the public `uiWorkspace.openSession(id)` — the native composer, `+`, permission/model pickers, thinking and message rendering all come from the host. btw only adds two things: a dashed outline on the composer card and user bubbles scoped by `[data-conversation-session="<owned id>"]`, and an “结束临时聊天” (end temporary chat) button placed at the btw global entry, because the native hero page renders no header utilities. Enabling it requires explicit startup configuration (the bundle only registers the backend and never overwrites user config); when the gate is unbound or the route is overridden, `nativeOpen` fails with a clear error and the legacy ask/open protocol remains available. See [native composer boundary](docs/native-composer-boundary.md) and [cleanup algorithms](docs/native-cleanup-algorithms.md) (Chinese).
- **Native-style settings**: outline-style grouped rows for chat defaults, windows and entries, with public Menu controls, dark/light tokens and narrow layouts. The settings card loads only when visited.

Temporary chat is briefly stored locally. Cleanup supports only the verified default JSONL root on Linux / dsh `0.2.2-rc.1`; it is not secure erasure or a guarantee about remote copies. Custom backends are rejected explicitly. The legacy child's no-workspace mode loads no filesystem or command tools; a native ordinary Session follows the host's permission policy. See [storage and cleanup boundaries](docs/temporary-chat-storage.md) (Chinese).

## Install

```sh
dsh plugin --profile web add dsh-btw
dsh plugin --profile web add github:iluluyu/dsh-btw
dsh plugin --profile web add .   # run from the plugin directory; relative paths are anchored to the invoking directory
dsh plugin --profile web add file:/absolute/path/to/plugin
```

Restart `dsh web` and reload. Uninstall: `dsh plugin --profile web remove dsh-btw`.

Optional: enable the native page for source-free btw. rc.1 patch configs are replaced wholesale, so keep the user's **complete** `storage-domain` config (including `backend` and any existing `routes`), add only `routes.session_projcache: btw-native-json`, then restart `dsh web`; the plugin bundle only registers the backend and never edits the config for you. Without this route the source-free entry reports an error rather than pretending to be native.

Cleanup boundary once enabled: `nativeClose` removes the owned JSONL and recovery records and detaches only its own Session from an existing workspace; an exclusive temporary workspace is removed when used. The deny marker `.btw-native-deny/<uuid>.json` is kept permanently by design. Shared attachment blobs are not deleted, this is not secure erasure, and it is not an OS sandbox (the ordinary preset's permission policy still applies); cross-process mutual exclusion, concurrent hosts and power loss are not covered. DSH's workspace picker navigates to another Session rather than changing the current Session's cwd; leaving the temporary Session ends and cleans it.

## Local development and compatibility

The working tree targets dsh `0.2.2-rc.1`: a dedicated `/btw` RPC channel leaves the host `/api` gateway untouched, and all UI slots mount lazily. Temporary chat resolves built-in tools from the active host installation anchor, not symlinks into an old installation.

The npm `0.0.3` release does not contain these unpublished fixes. Use a local-directory installation for development; the local version stays unchanged until a consolidated patch release.

Local code updates also require restarting `dsh web`, not just refreshing the browser. `unknown method: models` means the running host does not provide the new method. Once active tasks finish, restart the host, refresh the page, and retry loading models.

```sh
npm run check
npm test
node scripts/smoke-isolated.mjs
# Optional real-model test: synthetic prompts only; explicit existing glm config and credential paths
node scripts/smoke-model.mjs /path/to/cordis.patch.yml /path/to/.credentials.yaml
```

See [docs/pr-1-review.md](docs/pr-1-review.md) for the PR review and validation notes (Chinese).

## License

MIT
