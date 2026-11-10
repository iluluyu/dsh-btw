import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Exercise the shipped handoff in isolation with a deferred host commit.
function fixture() {
	const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
	const code = source.slice(source.indexOf("\t\tfunction showNativeFullscreen("), source.indexOf("\n\t\tfunction presentTemp("));
	let mounted = "source", listener, target, toggles = 0, fallback = 0, timers = new Map(), next = 0;
	const events = new Map(), controllers = new Map();
	const right = { mounted: { getSnapshot: () => mounted, subscribe(fn) { listener = fn; return () => { listener = null; }; } }, openTab() {}, commandTarget: () => target, isTargetCurrent: () => true, toggleFullscreen: () => toggles++ };
	const controller = { id: "c", store: { state: { originId: "source", phase: "configuring", presentation: "dock" }, patch(fields) { Object.assign(this.state, fields); } }, showSidebar() { this.store.state.presentation = "sidebar"; this.sidebarTab = { tabId: "btw" }; } };
	controllers.set("c", controller);
	const context = { window: { innerWidth: 1280 }, sidebar: right, globalLayout: { selectPanel() {} }, controllers, unloading: false, showPage() { fallback++; }, beginFullscreenWatch(controller) { controller.fullscreenReturn = {}; controller.stopFullscreenWatch = () => {}; }, document: { addEventListener(name, fn) { events.set(name, fn); }, removeEventListener(name) { events.delete(name); } }, setTimeout(fn) { const id = ++next; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); } };
	vm.runInNewContext(code + "\nthis.run = showNativeFullscreen;", context);
	return { controller, run: () => context.run(controller), mount(value) { mounted = value; listener?.(); }, target(value) { target = value; }, flush() { const work = [...timers.values()]; timers.clear(); work.forEach(fn => fn()); }, gesture() { events.get("pointerdown")?.(); }, result: () => ({ toggles, fallback }) };
}

test("waits for mount and committed native target", () => {
	const f = fixture(); f.mount(undefined); f.run(); f.mount("source");
	f.target({ sessionId: "source", tabId: "btw", host: "dock" }); f.flush();
	assert.deepEqual(f.result(), { toggles: 1, fallback: 0 });
});

test("never toggles another tab and user gesture cancels", () => {
	const f = fixture(); f.run(); f.target({ sessionId: "source", tabId: "other", host: "dock" }); f.flush();
	assert.deepEqual(f.result(), { toggles: 0, fallback: 1 });
	const g = fixture(); g.run(); g.gesture(); g.target({ sessionId: "source", tabId: "btw", host: "dock" }); g.flush();
	assert.deepEqual(g.result(), { toggles: 0, fallback: 0 });
});

function infoFixture() {
	const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
	const code = source.slice(source.indexOf("\t\tfunction beginFullscreenWatch("), source.indexOf("\n\t\tfunction BtwSidebarBody("));
	let now = 100, returns = 0, toggles = 0, targetId = "btw", tabs = [{ sessionId: "source", tabId: "btw", kind: "btw-temp" }];
	const events = new Map(), windows = new Map(), controllers = new Map();
	const right = { mounted: { getSnapshot: () => "source" }, openTabs: { getSnapshot: () => tabs }, commandTarget: () => ({ sessionId: "source", tabId: targetId, host: "dock" }), isTargetCurrent: () => true, toggleFullscreen: () => toggles++ };
	const controller = { id: "c", sidebarTab: { right, sourceId: "source", tabId: "btw" }, store: { state: { originId: "source", presentation: "sidebar", phase: "active", draft: "kept" } } }; controllers.set("c", controller);
	const context = { sidebar: right, controllers, unloading: false, Date: { now: () => now }, document: { addEventListener: (n, f) => events.set(n, f), removeEventListener: n => events.delete(n) }, window: { innerWidth: 1280, addEventListener: (n, f) => windows.set(n, f), removeEventListener: n => windows.delete(n) }, presentTemp(c, mode) { assert.equal(c, controller); assert.equal(mode, "dock"); c.stopFullscreenWatch(); returns++; } };
	vm.runInNewContext(code + "\nthis.begin = beginFullscreenWatch; this.observe = observeSidebarInfo;", context);
	const info = full => ({ sidebar: { fullscreen: full, expanded: true }, panel: { isFloating: false }, tab: { id: "btw", visible: true, signal: { aborted: false } } });
	return { controller, context, info, observe: full => context.observe(controller, "source", info(full)), begin: () => context.begin(controller, right, "source", "btw"), gesture: () => { now += 10; events.get("pointerdown")?.(); }, resize: () => { now += 10; windows.get("resize")?.(); }, target: id => { targetId = id; }, tabs: t => { tabs = t; }, result: () => ({ returns, toggles }) };
}

test("native exit returns the same controller only after observed fullscreen and gesture", () => {
	const f = infoFixture(); f.begin(); f.observe(false); assert.equal(f.result().returns, 0);
	f.observe(true); f.gesture(); f.observe(false);
	assert.equal(f.result().returns, 1); assert.equal(f.controller.store.state.draft, "kept");
});

test("resize or foreign tab cannot cause a dock return", () => {
	const f = infoFixture(); f.begin(); f.observe(true); f.gesture(); f.resize(); f.observe(false); f.gesture(); f.observe(false); assert.equal(f.result().returns, 0);
	const g = infoFixture(); g.begin(); g.observe(true); g.gesture(); g.target("other"); g.observe(false); assert.equal(g.result().returns, 0);
});

test("ordinary sidebar reset is one-shot, limited to sole tab and not narrow screens", () => {
	const f = infoFixture(); f.controller.normalSidebarPending = true; f.observe(true); f.observe(true); assert.equal(f.result().toggles, 1);
	const g = infoFixture(); g.controller.normalSidebarPending = true; g.tabs([{ sessionId: "source", tabId: "btw" }, { sessionId: "source", tabId: "other" }]); g.observe(true); assert.equal(g.result().toggles, 0);
	const h = infoFixture(); h.context.window.innerWidth = 600; h.controller.normalSidebarPending = true; h.observe(true); assert.equal(h.result().toggles, 0);
});

test("hide only the sole owned tab", () => {
	const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
	const code = source.slice(source.indexOf("\t\tfunction hideSoleSidebarTab("), source.indexOf("\n\t\tfunction minimizeTemp("));
	let tabs = [{ sessionId: "source", tabId: "btw", kind: "btw-temp" }], hides = 0;
	const right = { mounted: { getSnapshot: () => "source" }, openTabs: { getSnapshot: () => tabs }, active: () => ({ id: "btw" }), hide() { hides++; } };
	const context = { sidebar: right }; vm.runInNewContext(code + "\nthis.run = hideSoleSidebarTab;", context);
	const record = { right, sourceId: "source", tabId: "btw" };
	context.run(record); assert.equal(hides, 1);
	tabs = [...tabs, { sessionId: "source", tabId: "other", kind: "file" }]; context.run(record); assert.equal(hides, 1);
});
