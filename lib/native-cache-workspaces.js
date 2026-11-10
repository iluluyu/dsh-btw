/** Owned WorkspaceRegistry registrations. Public registry APIs only.
 * The directory reservation is durable first. An immutable intent follows an
 * absent-path check BEFORE create(), so a crash between create and ID receipt
 * can recover by exact path + unchanged inode + creation epoch. The recovered
 * ID is durably bound before any detach/delete. Never adopt a preexisting or
 * replaced workspace, or delete a registration with another visible Session.
 */
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const equal = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
const infoId = s => ({ dev: String(s.dev), ino: String(s.ino) });
const fail = message => new Error(`专属 workspace 注册清理受阻: ${message}；保留恢复记录`);
const auxPath = (storage, record, suffix) => join(storage.records, `${record.id}.${suffix}`);
const workPath = (storage, record) => join(storage.root, "_no-cwd", record.id);
async function syncDir(path) { const f = await open(path, "r"); try { await f.sync(); } finally { await f.close(); } }
async function readAux(storage, record, suffix) {
	let file;
	try { file = await open(auxPath(storage, record, suffix), constants.O_RDONLY | constants.O_NOFOLLOW); }
	catch (e) { if (e.code === "ENOENT") return; throw e; }
	try {
		const s = await file.stat();
		if (!s.isFile() || s.nlink !== 1 || s.size > 8192) throw fail("注册恢复文件类型无效");
		const r = JSON.parse(await file.readFile("utf8"));
		if (r.version !== 1 || r.sessionId !== record.id || !equal(r.recordIdentity, record.fileIdentity)
			|| !Number.isFinite(Date.parse(r.createdAfter))) throw fail("注册恢复文件身份无效");
		if (suffix === "external") {
			if (typeof r.path !== "string" || !isAbsolute(r.path) || resolve(r.path) !== r.path
				|| !/^\d+$/.test(r.dirIdentity?.dev) || !/^\d+$/.test(r.dirIdentity?.ino)
				|| !UUID.test(r.workspaceId) || !Number.isFinite(Date.parse(r.workspaceCreatedAt))) throw fail("已有 workspace 恢复文件无效");
		} else if (r.path !== workPath(storage, record) || !equal(r.dirIdentity, record.dirIdentity)
			|| (suffix === "registry" && (!UUID.test(r.workspaceId) || typeof r.workspaceCreatedAt !== "string"))) throw fail("注册恢复文件身份无效");
		return { data: r, identity: infoId(s) };
	} finally { await file.close(); }
}
async function publish(storage, record, suffix, data) {
	const temporary = auxPath(storage, record, `${randomUUID()}.pending`);
	const file = await open(temporary, "wx", 0o600);
	try { await file.writeFile(JSON.stringify(data)); await file.sync(); } finally { await file.close(); }
	await link(temporary, auxPath(storage, record, suffix));
	await unlink(temporary);
	await syncDir(storage.records);
}
function sameWorkspace(w, binding) {
	return w && w.id === binding.workspaceId && w.path === binding.path && w.createdAt === binding.workspaceCreatedAt;
}
function safeMembers(w, id) {
	if (w.sessionIds.some(other => other !== id)) throw fail("注册仍引用其他 Session，绝不删除");
}
async function bindCreated(storage, record, registry, intent) {
	const matches = registry.list().filter(w => w.path === intent.path);
	if (!matches.length) return;
	if (matches.length !== 1) throw fail("同路径有多个 workspace");
	const w = matches[0];
	if (!UUID.test(w.id) || w.title !== "btw" || !Number.isFinite(Date.parse(w.createdAt))
		|| Date.parse(w.createdAt) < Date.parse(intent.createdAfter)) throw fail("不能把已有/重建的注册认作本人");
	safeMembers(w, record.id);
	const data = { ...intent, workspaceId: w.id, workspaceCreatedAt: w.createdAt };
	await publish(storage, record, "registry", data);
	return data;
}
export async function prepareWorkspaceRegistration(storage, record, registry, verify) {
	await verify();
	const path = workPath(storage, record);
	if (registry.list().some(w => w.path === path)) throw fail("独占路径已经有注册，拒绝接管");
	const intent = { version: 1, sessionId: record.id, path, dirIdentity: record.dirIdentity,
		recordIdentity: record.fileIdentity, createdAfter: new Date().toISOString() };
	await publish(storage, record, "intent", intent);
	const workspace = await registry.create(path, "btw");
	await verify();
	const binding = await bindCreated(storage, record, registry, intent);
	if (!binding || !sameWorkspace(workspace, binding)) throw fail("create 返回身份与实际注册不一致");
	return workspace;
}
async function verifyExternalDirectory(binding) {
	let current = binding.path;
	while (true) {
		const s = await lstat(current, { bigint: true });
		if (!s.isDirectory() || s.isSymbolicLink()) throw fail("已有 workspace 目录不安全");
		if (current === binding.path && !equal(infoId(s), binding.dirIdentity)) throw fail("已有 workspace 目录 inode 已改变");
		const parent = dirname(current); if (parent === current) break; current = parent;
	}
	if (await realpath(binding.path) !== binding.path) throw fail("已有 workspace 路径改变");
}
export async function prepareExistingWorkspace(storage, record, registry, id, verify) {
	await verify();
	if (!UUID.test(id)) throw fail("无效 workspaceId");
	const workspace = registry.get(id);
	if (!workspace || workspace.id !== id || typeof workspace.path !== "string" || !isAbsolute(workspace.path)
		|| resolve(workspace.path) !== workspace.path || !Number.isFinite(Date.parse(workspace.createdAt))
		|| workspace.sessionIds.includes(record.id)) throw fail("workspace 不存在、身份无效或已有此 Session");
	const s = await lstat(workspace.path, { bigint: true });
	const binding = { version: 1, sessionId: record.id, path: workspace.path, workspaceId: id,
		workspaceCreatedAt: workspace.createdAt, dirIdentity: infoId(s), recordIdentity: record.fileIdentity,
		createdAfter: new Date().toISOString() };
	await verifyExternalDirectory(binding);
	await publish(storage, record, "external", binding); // durable before Agent/attach
	await verify();
	if (registry.get(id) !== workspace || !sameWorkspace(workspace, binding)) throw fail("已有 workspace 创建时身份改变");
	return workspace;
}
export async function removeWorkspaceRegistration(storage, record, registry, verify) {
	await verify();
	const external = (await readAux(storage, record, "external"))?.data;
	if (external) {
		const workspace = registry.get(external.workspaceId);
		if (!sameWorkspace(workspace, external)) throw fail("已有 workspace 已删除、路径或身份改变");
		await verifyExternalDirectory(external);
		await workspace.detachSession(record.id); // ONLY our id; never delete/rename workspace
		await verify();
		await verifyExternalDirectory(external);
		if (registry.get(external.workspaceId) !== workspace || !sameWorkspace(workspace, external)
			|| workspace.sessionIds.includes(record.id)) throw fail("已有 workspace 身份改变或本人 Session 未移除");
		return;
	}
	const path = workPath(storage, record);
	let binding = (await readAux(storage, record, "registry"))?.data;
	const intent = (await readAux(storage, record, "intent"))?.data;
	const matches = registry.list().filter(w => w.path === path);
	if (!binding && matches.length) {
		if (!intent) throw fail("同路径注册没有创建授权，拒绝接管");
		binding = await bindCreated(storage, record, registry, intent);
	}
	if (!binding) return;
	const workspace = registry.get(binding.workspaceId);
	if (!workspace) {
		if (matches.length) throw fail("注册 ID 已替换");
		return; // previous successful deletion, retry after later filesystem fault
	}
	if (!sameWorkspace(workspace, binding) || matches.length !== 1 || matches[0].id !== workspace.id) throw fail("注册路径/ID/创建身份改变");
	const s = await lstat(path); // a missing directory is NOT ownership evidence
	if (!s.isDirectory() || s.isSymbolicLink() || !equal(infoId(s), record.dirIdentity)) throw fail("目录 inode 已改变");
	safeMembers(workspace, record.id);
	await workspace.detachSession(record.id);
	await verify();
	if (registry.get(workspace.id) !== workspace || workspace.sessionIds.length) throw fail("注册已替换或仍有 Session 引用");
	await registry.delete(workspace.id); // registration only, before directory rm
	if (registry.get(workspace.id) || registry.list().some(w => w.path === path)) throw fail("注册删除未完成");
}
export async function cleanWorkspaceRegistrationFiles(storage, record) {
	for (const suffix of ["registry", "intent", "external"]) {
		const saved = await readAux(storage, record, suffix);
		if (!saved) continue;
		const path = auxPath(storage, record, suffix), now = await lstat(path);
		if (now.isSymbolicLink() || !equal(infoId(now), saved.identity)) throw fail("注册恢复文件已替换");
		await unlink(path);
	}
	await syncDir(storage.records);
}
