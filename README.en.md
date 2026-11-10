<p align="right"><a href="README.md">简体中文</a> · <a href="README.en.md">English</a></p>

# dsh-btw

Side questions and temporary chat for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). Neither enters the main session history.

- **`/btw`**: ask one question while the main task keeps running. The answer sits in a temporary panel above the composer. Esc closes it. The `btw` chip next to Send does the same.
- **Temporary chat**: start independently from the top-right of New Session, without a workspace. Inside a session, use a popup or the right sidebar. Hiding preserves the chat; explicitly ending it waits for cleanup.
- **Models and context**: choose per-request options in the composer. Plugin settings keep separate defaults for side questions and temporary chat. Host default and the parent session's current model are distinct choices.
- **Context scope**: none, recent, on-demand search over a recent snapshot, or all recorded conversation text. All mode passively reads source-session user/assistant/tool text, excluding uncommitted generation and attachment binaries. Missing pages, the 1Mi text limit, or a conservative model-capacity budget cause explicit rejection, never silent truncation.
- **Return to draft**: select messages and insert them into the source session's draft without replacing existing text or sending automatically.

Temporary chat is briefly stored locally. Cleanup supports only the verified default JSONL root on Linux / dsh `0.2.2-rc.1`; it is not secure erasure or a guarantee about remote copies. Custom backends are rejected explicitly. No-workspace mode loads no filesystem or command tools. See [storage and cleanup boundaries](docs/temporary-chat-storage.md) (Chinese).

## Install

```sh
dsh plugin --profile web add dsh-btw
dsh plugin --profile web add github:iluluyu/dsh-btw
dsh plugin --profile web add .   # run from the plugin directory; relative paths are anchored to the invoking directory
dsh plugin --profile web add file:/absolute/path/to/plugin
```

Restart `dsh web` and reload. Uninstall: `dsh plugin --profile web remove dsh-btw`.

## Local development and compatibility

The working tree targets dsh `0.2.2-rc.1`: a dedicated `/btw` RPC channel leaves the host `/api` gateway untouched, and all UI slots mount lazily. Temporary chat resolves built-in tools from the active host installation anchor, not symlinks into an old installation.

The npm `0.0.3` release does not contain these unpublished fixes. Use a local-directory installation for development; the local version stays unchanged until a consolidated patch release.

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
