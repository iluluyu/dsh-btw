// Isolated smoke-only endpoint. Never installed in the user's profile or npm files.
import assert from 'node:assert/strict';
export const inject = ['loader', 'connection', 'webServer'];
export function apply(ctx) {
	const connection = ctx.extend({ webServer: ctx.webServer }).connection;
	ctx.effect(() => connection.rpc.handle('/btw-smoke-lifecycle', async method => {
		assert.equal(method, 'restart');
		const entries = [...ctx.loader.entries()];
		const entry = entries.find(entry => entry.options.id === 'btw');
		assert.ok(entry?.fiber, 'isolated btw entry must be active');
		await entry.fiber.restart();
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
		return { ok: true, value: { restarted: true } };
	}));
}
