/** Cross-platform host primitives shared by the temp-session reservation
 * paths: portable process-owner identity, conservative liveness checks, and
 * directory fsync. No shell helpers or external programs are used — only
 * node:fs/promises and process.kill(pid, 0).
 *
 * Recovery-record owner schemas:
 *  - /proc identity (Linux hosts, legacy-compatible): { pid, bootId, startTicks }.
 *    Death is proven only by a different boot id, changed startTicks, or a
 *    missing /proc/<pid>/stat; unreadable or ambiguous /proc keeps the record.
 *    Off Linux such records can never be verified and are always kept.
 *  - portable identity (win/mac desktop hosts): { pid, kind: "signal0" }.
 *    kill(pid, 0) liveness: ONLY ESRCH proves death. A live pid, PID reuse (an
 *    unrelated process answering for the pid), or EPERM/other ambiguity
 *    conservatively keeps the record — never a wrong delete.
 *
 * syncDirectory is strict on POSIX (open + fsync + close, errors propagate).
 * Windows does not support this directory-fsync path; the KNOWN open/fsync
 * failures (EISDIR/EPERM/EACCES/EINVAL) are an explicit Windows-only
 * compatibility skip. Arbitrary I/O errors are never swallowed.
 */
import { open, readFile } from "node:fs/promises";

const BOOT_ID = /^[0-9a-f-]{36}$/;
const WINDOWS_UNSUPPORTED_DIR_FSYNC = new Set(["EISDIR", "EPERM", "EACCES", "EINVAL"]);

/** Dependency seam for deterministic platform-injection tests. Defaults bind
 *  lazily (process.platform is read per call), so patched-platform simulation
 *  works without rebinding. Tests pass explicit plain-object envs instead of
 *  pretending to run on a real Windows host. */
export function hostEnvironment(overrides = {}) {
	return {
		platform: process.platform,
		readFile: (path, encoding) => readFile(path, encoding),
		openFile: path => open(path, "r"),
		signal0: pid => process.kill(pid, 0),
		...overrides,
	};
}

/** Owner identity for a NEW reservation. Linux keeps the /proc bootId +
 *  startTicks identity so existing recovery records stay interchangeable;
 * every other desktop platform stores the portable signal0 owner. */
export async function processIdentity(pid, env = hostEnvironment()) {
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("无法确认进程身份");
	if (env.platform === "linux") {
		const bootId = (await env.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
		const stat = await env.readFile(`/proc/${pid}/stat`, "utf8");
		const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		if (!bootId || !/^\d+$/.test(startTicks)) throw new Error("无法确认进程身份");
		return { pid, bootId, startTicks };
	}
	return { pid, kind: "signal0" };
}

/** Record-schema check accepting BOTH owner generations. */
export function validOwner(owner) {
	if (!owner || typeof owner !== "object" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
	if (owner.bootId !== undefined || owner.startTicks !== undefined) {
		// legacy /proc identity: both fields must be exactly as before
		return typeof owner.bootId === "string" && BOOT_ID.test(owner.bootId)
			&& typeof owner.startTicks === "string" && /^\d+$/.test(owner.startTicks);
	}
	return owner.kind === "signal0";
}

/** Conservative death verdict. `false` (keep the record) is always the safe
 *  answer whenever death cannot be PROVEN. */
export async function ownerDead(owner, env = hostEnvironment()) {
	if (owner && typeof owner.bootId === "string" && typeof owner.startTicks === "string") {
		if (env.platform !== "linux") return false; // /proc owner unverifiable off Linux; keep
		let bootId;
		try { bootId = (await env.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(); }
		catch { return false; }
		if (!BOOT_ID.test(bootId)) return false;
		if (bootId !== owner.bootId) return true;
		try {
			const now = await processIdentity(owner.pid, env);
			return now.startTicks !== owner.startTicks;
		} catch (error) {
			// Only a missing PID proves death; permission/I/O ambiguity is alive.
			return error.code === "ENOENT" && error.path === `/proc/${owner.pid}/stat`;
		}
	}
	if (validOwner(owner) && owner.kind === "signal0") {
		try {
			env.signal0(owner.pid);
		} catch (error) {
			// ONLY ESRCH proves the pid is gone. EPERM (exists, no permission),
			// any other code, and PID reuse (a live unrelated process) keep it.
			return error?.code === "ESRCH";
		}
		return false;
	}
	return false; // unknown schema is never actionable
}

/** Generic directory fsync — POSIX-strict, Windows-compat when (and only when)
 *  the OS is known not to support directory fsync on this path. */
export async function syncDirectory(path, env = hostEnvironment()) {
	const compat = env.platform === "win32" ? WINDOWS_UNSUPPORTED_DIR_FSYNC : null;
	let file;
	try { file = await env.openFile(path); }
	catch (error) {
		if (compat?.has(error?.code)) return; // Windows: dir open unsupported
		throw error;
	}
	try { await file.sync(); }
	catch (error) {
		if (!compat?.has(error?.code)) throw error; // Windows: dir fsync unsupported
	}
	finally { await file.close(); }
}
