/** Storage compatibility adapter. No host object replacement or cache deletion.
 * This child plugin registers the backend; index.js binds the effective route
 * through the Loader's in-memory entry API, preserving unrelated/user routes.
 * rc.1 patches replace whole config, so the bundle does not overwrite it.
 * Never rewrite user configuration or bypass an explicit foreign backend.
 * Markers are permanent; uninstalling/bypassing this backend is outside its
 * protection. Shared attachments and other ordinary-session domains are NOT
 * erased. This is logical deletion of owned JSONL, never secure erasure.
 * Current UI entries name an existing native workspace and only attach/detach
 * their own Session. Legacy unscoped API reservations live under
 * $DSH_HOME/.btw-native-workspaces/_no-cwd/<UUID>, never inferred HOME/cwd.
 * Its independently fsynced owner + inode record survives crashes. JSONL is
 * removed first; only then is that exact owned workspace removed. First native
 * open after restart recovers dead-owner records; ambiguity preserves evidence.
 * The owned path also gets a real WorkspaceRegistry registration + Session
 * attachment. Durable intent/ID sidecars cover create/attach crash windows;
 * registration is removed before directory deletion, never with foreign refs.
 * Only this Session's archive/pin entries are removed on close/recovery.
 * A temporary cwd is NOT an OS sandbox: the ordinary preset's permission policy
 * still applies. Do not claim tools cannot access absolute paths outside it.
 */
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { syncDirectory } from "./host-platform.js";

export const BACKEND = "btw-native-json";
export const VERSION = "0.2.2-rc.1";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const name = "btw-native-cache";
export const inject = ["storage", "storage.backend.json", "profileContext"];
const DOMAIN = "session_projcache";
const blocked = message => new Error(`原生临时聊天不可用: ${message}`);
const routeHelp = "拒写 gate 未绑定宿主 cache（btw 会自动为 session_projcache 添加路由；显式路由到别的 backend 时不覆盖）";

async function directory(path) {
	for (let p = resolve(path);; p = dirname(p)) {
		const s = await lstat(p);
		if (!s.isDirectory() || s.isSymbolicLink()) throw blocked(`不安全的 marker 目录 ${p}`);
		if (dirname(p) === p) break;
	}
	if (await realpath(path) !== resolve(path)) throw blocked("marker 目录 realpath 改变");
}
async function syncDir(path) { await syncDirectory(path); }
const ino = s => `${s.dev}:${s.ino}`;

export class DenyMarkers {
	constructor(root) { this.root = root; }
	async init() {
		await directory(dirname(this.root));
		try { await mkdir(this.root, { mode: 0o700 }); }
		catch (e) { if (e.code !== "EEXIST") throw e; }
		await directory(this.root);
		this.identity = ino(await lstat(this.root, { bigint: true }));
		await syncDir(dirname(this.root));
	}
	async checkRoot() {
		await directory(this.root);
		if (ino(await lstat(this.root, { bigint: true })) !== this.identity) throw blocked("marker 目录身份改变；拒绝放行");
	}
	path(id) {
		if (!UUID.test(id)) throw blocked("无效拒写标记 UUID");
		return join(this.root, `${id}.json`);
	}
	async has(id) {
		await this.checkRoot();
		if (!UUID.test(id)) return false; // ordinary host keys pass through
		let f;
		try { f = await open(this.path(id), constants.O_RDONLY | constants.O_NOFOLLOW); }
		catch (e) { if (e.code === "ENOENT") return false; throw e; }
		try {
			const s = await f.stat();
			if (!s.isFile() || s.nlink !== 1 || s.size > 4096) throw blocked("拒写标记类型无效");
			const r = JSON.parse(await f.readFile("utf8"));
			if (r.version !== 1 || r.domain !== DOMAIN || r.table !== "sessions" || r.key !== id
				|| Object.keys(r).length !== 4) throw blocked("拒写标记损坏；拒绝放行");
			return true;
		} finally { await f.close(); }
	}
	async seal(id) {
		await this.checkRoot();
		// Exclusive publication. A torn file survives and fails closed. Never
		// remove/rewrite a corrupt marker, or reclaim one after a successful close.
		const f = await open(this.path(id), "wx", 0o600);
		try {
			await f.writeFile(JSON.stringify({ version: 1, domain: DOMAIN, table: "sessions", key: id }));
			await f.sync();
		} finally { await f.close(); }
		await syncDir(this.root);
	}
	async retain(id) { if (!await this.has(id)) await this.seal(id); }
}

export class TombstonedError extends Error {
	code = "BTW_TOMBSTONED";
	constructor(id) { super(`btw denies projection cache write for ${id}`); }
}
function descriptorOK(d) {
	return d.version === 7 && d.layout === "per-record" && d.hasGlobal === false
		&& JSON.stringify(d.tables) === '["sessions"]'
		&& JSON.stringify(d.compatibleVersions ?? []) === '[3,4,5,6]';
}

export class NativeCacheBackend {
	constructor(delegate, markers) {
		this.delegate = delegate; this.markers = markers;
		this.units = new Set(); this.targets = new Set(); this.closed = false;
		this.kv = { open: d => this.openUnit(d) };
	}
	async openUnit(d) {
		if (this.closed) throw blocked("gate backend 已关闭");
		const target = d.name === DOMAIN;
		if (target && !descriptorOK(d)) throw blocked("未知 session_projcache 格式；拒绝打开 backend");
		const unit = await this.delegate.kv.open(d);
		const state = { loaded: false, active: true };
		let disposal;
		const pending = new Set();
		const run = fn => {
			if (!state.active || this.closed) return Promise.reject(blocked("gate unit 已关闭"));
			const p = Promise.resolve().then(fn);
			pending.add(p); p.then(() => pending.delete(p), () => pending.delete(p));
			return p;
		};
		const wrapped = {
			loadAll: () => run(async () => {
				const snapshot = await unit.loadAll();
				if (target) {
					for (const key of Object.keys(snapshot.tables.sessions ?? {})) {
						if (await this.markers.has(key)) delete snapshot.tables.sessions[key];
					}
					state.loaded = true;
				}
				return snapshot;
			}),
			putRecord: (table, key, value) => run(async () => {
				if (target && table === "sessions" && await this.markers.has(key)) throw new TombstonedError(key);
				return unit.putRecord(table, key, value);
			}),
			deleteRecord: (table, key) => run(() => unit.deleteRecord(table, key)),
			deleteRecords: (table, keys) => run(() => unit.deleteRecords(table, keys)),
			setGlobal: value => run(() => unit.setGlobal(value)),
			close: () => disposal ??= (async () => {
				state.active = false; // revoke evidence before the first await
				await Promise.allSettled([...pending]);
				await unit.close();
				this.targets.delete(state); this.units.delete(wrapped);
			})(),
		};
		if (unit.backupRecord) wrapped.backupRecord = (table, key) => run(() => unit.backupRecord(table, key));
		state.unit = wrapped;
		this.units.add(wrapped);
		if (target) this.targets.add(state);
		if (this.closed) { await wrapped.close(); throw blocked("gate 在 open 期间已关闭"); }
		return wrapped;
	}
	async close() {
		this.closed = true;
		await Promise.all([...this.units].map(u => u.close()));
		// Borrowed registry backend: NEVER close the shared delegate.
	}
	bind(hub, facility, cache) {
		// A backend may protect several native host/window scopes. Authority comes
		// from THIS facility's effective route and initialized cache, not a global
		// count of open units. Reading facility.config is a read-only, rc.1-pinned
		// compatibility adapter (private in SDK types), not a public routing API.
		// Non-malicious callers use the public facility path;
		// direct unit opens or mutating a live facility's config are out of scope.
		const domain = facility?.get(DOMAIN); // read-only diagnostics, no writes
		const valid = () => !this.closed && hub?.backend.get(BACKEND) === this && domain && cache
			&& (facility.config?.routes?.[DOMAIN] ?? facility.config?.backend) === BACKEND
			&& facility.get(DOMAIN) === domain && [...this.targets].some(state => state.active && state.loaded);
		if (!valid()) throw blocked(routeHelp);
		return () => {
			if (!valid()) throw blocked(routeHelp);
			return { markers: this.markers, domain, cache };
		};
	}
}

export async function apply(ctx) {
	const require = createRequire(ctx.profileContext.installAnchor);
	const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
	const { readFile } = await import("node:fs/promises");
	for (const pkg of ["dsh-storage", "dsh-storage-json", "dsh-storage-domain", "dsh-session-projection-cache", "dsh-home-paths", "dsh-agent", "dsh-agent-preset-registry", "dsh-workspace"]) {
		const p = JSON.parse(await readFile(require.resolve(`@deepseek-ai/${pkg}/package.json`), "utf8"));
		if (p.version !== VERSION || p.name !== `@deepseek-ai/${pkg}`) throw blocked("不支持的宿主 storage 版本");
	}
	const { dshHomePath } = await load("dsh-home-paths");
	const { JsonStorageBackend } = await load("dsh-storage-json");
	const { storageBackendServiceKey } = await load("dsh-storage");
	const home = dshHomePath();
	const delegate = ctx.storage.backend.get("json");
	if (home !== resolve(home) || !(delegate instanceof JsonStorageBackend) || delegate.root !== join(home, "storages")) throw blocked("仅支持默认 JSON storage backend/root");
	const markers = new DenyMarkers(join(home, ".btw-native-deny"));
	await markers.init();
	const backend = new NativeCacheBackend(delegate, markers);
	ctx.effect(() => {
		const unregister = ctx.storage.backend.register(BACKEND, backend);
		return async () => { backend.closed = true; unregister(); await backend.close(); };
	});
	ctx.provide("btwNativeCache", backend);
	ctx.provide(storageBackendServiceKey(BACKEND), backend);
}
