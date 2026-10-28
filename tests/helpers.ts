import { DatabaseSync } from "node:sqlite";
import { createTestHarness, type TestHarnessOptions } from "wrangler";
import { createClient } from "../src/client";
import { snapshot, type Snapshot } from "./fixture/snapshot";

export const TOKEN = "test-migrator-token";

export type SourceSnapshot = Snapshot & { kv: [string, string][]; alarm: number | null };

/** Runs the fixture Worker from its wrangler.jsonc in local workerd, reachable over HTTP. */
export async function startWorker() {
	const options = (vars: Record<string, string>): TestHarnessOptions => ({
		workers: [{ configPath: "tests/fixture/wrangler.jsonc", secrets: { WORKER_MIGRATOR_TOKEN: TOKEN }, vars }],
	});
	const server = createTestHarness(options({}));
	let url = (await server.listen()).url.toString();

	return {
		get url() {
			return url;
		},
		migrator: () => createClient({ workerUrl: url, token: TOKEN }),
		app: (name: string, action: string, init?: RequestInit) => fetch(new URL(`/app/${name}/${action}`, url), init),
		/** Restarts the Durable Object. Storage is kept, in-memory state is lost. */
		evict: (name: string) => server.getWorker().evictDurableObject("ROOMS", { name }),
		/** Reloads the Worker with `MIGRATOR_DISABLED=true`. */
		async disableMigrator() {
			await server.update(options({ MIGRATOR_DISABLED: "true" }));
			url = (await server.listen()).url.toString();
		},
		dispose: () => server.close(),
	};
}

export type Worker = Awaited<ReturnType<typeof startWorker>>;

export async function seed(worker: Worker, name: string, opts: { big?: boolean } = {}) {
	const res = await worker.app(name, opts.big ? "seed?big=1" : "seed");
	if (!res.ok) throw new Error(`seed failed: ${res.status} ${await res.text()}`);
}

export async function sourceSnapshot(worker: Worker, name: string): Promise<SourceSnapshot> {
	const res = await worker.app(name, "snapshot");
	if (!res.ok) throw new Error(`snapshot failed: ${res.status} ${await res.text()}`);
	return (await res.json()) as SourceSnapshot;
}

/** A fresh destination database, opened the way the README tells users to. */
export function openDestination(): DatabaseSync {
	return new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
}

export function destinationSnapshot(db: DatabaseSync): SourceSnapshot {
	const query = (sql: string) =>
		db
			.prepare(sql)
			.all()
			.map((row) => Object.values(row as object));
	const kv = query(`SELECT key, value FROM __do_kv ORDER BY key`) as [string, string][];
	const alarm = db.prepare(`SELECT value FROM __do_meta WHERE key = 'alarm'`).get() as { value: number | null };
	// Compared against the source, which arrives as JSON. node:sqlite rows have
	// a null prototype, so both sides go through JSON.
	return JSON.parse(JSON.stringify({ ...snapshot(query), kv, alarm: alarm.value })) as SourceSnapshot;
}
