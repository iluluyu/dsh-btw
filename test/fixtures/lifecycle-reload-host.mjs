// Isolated smoke-only endpoint. Never installed in the user's profile or npm files.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export const inject = ['loader', 'connection', 'webServer'];
export function apply(ctx) {
	const connection = ctx.extend({ webServer: ctx.webServer }).connection;
	async function withWorkspaces(operation) {
		let scope;
		try {
			return await new Promise((resolve, reject) => {
				scope = ctx.inject(['workspaceRegistry'], ready => {
					Promise.resolve().then(() => operation(ready.workspaceRegistry)).then(resolve, reject);
				});
				scope.await().catch(reject);
			});
		} finally { await scope?.dispose(); }
	}
	ctx.effect(() => connection.rpc.handle('/btw-smoke-lifecycle', async method => {
		if (method === 'project') {
			const path = join(process.env.DSH_HOME, 'selected-project');
			await mkdir(path, { recursive: true });
			await writeFile(join(path, 'user-sentinel'), 'keep');
			return { ok: true, value: await withWorkspaces(async registry => {
				const workspace = await registry.create(path, 'selected project');
				return { workspaceId: workspace.id, cwd: workspace.path };
			}) };
		}
		if (method === 'archives') return { ok: true, value: await withWorkspaces(registry => [...registry.archivedSessionIds]) };
		if (method === 'workspaces') return { ok: true, value: await withWorkspaces(registry => registry.list().map(workspace => ({
			workspaceId: workspace.id, title: workspace.title, path: workspace.path, sessionIds: workspace.sessionIds,
		}))) };
		assert.ok(method === 'restart' || method === 'recompose');
		const entries = [...ctx.loader.entries()];
		const entry = entries.find(entry => method === 'restart' ? entry.options.id === 'btw' : entry.options.name === '@deepseek-ai/dsh-storage-domain');
		assert.ok(entry?.fiber, 'isolated target entry must be active');
		if (method === 'restart') await entry.fiber.restart();
		else {
			// UI settings saves re-resolve the original raw config without the
			// plugin's ephemeral route. This must never disable the effective gate.
			const raw = { ...entry.options.config, routes: { ...entry.options.config.routes } };
			assert.equal(raw.backend, 'json');
			delete raw.routes.session_projcache;
			await entry.fiber.update(raw, true);
		}
		// Root restart does not join newly mounted asynchronous child scopes.
		let scope;
		try {
			await new Promise((resolve, reject) => {
				scope = ctx.inject(['btwNativeCache', 'storage', 'storageDomain', 'sessionProjectionCache', 'sessions', 'agentPresets', 'workspaceRegistry'], ready => {
					try { ready.btwNativeCache.bind(ready.storage, ready.storageDomain, ready.sessionProjectionCache)(); resolve(); }
					catch (error) { reject(error); }
				});
				scope.await().catch(reject);
			});
			await new Promise(resolve => setImmediate(resolve));
		} finally { await scope?.dispose(); }
		return { ok: true, value: { restarted: method === 'restart', recomposed: method === 'recompose' } };
	}));
}
