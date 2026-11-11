import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { prepareWorkspaceRegistration, removeWorkspaceRegistration, cleanWorkspaceRegistrationFiles } from "../lib/native-cache-workspaces.js";

// NTFS file IDs can exceed Number.MAX_SAFE_INTEGER. Keep real IO, but model
// large IDs at the stat boundary on any platform; never inspect user data.
async function fixture(run) {
	const root = await fs.mkdtemp(join(tmpdir(), "btw-large-inode-"));
	const original = { lstat: fs.lstat, open: fs.open };
	const ids = new Map(), deltas = new Map();
	const base = 1152921504606846993n;
	const ino = path => {
		if (!ids.has(path)) ids.set(path, base + BigInt(ids.size) * 512n);
		return ids.get(path) + (deltas.get(path) || 0n);
	};
	const stats = (value, path, options) => new Proxy(value, { get(target, key) {
		if (key === "ino") return options?.bigint ? ino(path) : Number(ino(path));
		const field = Reflect.get(target, key);
		return typeof field === "function" ? field.bind(target) : field;
	} });
	fs.lstat = async (path, options) => stats(await original.lstat(path, options), path, options);
	fs.open = async (...args) => {
		const handle = await original.open(...args);
		return new Proxy(handle, { get(target, key) {
			if (key === "stat") return async options => stats(await target.stat(options), args[0], options);
			const field = Reflect.get(target, key);
			return typeof field === "function" ? field.bind(target) : field;
		} });
	};
	syncBuiltinESMExports();
	try {
		const id = randomUUID(), storage = { root: join(root, "work"), records: join(root, "records") };
		const path = join(storage.root, "_no-cwd", id);
		await fs.mkdir(path, { recursive: true });
		await fs.mkdir(storage.records);
		const recordPath = join(storage.records, `${id}.json`);
		await fs.writeFile(recordPath, "owned");
		const identity = s => ({ dev: String(s.dev), ino: String(s.ino) });
		const record = { id, dirIdentity: identity(await fs.lstat(path, { bigint: true })), fileIdentity: identity(await fs.lstat(recordPath, { bigint: true })) };
		const rows = new Map(), registry = {
			list: () => [...rows.values()], get: id => rows.get(id),
			async create(path, title) {
				const row = { id: randomUUID(), path, title, createdAt: new Date().toISOString(), sessionIds: [],
					async detachSession(id) { this.sessionIds = this.sessionIds.filter(other => other !== id); } };
				rows.set(row.id, row); return row;
			},
			async delete(id) { return rows.delete(id); },
		};
		const verify = async () => {};
		const workspace = await prepareWorkspaceRegistration(storage, record, registry, verify);
		await run({ storage, record, registry, workspace, verify, path, ino, deltas });
	} finally {
		fs.lstat = original.lstat; fs.open = original.open; syncBuiltinESMExports();
		await fs.rm(root, { recursive: true, force: true });
	}
}

test("native workspace close preserves large inode precision without any messages", async () => {
	await fixture(async f => {
		assert.ok(BigInt(f.record.dirIdentity.ino) > BigInt(Number.MAX_SAFE_INTEGER));
		assert.notEqual(String(Number(f.record.dirIdentity.ino)), f.record.dirIdentity.ino);
		await removeWorkspaceRegistration(f.storage, f.record, f.registry, f.verify);
		assert.equal(f.registry.get(f.workspace.id), undefined);
		await cleanWorkspaceRegistrationFiles(f.storage, f.record);
		assert.deepEqual(await fs.readdir(f.storage.records), [`${f.record.id}.json`]);
	});
});

test("large inode cleanup still refuses a replacement indistinguishable as a Number", async () => {
	await fixture(async f => {
		const before = f.ino(f.path);
		f.deltas.set(f.path, 1n);
		assert.equal(Number(before), Number(f.ino(f.path)), "rounded Number IDs would hide this substitution");
		await assert.rejects(removeWorkspaceRegistration(f.storage, f.record, f.registry, f.verify), /inode 已改变/);
		assert.equal(f.registry.get(f.workspace.id), f.workspace);
		assert.ok(await fs.readFile(join(f.storage.records, `${f.record.id}.registry`), "utf8"));
		f.deltas.delete(f.path);
		await removeWorkspaceRegistration(f.storage, f.record, f.registry, f.verify);
	});
});

test("large recovery-file identity detects replacement between handle stat and unlink", async () => {
	await fixture(async f => {
		const path = join(f.storage.records, `${f.record.id}.registry`), originalLstat = fs.lstat;
		fs.lstat = async (value, options) => {
			if (value === path) f.deltas.set(path, 1n);
			return originalLstat(value, options);
		};
		syncBuiltinESMExports();
		try {
			await assert.rejects(cleanWorkspaceRegistrationFiles(f.storage, f.record), /恢复文件已替换/);
			assert.ok(await fs.readFile(path, "utf8"), "retain the changed sidecar");
		} finally { fs.lstat = originalLstat; syncBuiltinESMExports(); }
	});
});
