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
const POSITIONS = [{ value: "dock", label: "输入框上方" }, { value: "sidebar", label: "右侧栏" }, { value: "overlay", label: "浮动小窗" }];
const modelValue = (mode, provider, model) => mode === "custom" ? provider + " / " + model : "default";

const DEFAULT_PREFS = { askContextMode: "recent", tempContextMode: "none", askModelMode: "default", tempModelMode: "default",
	askProvider: "", askModel: "", tempProvider: "", tempModel: "", showAskChip: true, enableSlash: true, showTempEntry: true, showGlobalTempEntry: true,
	chipPresentation: "dock", slashPresentation: "dock", headerPresentation: "sidebar", tempWindowPinned: true, tempRememberPosition: true };

/**
 * Full wiring environment. choiceKind "select" mirrors the plain fallback
 * helper, "native" an anchor-button Menu helper — the card must survive both
 * shapes because that branch belongs to the supplied helper, not to it.
 */
function makeEnv({ config = {}, snapshot = { status: "ready", writable: true, value: {} }, scope = "present", error = "", choiceKind = "select", SegmentedControl } = {}) {
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
		ModelSelect: ModelSelectStub, choiceSelect, SegmentedControl, modelValue, CONTEXT_OPTIONS,
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
const SWITCH_LABELS = ["输入框「顺便问」按钮", "/btw", "右上角入口"];
const POSITION_LABELS = SWITCH_LABELS.map(label => label + "的打开位置");
const POSITION_KEYS = ["chipPresentation", "slashPresentation", "headerPresentation"];

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

test("each entry has its own position directly below the switch", () => {
	const env = makeEnv({ config: { askModelMode: "custom", askProvider: "p", askModel: "m", tempContextMode: "all", slashPresentation: "overlay" } });
	const tree = env.render();
	assert.equal(tree.props.className, "dsh-btw-settings");
	assert.deepEqual(all(tree, (n) => n.props.className === "dsh-btw-set-groupTitle").map((n) => n.children[0]), ["默认", "入口与位置"]);
	assert.deepEqual(all(tree, (n) => n.props.className === "dsh-btw-set-group").map((n) => n.props["aria-label"]), ["默认", "入口与位置"]);
	assert.deepEqual(env.choiceCalls.map((c) => c.props.label), ["上下文", ...POSITION_LABELS]);
	for (const [i, row] of all(tree, n => n.props.className === "dsh-btw-set-entry").entries()) {
		assert.equal(env.switches(row)[0].props["aria-label"], SWITCH_LABELS[i]);
		assert.equal(all(row.children[1], n => n.type === "select")[0].props["aria-label"], POSITION_LABELS[i]);
	}
	assert.equal(env.select("上下文").props.value, "recent", "shared context shows the ask value");
	assert.deepEqual(POSITION_LABELS.map(label => env.select(label).props.value), ["dock", "overlay", "sidebar"]);
	for (const label of POSITION_LABELS) assert.deepEqual(JSON.parse(JSON.stringify(env.select(label).options)), POSITIONS);
	assert.deepEqual(env.switches(tree).map((n) => n.props["aria-label"]), ["临时聊天", ...SWITCH_LABELS]);
	const defaults = all(tree, n => n.props["aria-label"] === "默认")[0];
	assert.equal(defaults.children[1].type, "label", "the native temporary-chat switch is above context");
	assert.equal(env.switchFor(defaults, "临时聊天").props.checked, true);
	assert.equal(texts(tree).includes("打开位置"), false);
	assert.equal(texts(tree).includes("位置仅用于对话页，主页仍打开临时聊天。"), false);
	assert.equal(texts(tree).some((text) => /高级设置|窗口固定|记忆位置/.test(text)), false);
	assert.equal(texts(tree).includes("btw 设置"), false);
	assert.equal(env.models(tree).length, 1);
	assert.equal(env.models(tree)[0].props.value, "p / m");
});

test("values flow through the supplied helpers and writes go only through saveSetting/saveModel", () => {
	const env = makeEnv({ config: { askModelMode: "custom", askProvider: "p", askModel: "m", chipPresentation: "sidebar", showAskChip: false } });
	const tree = env.render();
	// Choice rows receive the projected prefs value plus the shared option
	// lists by identity — the card never rebuilds a menu.
	assert.deepEqual({ ...env.select("上下文").props }, { label: "上下文", value: "recent", disabled: false, onChange: env.select("上下文").props.onChange });
	assert.equal(env.select("上下文").options === CONTEXT_OPTIONS, true);
	const models = env.models(tree);
	assert.equal(models.length, 1);
	assert.equal(models[0].props.value, "p / m");
	assert.equal(env.switchFor(tree, "输入框「顺便问」按钮").props.checked, false);
	env.select("上下文").props.onChange("all");
	assert.equal(env.choiceCalls.some(c => c.props.label === POSITION_LABELS[0]), false);
	env.select(POSITION_LABELS[1]).props.onChange("global");
	env.select(POSITION_LABELS[1]).props.onChange("overlay");
	env.select(POSITION_LABELS[2]).props.onChange("dock");
	models[0].props.onChange('["p","m2"]');
	for (const label of ["临时聊天", ...SWITCH_LABELS]) env.switchFor(tree, label).props.onChange({ target: { checked: false } });
	assert.deepEqual(env.writes.settings, [["askContextMode", "all"], ["tempContextMode", "all"], ["slashPresentation", "overlay"], ["headerPresentation", "dock"], ["showGlobalTempEntry", false], ["showAskChip", false], ["enableSlash", false], ["showTempEntry", false]]);
	assert.deepEqual(env.writes.models, [["ask", '["p","m2"]'], ["temp", '["p","m2"]']]);
	assert.deepEqual(env.prefsState, { ...DEFAULT_PREFS, askModelMode: "custom", askProvider: "p", askModel: "m", chipPresentation: "sidebar", showAskChip: false });
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
		env.select("上下文").props.onChange("all");
		for (const label of POSITION_LABELS) env.select(label).props.onChange("overlay");
		for (const label of ["临时聊天", ...SWITCH_LABELS]) env.switchFor(tree, label).props.onChange({ target: { checked: false } });
		for (const model of env.models(tree)) model.props.onChange("default");
		assert.deepEqual(env.writes.settings, []);
		assert.deepEqual(env.writes.models, []);
	}
	const ready = makeEnv({});
	const readyTree = ready.render();
	assert.equal(all(readyTree, (n) => texts(n).includes(READ_ONLY_COPY)).length, 0);
	assert.equal(ready.select("上下文").props.disabled, false);
});

test("form receipt errors render once, in error styling, and never block the controls", () => {
	const env = makeEnv({ error: "设置未保存，请重试" });
	const tree = env.render();
	const errors = all(tree, (n) => typeof n.props.className === "string" && n.props.className.split(" ").includes("dsh-btw-set-error"));
	assert.equal(errors.length, 1);
	assert.equal(errors[0].props.role, "status");
	assert.deepEqual(texts(errors[0]), ["设置未保存，请重试"]);
	assert.equal(env.select("上下文").props.disabled, false);
	const quiet = makeEnv({});
	assert.equal(all(quiet.render(), (n) => typeof n.props.className === "string" && n.props.className.includes("dsh-btw-set-error")).length, 0);
});

test("the card is agnostic to the supplied picker shape (native menu or fallback select)", () => {
	for (const choiceKind of ["native", "select"]) {
		const env = makeEnv({ choiceKind });
		const tree = env.render();
		const anchors = all(tree, (n) => n.props["aria-haspopup"] === "menu");
		const selects = all(tree, (n) => n.type === "select");
		assert.equal(anchors.length, choiceKind === "native" ? 4 : 0);
		assert.equal(selects.length, choiceKind === "select" ? 4 : 0);
		const control = (anchors[0] || selects[0]).props;
		control.onChange ? control.onChange("all") : control.onClick("all");
		assert.deepEqual(env.writes.settings, [["askContextMode", "all"], ["tempContextMode", "all"]]);
	}
});

test("position uses the official segmented control when the host exposes it", () => {
	function SegmentedControl() {}
	const env = makeEnv({ SegmentedControl });
	const controls = all(env.render(), n => n.type === SegmentedControl).map(n => n.props);
	assert.deepEqual(controls.map(c => c.label), POSITION_LABELS);
	assert.deepEqual(controls.map(c => c.value), ["dock", "dock", "sidebar"]);
	assert.deepEqual(env.choiceCalls.map(c => c.props.label), ["上下文"]);
	for (const control of controls) {
		assert.deepEqual(JSON.parse(JSON.stringify(control.options)), POSITIONS);
		control.onChange("overlay");
	}
	assert.deepEqual(env.writes.settings, POSITION_KEYS.map(key => [key, "overlay"]));
});

test("turning an entry off only folds its picker; turning it back on restores its value", () => {
	for (const [i, key] of ["showAskChip", "enableSlash", "showTempEntry"].entries()) {
		const env = makeEnv({ config: { [key]: false, [POSITION_KEYS[i]]: "overlay" } });
		const controls = tree => all(tree, n => n.type === "select").map(n => n.props);
		let tree = env.render();
		assert.deepEqual(controls(tree).map(c => c["aria-label"]), ["上下文", ...POSITION_LABELS.filter((_, j) => i !== j)]);
		env.switchFor(tree, SWITCH_LABELS[i]).props.onChange({ target: { checked: true } });
		assert.deepEqual(env.writes.settings, [[key, true]]);
		env.prefsState[key] = true;
		tree = env.render();
		assert.equal(controls(tree).find(c => c["aria-label"] === POSITION_LABELS[i]).value, "overlay");
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
	assert.ok(css.includes(".dsh-btw-set-row:not(.dsh-btw-set-rowToggle,.dsh-btw-set-position)>.dsh-btw-set-ctrl"));
	assert.match(css, /\.dsh-btw-set-entry>\.dsh-btw-set-position\{[^}]*justify-content:flex-end/);
	assert.ok(css.includes(".dsh-btw-set-toggle:focus-visible"));
	assert.ok(css.includes(".dsh-btw-set-toggle:disabled"));
	assert.ok(css.includes(".dsh-btw-set-toggle:checked"));
	assert.ok(css.includes("prefers-reduced-motion"));
});
