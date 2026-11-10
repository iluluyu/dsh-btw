import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Execute the shipped chunk source through the public flat registration
// protocol (mirroring client-loader.js) — never fake chunk exports. The
// factory's synchronous require must stay untouched by this chunk.
function loadSettingsChunk() {
	const sandbox = { window: {} };
	let registration = null;
	sandbox.window.__ModuleLoader__ = { load: (entry) => {
		assert.equal(entry.id, "dsh-btw");
		assert.equal(entry.chunk, "client.settings.js");
		assert.equal(registration, null, "settings chunk registers exactly once");
		registration = entry;
	} };
	vm.runInContext(readFileSync(new URL("../lib/client.settings.js", import.meta.url), "utf8"), vm.createContext(sandbox), { filename: "client.settings.js" });
	assert.ok(registration, "settings chunk self-registers");
	return registration.factory((id) => { throw new Error("settings chunk must not require synchronously: " + id); });
}

// React stub: plain-object tree, like client-features.test.js. The component
// itself is hook-free (stores arrive as suppliers), so createElement suffices.
const createElement = (type, props, ...children) => ({ type, props: props || {}, children });
const React = { createElement };

function all(node, predicate, out = []) {
	if (!node || typeof node !== "object") return out;
	if (Array.isArray(node)) { for (const item of node) all(item, predicate, out); return out; }
	if (predicate(node)) out.push(node);
	for (const child of node.children || []) all(child, predicate, out);
	return out;
}
function texts(node, out = []) {
	if (Array.isArray(node)) { for (const item of node) texts(item, out); return out; }
	if (!node || typeof node !== "object") { if (typeof node === "string" && node.trim()) out.push(node.trim()); return out; }
	for (const child of node.children || []) texts(child, out);
	return out;
}

// The option lists and helpers keep the exact contracts the views module
// supplies: identity of the arrays matters (the card must not clone or
// rebuild menus), and modelValue composes the configured-model value.
const CONTEXT_OPTIONS = [{ value: "none", label: "无上下文" }, { value: "recent", label: "最近对话" }, { value: "on-demand", label: "按需搜索近期快照" }, { value: "all", label: "全部对话" }];
const PRESENTATIONS = [{ value: "overlay", label: "小窗" }, { value: "sidebar", label: "侧边栏" }, { value: "global", label: "全屏" }];
const modelValue = (mode, provider, model) => mode === "custom" ? provider + " / " + model : "default";

const DEFAULT_PREFS = { askContextMode: "recent", tempContextMode: "none", askModelMode: "default", tempModelMode: "default",
	askProvider: "", askModel: "", tempProvider: "", tempModel: "", showAskChip: true, enableSlash: true, showTempEntry: true,
	tempPresentation: "overlay", tempWindowPinned: true, tempRememberPosition: true };

/**
 * Full wiring environment. choiceKind "select" mirrors the plain fallback
 * helper, "native" an anchor-button Menu helper — the card must survive both
 * shapes because that branch belongs to the supplied helper, not to it.
 */
function makeEnv({ config = {}, snapshot = { status: "ready", writable: true, value: {} }, scope = "present", error = "", choiceKind = "select" } = {}) {
	const moduleExports = loadSettingsChunk();
	const prefsState = { ...DEFAULT_PREFS, ...config };
	const writes = { settings: [], models: [] };
	const choiceCalls = [];
	const choiceSelect = (props, options) => {
		choiceCalls.push({ props, options });
		return choiceKind === "native"
			? createElement("button", { type: "button", "aria-haspopup": "menu", "aria-label": props.label, "aria-expanded": false, disabled: props.disabled, onClick: props.onChange })
			: createElement("select", { "aria-label": props.label, value: props.value, disabled: props.disabled, onChange: props.onChange },
				...options.map((option) => createElement("option", { key: option.value, value: option.value }, option.label)));
	};
	const ModelSelectStub = ({ value, onChange, disabled }) => createElement("span", { "aria-label": "模型", "data-model-value": value, disabled, onChange });
	const settingsErrors = { error, use: () => ({ error }) };
	const scopeObject = scope === "absent" ? null : { getSnapshot: () => snapshot };
	const BtwSettings = moduleExports.createSettings({
		React, prefs: { state: prefsState, use: () => prefsState }, settingsErrors,
		getSettingsScope: () => scopeObject,
		saveSetting: (key, value) => writes.settings.push([key, value]),
		saveModel: (prefix, value) => writes.models.push([prefix, value]),
		ModelSelect: ModelSelectStub, choiceSelect, modelValue, CONTEXT_OPTIONS, PRESENTATIONS,
		primitives: undefined,
	});
	return { moduleExports, BtwSettings, prefsState, writes, choiceCalls, ModelSelectStub,
		render: () => BtwSettings(),
		select: (label) => { const call = choiceCalls.find((c) => c.props.label === label); assert.ok(call, "picker row " + label); return call; },
		switches: (tree) => all(tree, (n) => n.type === "input" && n.props.role === "switch"),
		switchFor: (tree, label) => { const node = all(tree, (n) => n.type === "input" && n.props.role === "switch" && n.props["aria-label"] === label)[0]; assert.ok(node, "switch " + label); return node; },
		models: (tree) => all(tree, (n) => n.type === ModelSelectStub) };
}

const READ_ONLY_COPY = "设置不可写或尚未加载";
const SWITCH_LABELS = ["小窗默认固定", "记忆项目内的小窗位置和大小（仅数值）", "显示侧问按钮", "启用 /btw", "显示临时聊天入口"];

test("chunk registers through the module loader and exports the exact integration contract", () => {
	const moduleExports = loadSettingsChunk();
	assert.deepEqual(Object.keys(moduleExports).sort(), ["CSS", "createSettings"]);
	assert.equal(typeof moduleExports.createSettings, "function");
	assert.equal(typeof moduleExports.CSS, "string");
	assert.ok(moduleExports.CSS.length > 0);
	// The CSS string is spliced into host injection paths: keep it free of
	// template-literal hazards and of stray hosts' markers.
	assert.equal(/`|\$\{/.test(moduleExports.CSS), false);
});

test("card groups the unchanged fields into 聊天默认 / 窗口行为 / 入口 with quiet one-line copy", () => {
	const env = makeEnv({ config: { askModelMode: "custom", askProvider: "p", askModel: "m" } });
	const tree = env.render();
	assert.equal(tree.props.className, "dsh-btw-settings");
	assert.deepEqual(all(tree, (n) => n.props.className === "dsh-btw-set-groupTitle").map((n) => n.children[0]), ["聊天默认", "窗口行为", "入口"]);
	assert.deepEqual(all(tree, (n) => n.props.className === "dsh-btw-set-group").map((n) => n.props["aria-label"]), ["聊天默认", "窗口行为", "入口"]);
	// Existing accessible names survive: the three choice rows keep their
	// aria labels, the five toggles keep their visible copy as switch labels.
	assert.deepEqual(env.choiceCalls.map((c) => c.props.label), ["侧问默认上下文", "临时聊天默认上下文", "默认显示模式"]);
	assert.deepEqual(env.switches(tree).map((n) => n.props["aria-label"]), SWITCH_LABELS);
	// The size-memory copy must stay 大小 (size), never collapse to width.
	assert.ok(SWITCH_LABELS[1].includes("大小"));
	// Quiet descriptions only: no paragraphs, no headline, no duplicated
	// in-card title re-stating what the host row already says.
	assert.equal(all(tree, (n) => n.type === "p" || n.type === "strong").length, 0);
	assert.equal(texts(tree).includes("btw 设置"), false);
	assert.equal(texts(tree).some((text) => text.length > 40), false, "copy stays one quiet line");
	// The on-demand caveat survives as a row hint, not a paragraph.
	assert.ok(texts(tree).includes("按需模式只使用授权的近期文本快照，不是完整历史"));
	// One product in visible copy: ask* seats read 输入框旁的 btw, temp*
	// seats read 独立 btw; no 侧问/临时聊天 split, no 恢复聊天 wording.
	assert.ok(texts(tree).includes("输入框旁的 btw 默认上下文"));
	assert.ok(texts(tree).includes("独立 btw 默认上下文"));
	assert.ok(texts(tree).includes("显示输入框旁的 btw 按钮"));
	assert.ok(texts(tree).includes("显示独立 btw 入口"));
	assert.equal(texts(tree).some((text) => /侧问|临时聊天|恢复/.test(text)), false, "visible copy stays one product, no restore-chat wording");
	// Accessible names keep the historical labels for compatibility.
	assert.deepEqual(all(tree, (n) => n.type === "input" && n.props.role === "switch").map((n) => n.props["aria-label"]), SWITCH_LABELS);
});

test("values flow through the supplied helpers and writes go only through saveSetting/saveModel", () => {
	const env = makeEnv({ config: { askModelMode: "custom", askProvider: "p", askModel: "m", tempPresentation: "sidebar", showAskChip: false } });
	const tree = env.render();
	// Choice rows receive the projected prefs value plus the shared option
	// lists by identity — the card never rebuilds a menu.
	assert.deepEqual({ ...env.select("侧问默认上下文").props }, { label: "侧问默认上下文", value: "recent", disabled: false, onChange: env.select("侧问默认上下文").props.onChange });
	assert.equal(env.select("侧问默认上下文").options === CONTEXT_OPTIONS, true);
	assert.equal(env.select("临时聊天默认上下文").options === CONTEXT_OPTIONS, true);
	assert.equal(env.select("默认显示模式").options === PRESENTATIONS, true);
	assert.equal(env.select("默认显示模式").props.value, "sidebar");
	// Both model rows compute their value via the supplied modelValue and
	// carry the prefix ("ask"/"temp") into saveModel.
	const models = env.models(tree);
	assert.equal(models.length, 2);
	assert.equal(models[0].props.value, "p / m");
	assert.equal(models[1].props.value, "default");
	// Toggles reflect current state.
	assert.equal(env.switchFor(tree, "显示侧问按钮").props.checked, false);
	assert.equal(env.switchFor(tree, "小窗默认固定").props.checked, true);
	// Fire every control once, in tree order.
	env.select("侧问默认上下文").props.onChange("all");
	models[0].props.onChange('["p","m2"]');
	env.select("临时聊天默认上下文").props.onChange("on-demand");
	models[1].props.onChange("default");
	env.select("默认显示模式").props.onChange("global");
	for (const label of SWITCH_LABELS) env.switchFor(tree, label).props.onChange({ target: { checked: false } });
	assert.deepEqual(env.writes.settings, [["askContextMode", "all"], ["tempContextMode", "on-demand"], ["tempPresentation", "global"],
		["tempWindowPinned", false], ["tempRememberPosition", false], ["showAskChip", false], ["enableSlash", false], ["showTempEntry", false]]);
	assert.deepEqual(env.writes.models, [["ask", '["p","m2"]'], ["temp", "default"]]);
	// Exactly the ten unchanged fields; the card never touches host models
	// or its supplied state.
	assert.deepEqual([...new Set([...env.writes.settings.map((w) => w[0]), ...env.writes.models.map((w) => w[0] + "*")])].sort(),
		["ask*", "askContextMode", "enableSlash", "showAskChip", "showTempEntry", "temp*", "tempContextMode", "tempPresentation", "tempRememberPosition", "tempWindowPinned"]);
	assert.deepEqual(env.prefsState, { ...DEFAULT_PREFS, askModelMode: "custom", askProvider: "p", askModel: "m", tempPresentation: "sidebar", showAskChip: false });
});

test("scope snapshot gates every control and surfaces one read-only status", () => {
	for (const variant of [{ snapshot: { status: "loading", writable: true } }, { snapshot: { status: "ready", writable: false, value: {} } }, { scope: "absent" }, { snapshot: null, scope: "present" }]) {
		const env = makeEnv(variant);
		const tree = env.render();
		for (const call of env.choiceCalls) assert.equal(call.props.disabled, true, "picker disabled: " + call.props.label);
		for (const model of env.models(tree)) assert.equal(model.props.disabled, true);
		for (const node of env.switches(tree)) assert.equal(node.props.disabled, true);
		const status = all(tree, (n) => n.props.role === "status" && texts(n).includes(READ_ONLY_COPY));
		assert.equal(status.length, 1, "one read-only notice");
		// Writes stay blocked even if a control's handler is fired anyway.
		env.select("默认显示模式").props.onChange("global");
		for (const label of SWITCH_LABELS) env.switchFor(tree, label).props.onChange({ target: { checked: false } });
		for (const model of env.models(tree)) model.props.onChange("default");
		assert.deepEqual(env.writes.settings, []);
		assert.deepEqual(env.writes.models, []);
	}
	// Ready + writable: no read-only notice, controls enabled.
	const ready = makeEnv({});
	const readyTree = ready.render();
	assert.equal(all(readyTree, (n) => texts(n).includes(READ_ONLY_COPY)).length, 0);
	assert.equal(ready.select("默认显示模式").props.disabled, false);
});

test("form receipt errors render once, in error styling, and never block the controls", () => {
	const env = makeEnv({ error: "设置未保存，请重试" });
	const tree = env.render();
	const errors = all(tree, (n) => typeof n.props.className === "string" && n.props.className.split(" ").includes("dsh-btw-set-error"));
	assert.equal(errors.length, 1);
	assert.equal(errors[0].props.role, "status");
	assert.deepEqual(texts(errors[0]), ["设置未保存，请重试"]);
	assert.equal(env.select("侧问默认上下文").props.disabled, false);
	const quiet = makeEnv({});
	assert.equal(all(quiet.render(), (n) => typeof n.props.className === "string" && n.props.className.includes("dsh-btw-set-error")).length, 0);
});

test("the card is agnostic to the supplied picker shape (native menu or fallback select)", () => {
	for (const choiceKind of ["native", "select"]) {
		const env = makeEnv({ choiceKind });
		const tree = env.render();
		const anchors = all(tree, (n) => n.props["aria-haspopup"] === "menu");
		const selects = all(tree, (n) => n.type === "select");
		assert.equal(anchors.length, choiceKind === "native" ? 3 : 0);
		assert.equal(selects.length, choiceKind === "select" ? 3 : 0);
		// Both shapes funnel user intent into the same onChange → saveSetting.
		const control = (anchors[0] || selects[0]).props;
		control.onChange ? control.onChange("all") : control.onClick("all");
		assert.deepEqual(env.writes.settings.at(-1), ["askContextMode", "all"]);
	}
});

test("CSS styles every rendered class and carries the responsive/a11y/token contract", () => {
	const moduleExports = loadSettingsChunk();
	const css = moduleExports.CSS;
	const rendered = [makeEnv({}), makeEnv({ scope: "absent", error: "设置未保存，请重试" })].map((env) => env.render());
	const classes = new Set();
	for (const tree of rendered) for (const node of all(tree, () => true)) {
		if (typeof node.props.className === "string") for (const token of node.props.className.split(" ")) if (token.startsWith("dsh-btw")) classes.add(token);
	}
	assert.ok(classes.size >= 10);
	for (const token of classes) assert.ok(css.includes("." + token + "{"), "CSS rule for " + token);
	// Native panel radius, dark/light alias tokens with fallbacks, container
	// responsiveness, focus/disabled/read-only switch states, motion safety.
	assert.ok(css.includes("--dsw-radius-panel"));
	assert.ok(css.includes("--dsw-alias-label-primary"));
	assert.ok(css.includes("@container"));
	assert.ok(css.includes(".dsh-btw-set-rowToggle{cursor:pointer;flex-wrap:nowrap;}"));
	assert.ok(css.includes(".dsh-btw-set-row:not(.dsh-btw-set-rowToggle)>.dsh-btw-set-ctrl"));
	assert.ok(css.includes(".dsh-btw-set-toggle:focus-visible"));
	assert.ok(css.includes(".dsh-btw-set-toggle:disabled"));
	assert.ok(css.includes(".dsh-btw-set-toggle:checked"));
	assert.ok(css.includes("prefers-reduced-motion"));
});
