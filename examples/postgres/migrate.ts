// Coordinates a migration with Postgres. Postgres stores which Durable Objects
// are done, holds a lock per Durable Object, and stores the backfill position.
// The data itself goes into one .sqlite file per Durable Object.
//
//   DATABASE_URL=postgres://... WORKER_URL=... WORKER_MIGRATOR_TOKEN=... \
//   CF_API_TOKEN=... CF_ACCOUNT_ID=... CF_SCRIPT_NAME=my-app CF_CLASS_NAME=Room \
//   node --experimental-transform-types migrate.ts backfill [--from-start]

import { mkdir, rename, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { createClient } from "../../src/client.ts";

const BINDING = "ROOMS";
const DATA_DIR = "./data";

const pool = new pg.Pool({ connectionString: required("DATABASE_URL") });
const migrator = createClient({ workerUrl: required("WORKER_URL"), token: required("WORKER_MIGRATOR_TOKEN") });

await pool.query(`CREATE TABLE IF NOT EXISTS do_migrations (id text PRIMARY KEY, done_at timestamptz NOT NULL)`);
await pool.query(`CREATE TABLE IF NOT EXISTS do_backfill (binding text PRIMARY KEY, start_at text NOT NULL)`);

// user writes this
export async function migrate({ id }: { id: string }): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		// One migration per Durable Object, across every server process.
		// Held until COMMIT, so a second caller waits here and then sees `done`.
		await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [id]);
		const done = await client.query("SELECT 1 FROM do_migrations WHERE id = $1", [id]);
		if (done.rowCount === 0) {
			await exportToFile(id);
			await client.query("INSERT INTO do_migrations (id, done_at) VALUES ($1, now())", [id]);
		}
		await client.query("COMMIT");
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
}

/** Lazy migration: call before serving a request that uses this Durable Object. */
export async function beforeRequest(name: string): Promise<void> {
	const { id } = await migrator.resolve(BINDING, { name });
	await migrate({ id });
}

/** Backfill: moves every Durable Object nobody touched. Safe to stop and rerun. `fromStart` ignores the saved position. */
export async function backfill({ fromStart = false } = {}) {
	const saved = await pool.query("SELECT start_at FROM do_backfill WHERE binding = $1", [BINDING]);
	return migrator.backfill({
		cloudflare: {
			apiToken: required("CF_API_TOKEN"),
			accountId: required("CF_ACCOUNT_ID"),
			scriptName: required("CF_SCRIPT_NAME"),
			className: required("CF_CLASS_NAME"),
		},
		startAt: fromStart ? null : (saved.rows[0]?.start_at ?? null),
		updateStartAt: async (startAt) => {
			await pool.query(
				`INSERT INTO do_backfill (binding, start_at) VALUES ($1, $2)
				 ON CONFLICT (binding) DO UPDATE SET start_at = excluded.start_at`,
				[BINDING, startAt],
			);
		},
		migrate,
	});
}

async function exportToFile(id: string): Promise<void> {
	await mkdir(DATA_DIR, { recursive: true });
	const path = `${DATA_DIR}/${id}.sqlite`;
	// A half-finished earlier attempt is dropped and the export starts clean.
	const partial = `${path}.partial`;
	await rm(partial, { force: true });
	const db = new DatabaseSync(partial, { enableForeignKeyConstraints: false });
	try {
		for await (const page of migrator.exportObject({ binding: BINDING, id })) db.exec(page.sql);
	} finally {
		db.close();
	}
	await rename(partial, path);
}

function required(key: string): string {
	const value = process.env[key];
	if (!value) throw new Error(`${key} is not set`);
	return value;
}

if (process.argv[2] === "backfill") {
	console.log(await backfill({ fromStart: process.argv.includes("--from-start") }));
	await pool.end();
}
