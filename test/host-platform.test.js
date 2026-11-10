/** Deterministic platform-injection tests for lib/host-platform.js.
 * These exercise the win32/darwin/linux BRANCHES with injected environments
 * on this development host — they do NOT claim a real Windows run. */
import assert from "node:assert/strict";
import test from "node:test";
import { hostEnvironment, ownerDead, processIdentity, retryWindowsBusy, syncDirectory, validOwner } from "../lib/host-platform.js";

const code = c => Object.assign(new Error(c), { code: c });
const BOOT = "11111111-2222-3333-4444-555555555555";
const statOf = ticks => `(comm) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 ${ticks} 1`;
const legacyOwner = { pid: 123, bootId: BOOT, startTicks: "9999" };
const portableOwner = { pid: 123, kind: "signal0" };

const env = overrides => ({
	platform: "linux",
	readFile: async () => { throw Error("unexpected /proc read"); },
	openFile: async () => { throw Error("unexpected directory open"); },
	signal0: () => { throw Error("unexpected signal probe"); },
	...overrides,
});
const procEnv = (bootId = BOOT, statByPid = { 123: statOf("9999") }) => env({
	readFile: async (path, encoding) => {
		assert.equal(encoding, "utf8");
		if (path === "/proc/sys/kernel/random/boot_id") return `${bootId}\n`;
		const match = /^\/proc\/(\d+)\/stat$/.exec(path);
		if (match && statByPid[Number(match[1])] !== undefined) return statByPid[match[1]];
		throw Object.assign(code("ENOENT"), { path });
	},
});

test("processIdentity keeps /proc bootId/startTicks on linux and writes portable signal0 owners elsewhere", async () => {
	assert.deepEqual(await processIdentity(123, procEnv()), legacyOwner);
	for (const platform of ["win32", "darwin"]) {
		const unused = env({ platform });
		assert.deepEqual(await processIdentity(123, unused), portableOwner, `${platform} never touches /proc`);
	}
	await assert.rejects(processIdentity(0, env()), /无法确认进程身份/);
	await assert.rejects(processIdentity(1.5, env()), /无法确认进程身份/);
});

test("validOwner accepts both owner generations and rejects malformed ones", () => {
	assert.equal(validOwner(legacyOwner), true);
	assert.equal(validOwner(portableOwner), true);
	assert.equal(validOwner({ pid: 123 }), false);
	assert.equal(validOwner({ pid: 123, kind: "pidfile" }), false);
	assert.equal(validOwner({ pid: 123, kind: "signal0", bootId: BOOT }), false); // hybrid without startTicks is malformed
	assert.equal(validOwner({ pid: 123, bootId: BOOT, kind: "signal0" }), false); // startTicks missing
	assert.equal(validOwner({ pid: 123, bootId: "zz", startTicks: "9" }), false);
	assert.equal(validOwner({ pid: 123, bootId: BOOT, startTicks: "x" }), false);
	assert.equal(validOwner({ pid: 0, kind: "signal0" }), false);
	assert.equal(validOwner({ pid: -1, kind: "signal0" }), false);
	assert.equal(validOwner(null), false);
	assert.equal(validOwner("x"), false);
});

test("ownerDead: linux /proc matrix — only provable death is death", async () => {
	// same boot + same startTicks: alive
	assert.equal(await ownerDead(legacyOwner, procEnv()), false);
	// different boot id: dead
	assert.equal(await ownerDead(legacyOwner, procEnv("22222222-2222-3333-4444-555555555555")), true);
	// same boot, reused pid with different startTicks: dead
	assert.equal(await ownerDead(legacyOwner, procEnv(BOOT, { 123: statOf("10000") })), true);
	// missing /proc/<pid>/stat (ENOENT + exact path): dead
	assert.equal(await ownerDead(legacyOwner, procEnv(BOOT, {})), true);
	// permission-ambiguous stat read: alive
	assert.equal(await ownerDead(legacyOwner, env({ readFile: async () => { throw code("EACCES"); } })), false);
	// unreadable boot_id: alive
	assert.equal(await ownerDead(legacyOwner, env({ readFile: async path => {
		if (path === "/proc/sys/kernel/random/boot_id") throw code("EIO");
		throw Error("unexpected");
	} })), false);
	// malformed boot_id: alive
	assert.equal(await ownerDead(legacyOwner, procEnv("not-a-boot-id")), false);
});

test("ownerDead: legacy /proc owners are unverifiable and always kept off linux", async () => {
	for (const platform of ["win32", "darwin"]) {
		assert.equal(await ownerDead(legacyOwner, env({ platform })), false, `${platform} keeps /proc records`);
	}
});

test("ownerDead: portable signal0 owners — ONLY ESRCH proves death", async () => {
	const signal0Env = behavior => env({ platform: "win32", signal0: behavior });
	// alive (also the PID-reuse shape: some live process answers for the pid)
	assert.equal(await ownerDead(portableOwner, signal0Env(() => {})), false);
	// EPERM: exists but no permission — ambiguous, kept
	assert.equal(await ownerDead(portableOwner, signal0Env(() => { throw code("EPERM"); })), false);
	assert.equal(await ownerDead(portableOwner, signal0Env(() => { throw code("EINVAL"); })), false);
	// ESRCH: pid gone — the only provable death
	assert.equal(await ownerDead(portableOwner, signal0Env(() => { throw code("ESRCH"); })), true);
	// unknown owner schema is never actionable
	assert.equal(await ownerDead({ pid: 123, kind: "other" }, signal0Env(() => { throw code("ESRCH"); })), false);
	assert.equal(await ownerDead(null, signal0Env(() => { throw code("ESRCH"); })), false);
	// portable owners are checked the same way on darwin/linux hosts
	assert.equal(await ownerDead(portableOwner, env({ platform: "darwin", signal0: () => { throw code("ESRCH"); } })), true);
	assert.equal(await ownerDead(portableOwner, env({ platform: "linux", signal0: () => {} })), false);
});

test("syncDirectory is POSIX-strict on linux/darwin", async () => {
	for (const platform of ["linux", "darwin"]) {
		const calls = [];
		const ok = env({ platform, openFile: async () => {
			calls.push("open");
			return { sync: async () => calls.push("sync"), close: async () => calls.push("close") };
		} });
		await syncDirectory("d", ok);
		assert.deepEqual(calls, ["open", "sync", "close"], `${platform} fsyncs in order`);
		await assert.rejects(syncDirectory("d", env({ platform, openFile: async () => { throw code("EPERM"); } })), /EPERM/);
		const closed = [];
		await assert.rejects(syncDirectory("d", env({ platform, openFile: async () => ({
			sync: async () => { throw code("EPERM"); }, close: async () => closed.push(1),
		}) })), /EPERM/);
		assert.equal(closed.length, 1, "failed fsync still closes the handle");
	}
});

test("syncDirectory on win32 skips only the known-unsupported dir fsync failures", async () => {
	const win = behavior => env({ platform: "win32", openFile: behavior });
	// open() EISDIR/EPERM: Windows cannot open a directory this way — compat skip
	for (const c of ["EISDIR", "EPERM", "EACCES", "EINVAL"]) {
		await assert.doesNotReject(syncDirectory("d", win(async () => { throw code(c); })), `${c} open is compat`);
	}
	// fsync() EPERM/EINVAL: handle open, FlushFileBuffers unsupported — compat skip
	for (const c of ["EPERM", "EINVAL"]) {
		const closed = [];
		await assert.doesNotReject(syncDirectory("d", win(async () => ({
			sync: async () => { throw code(c); }, close: async () => closed.push(1),
		}))), `${c} fsync is compat`);
		assert.equal(closed.length, 1, "compat skip still closes the handle");
	}
	// arbitrary I/O errors are never swallowed — even on win32
	await assert.rejects(syncDirectory("d", win(async () => { throw code("ENOENT"); })), /ENOENT/);
	await assert.rejects(syncDirectory("d", win(async () => ({
		sync: async () => { throw code("EIO"); }, close: async () => {},
	}))), /EIO/);
	// success path stays strict everywhere
	const calls = [];
	await syncDirectory("d", win(async () => {
		calls.push("open");
		return { sync: async () => calls.push("sync"), close: async () => calls.push("close") };
	}));
	assert.deepEqual(calls, ["open", "sync", "close"]);
});

test("hostEnvironment defaults bind the real host lazily", () => {
	const e = hostEnvironment();
	assert.equal(e.platform, process.platform);
	assert.equal(typeof e.signal0, "function");
	assert.equal(typeof e.readFile, "function");
	assert.equal(typeof e.openFile, "function");
	// explicit overrides always win
	assert.equal(hostEnvironment({ platform: "win32" }).platform, "win32");
});

test("retryWindowsBusy retries only Windows busy codes and never masks others", async () => {
	const win = { platform: "win32" };
	let calls = 0;
	const value = await retryWindowsBusy(async () => {
		calls += 1;
		if (calls < 3) throw Object.assign(new Error("busy"), { code: calls === 1 ? "EBUSY" : "EPERM" });
		return "done";
	}, win, 5);
	assert.equal(value, "done");
	assert.equal(calls, 3);

	calls = 0;
	await assert.rejects(retryWindowsBusy(async () => { calls += 1; throw Object.assign(new Error("missing"), { code: "ENOENT" }); }, win, 5), /missing/);
	assert.equal(calls, 1, "a non-busy code fails immediately on Windows");

	calls = 0;
	await assert.rejects(retryWindowsBusy(async () => { calls += 1; throw Object.assign(new Error("busy"), { code: "EBUSY" }); }, { platform: "linux" }, 5), /busy/);
	assert.equal(calls, 1, "POSIX never retries");

	calls = 0;
	await assert.rejects(retryWindowsBusy(async () => { calls += 1; throw Object.assign(new Error("busy"), { code: "EBUSY" }); }, win, 3), /busy/);
	assert.equal(calls, 3, "the attempt cap is honored");
});
