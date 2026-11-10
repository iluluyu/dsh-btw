# On-demand search investigation

Scope: isolated synthetic snapshots/adapters only; no credentials, real user history or external supplier model requests. Existing working-tree edits are retained. The debug script denies external IO; native UI verification uses a separate temporary profile and local adapter.

## Chain under inspection

- `lib/client.js`: the eager source bridge captures authorized completed legacy text through `transcriptOf`, without rescanning partial-only changes. The shared controller sends the snapshot on first `open`; fixed/floating/sidebar/fullscreen use the same child and `send/poll/close` owner. Empty on-demand snapshots fail explicitly; no implicit full-history read is allowed.
- `lib/index.js`: `contextText` requires a nonempty on-demand snapshot and retains the final 48,000 UTF-16 units. Legacy `runAsk` remains for compatibility; the normal UI uses `handleSend`, which runs the same search before forwarding untrusted search output to its independent child.
- `lib/context-search.js`: tool-call stream accumulation → bounded literal `search_snapshot` → assistant replay plus tool result → final answer. Models that never call the tool currently fail explicitly, rather than silently answering without evidence.

## Reproductions and fix

The new `scripts/debug-on-demand-isolated.mjs` runs the installed rc.1 public `LlmRuntime` with a local synthetic `LlmAdapter`, isolated HOME/DSH_HOME, scrubbed environment and denied socket/fetch access. The normal tool-call → search → tool-result/replay → answer chain succeeds. It compares messages against public `BlockAssembler`, `createAssistantMessage` and `createToolResultMessage` shapes.

Concrete frontend omission reproduced: the earlier `transcriptOf` kept only the first 1,600 characters of each user/assistant message and ignored tool nodes. A synthetic assistant text of `"x".repeat(1601) + "needle-value"` becomes a nonempty snapshot without the value. A functioning synthetic search returns no hits. A tool-only projection becomes empty. This is not evidence of a broken backend tool protocol. The old stateless frontend owner has since been removed; first-send transport is now the shared controller's open/send path. The client owner removed per-message prefix clipping and includes completed `tool-result` text (not running calls). The debug script now checks the repaired positive path: after-character-1600 and completed-tool evidence both reach the installed public runtime and are found, while a >60k synthetic message still projects only the final 48k. It extracts only this pure projection, never starts the client or reads sessions.

Distinct model failure reproduced: a local adapter throwing public `LlmError("Synthetic model does not support tools", "UNSUPPORTED_TOOLS")` is normalized by `LlmRuntime` into `finish.reason.failure`. The backend previously discarded that detail and returned only `LLM did not complete successfully: error`. A model that merely returns text without searching is separately rejected; neither case makes a fallback request. Narrow fix landed in `lib/context-search.js:23–31,118,126`: retain only bounded public failure code/message (128/1000 UTF-16 units), without retries, history reads or protocol changes. Opaque request IDs, replay state and causes are not added to errors. A no-tool completion now states explicitly that the selected model must support tool calls and no fallback was sent. This is a diagnostic fix, not a claim that an unsupported model can now search.

## Public API and safety boundaries

- Production continues to use the injected public `llm.stream` API and its `GenerateOptions`/`StreamChunk` vocabulary. The synthetic check uses public `LlmRuntime.registerAdapter`, `LlmAdapter`, `LlmError`, `BlockAssembler`, `createAssistantMessage`, and `createToolResultMessage` from the installed host, rather than simulating another provider protocol. Installed version checked: `0.2.2-rc.1`.
- No supported successful-call counterexample to the current accumulator was established. It was deliberately **not rewritten** just because a public assembler exists. Existing delta-only, block-end, normal-stop-with-tool-call and pi-ai replay tests remain green.
- `lib/index.js` was inspected but not edited by this worker. Existing public `resolveChildDepth`, `childSessionMeta`, `captureDelegatedPolicyOverrides`, and `appendDelegatedPolicyOverrides` remain in use for child lineage/permissions. The script verifies these exports exist on the installed host.
- Full `subagents.startActivation` is not a substitute: it appends parent catalog facts and changes lineage/persistence semantics (see `subagent-integration.md`).
- Authorization remains caller-owned; host rejects absent/blank on-demand snapshots before any model call and retains only the last 48,000 UTF-16 units. No parent history read, all-context fallback, no-context fallback, retry, alternate model or child composition change was added.
- Search limits, signal racing, final-output-only delivery, temporary-session close/disposal barriers and model/reasoning selection are unchanged. Added host regression verifies missing snapshot vs no-tool vs provider failure, including one request only and no partial answer. Existing backend tests cover cancellation, deadlines, storage cleanup and delegated policy helpers.

## Verification

Run from the plugin root:

```sh
node scripts/debug-on-demand-isolated.mjs
node --test test/context-search.test.js test/host-features.test.js
npm run check
```

Results: isolated installed-public-API check passed; 38 backend tests passed; syntax check passed (including the concurrently modularized client files). The public failure assertion was first run against the old backend and failed with `LLM did not complete successfully: error`, then passed after the fix. A test-harness teardown typo (`ctx.dispose` rather than public `ctx.fiber.dispose`) was corrected before recording that failure.

Final UI verification: in a normally installed isolated profile, source text placed a marker after character5400; the native on-demand child confirmed the searched evidence. Source references stayed out of the btw message list. The full suite passed139 tests; see [verification.md](verification.md) for the current scope.

Remaining boundary: the projection fix is verified with synthetic evidence and a native UI/local-adapter run; no real user snapshot or external provider was tested. The synthetic tests do not establish the exact cause of the user's particular report. Real provider tool support and the exact authorized snapshot must be distinguished before further fixes; backend correctness cannot restore evidence the client omitted.
