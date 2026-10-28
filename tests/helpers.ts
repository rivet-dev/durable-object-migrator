import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
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

const ALCHEMY_BIN = fileURLToPath(new URL("../node_modules/.bin/alchemy", import.meta.url));
const ALCHEMY_STACK = fileURLToPath(new URL("./alchemy-fixture/alchemy.run.ts", import.meta.url));

/**
 * Runs the Alchemy fixture with `alchemy dev` in local workerd, reachable over HTTP.
 * State and HOME live in a temp directory, and the env is built from scratch, so
 * no Cloudflare credentials reach Alchemy and nothing is deployed.
 */
export async function startAlchemy() {
	const dir = await mkdtemp(join(tmpdir(), "migrator-alchemy-"));
	await mkdir(join(dir, "home"));
	let proc: ChildProcess | undefined;
	let url = "";

	const start = async (vars: Record<string, string>) => {
		const child = spawn(ALCHEMY_BIN, ["dev", "--stage", "test", ALCHEMY_STACK], {
			cwd: dir,
			env: {
				PATH: process.env.PATH,
				TMPDIR: process.env.TMPDIR,
				HOME: join(dir, "home"),
				ALCHEMY_NO_TUI: "1",
				ALCHEMY_TELEMETRY_DISABLED: "1",
				DO_NOT_TRACK: "1",
				WORKER_MIGRATOR_TOKEN: TOKEN,
				...vars,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		proc = child;
		url = await new Promise<string>((resolve, reject) => {
			let log = "";
			const onData = (chunk: Buffer) => {
				log += chunk.toString();
				// Printed once workerd serves the Worker.
				const ready = /Started in \d+ms → (http:\/\/\S+?)\/? /.exec(log)?.[1];
				if (ready) resolve(ready);
				// alchemy dev keeps running after a failed plan, waiting for a file change.
				if (log.includes("run failed")) reject(new Error(`alchemy dev failed:\n${log}`));
			};
			child.stdout.on("data", onData);
			child.stderr.on("data", onData);
			child.once("exit", (code) => reject(new Error(`alchemy dev exited with ${code}:\n${log}`)));
		});
	};

	const stop = async () => {
		if (!proc || proc.exitCode !== null) return;
		const exited = once(proc, "exit");
		proc.kill("SIGTERM");
		await exited;
	};

	await start({});
	return {
		migrator: () => createClient({ workerUrl: url, token: TOKEN }),
		room: (name: string, path: string, init?: RequestInit) => fetch(new URL(`/rooms/${name}/${path}`, url), init),
		/** Restarts `alchemy dev` with `MIGRATOR_DISABLED=true`. Durable Object storage is kept. */
		async disableMigrator() {
			await stop();
			await start({ MIGRATOR_DISABLED: "true" });
		},
		async dispose() {
			await stop();
			await rm(dir, { recursive: true, force: true });
		},
	};
}
