import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function fixture() {
	let factory, timer, active = { id: "default", kind: "guide" }, focusCount = 0;
	const events = new Map(), controllers = new Map();
	const right = {
		mounted: { getSnapshot: () => "source" },
		openTabs: { getSnapshot: () => [{ sessionId: "source", tabId: "btw", kind: "btw-temp" }] },
		active: () => active,
		openTab: () => { active = { id: "btw", kind: "btw-temp" }; },
		focus: () => { focusCount++; active = { id: "btw", kind: "btw-temp" }; },
	};
	const document = { addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) };
	vm.runInNewContext(readFileSync(new URL("../lib/client.controllers.js", import.meta.url), "utf8"), {
		window: { __ModuleLoader__: { load: registration => { factory = registration.factory(); } } }, document,
		setTimeout: fn => { timer = fn; return 1; }, clearTimeout: () => { timer = null; },
	});
	const create = factory.createControllerFactory({
		createStore: state => ({ state, patch(fields) { Object.assign(state, fields); } }),
		emptyTemp: () => ({ originId: "source", presentation: "overlay", phase: "configuring" }),
		controllers, getSidebar: () => right, reserveSurface() {},
		captureSidebarTab: controller => controller.sidebarTab = { right, sourceId: "source", tabId: "btw" },
	});
	const controller = create("id"); controllers.set("id", controller);
	return { controller, events, run: () => timer?.(), override: () => { active = { id: "default", kind: "guide" }; }, count: () => focusCount };
}

test("initial default page gets one correction, later user navigation wins", () => {
	const f = fixture(); f.controller.showSidebar(); f.override(); f.run();
	assert.equal(f.count(), 1); f.override(); f.run(); assert.equal(f.count(), 1);
});

test("a user gesture cancels the pending correction", () => {
	const f = fixture(); f.controller.showSidebar(); f.override(); f.events.get("pointerdown")(); f.run();
	assert.equal(f.count(), 0);
});

test("sidebar opening failure falls back to the small window", () => {
	const f = fixture(); f.controller.store.state.originId = null;
	// Missing source is rejected without disturbing the current small window.
	f.controller.showSidebar(); assert.equal(f.controller.store.state.presentation, "overlay");
});
