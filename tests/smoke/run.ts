// Prod smoke run. Deploy first with `CLOUDFLARE_ACCOUNT_ID=... npx wrangler deploy -c tests/fixture/wrangler.jsonc`.
//
//   SMOKE_URL=https://durable-object-migrator-smoke.<subdomain>.workers.dev \
//   SMOKE_TOKEN=... CF_API_TOKEN=... CF_ACCOUNT_ID=... \
//   node --experimental-transform-types tests/smoke/run.ts
//
// Checks what local workerd cannot prove: Cloudflare's CPU and size limits,
// `ctx.id.name`, the REST list API, and write detection in production.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { MigrationDirtyError, createClient } from "../../src/client.ts";
import { snapshot } from "../fixture/snapshot.ts";

const env = (k: string) => process.env[k] ?? assert.fail(`${k} is not set`);
const url = env("SMOKE_URL");
const migrator = createClient({ workerUrl: url, token: env("SMOKE_TOKEN") });
const app = (name: string, action: string) => fetch(new URL(`/app/${name}/${action}`, url));
const run = `smoke-${Date.now()}`;

async function check(label: string, fn: () => Promise<void>) {
	const started = Date.now();
	await fn();
	console.log(`ok  ${label} (${Date.now() - started} ms)`);
}

function destinationSnapshot(db: DatabaseSync) {
	const query = (sql: string) =>
		db
			.prepare(sql)
			.all()
			.map((row) => Object.values(row as object));
	const kv = query(`SELECT key, value FROM __do_kv ORDER BY key`);
	const alarm = (db.prepare(`SELECT value FROM __do_meta WHERE key = 'alarm'`).get() as { value: unknown }).value;
	return JSON.parse(JSON.stringify({ ...snapshot(query), kv, alarm }));
}

const name = `${run}-fidelity`;
let id = "";
let seededAlarm: unknown = null;

await check("seed a Durable Object with 4 rows of 1.5 MB blobs and hard cases", async () => {
	const res = await app(name, "seed?big=1");
	assert.equal(res.status, 200, await res.text());
});

await check("export it over several pages into an identical sqlite database", async () => {
	const source = await (await app(name, "snapshot")).json();
	seededAlarm = source.alarm;
	id = (await migrator.resolve("ROOMS", { name })).id;
	const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
	let pages = 0;
	for await (const page of migrator.exportObject({ binding: "ROOMS", id })) {
		db.exec(page.sql);
		pages++;
	}
	assert.ok(pages > 1, `expected several pages, got ${pages}`);
	assert.deepEqual(destinationSnapshot(db), source);
});

await check("the migrated Durable Object rejects app traffic", async () => {
	const res = await app(name, "ping");
	assert.equal(res.status, 503);
});

await check("resolve by id returns the name the Durable Object saved", async () => {
	const resolved = await migrator.resolve("ROOMS", { id });
	assert.equal(resolved.name, name);
});

await check("a migrated Durable Object exported again still reports its alarm", async () => {
	const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
	for await (const page of migrator.exportObject({ binding: "ROOMS", id })) db.exec(page.sql);
	const alarm = db.prepare(`SELECT value FROM __do_meta WHERE key = 'alarm'`).get() as { value: unknown };
	assert.equal(alarm.value, seededAlarm);
});

await check("a KV write during the export makes it fail", async () => {
	const dirty = `${run}-dirty`;
	assert.equal((await app(dirty, "seed?big=1")).status, 200);
	const { id } = await migrator.resolve("ROOMS", { name: dirty });
	let first = true;
	const err = await (async () => {
		for await (const _ of migrator.exportObject({ binding: "ROOMS", id })) {
			if (!first) continue;
			first = false;
			assert.equal((await app(dirty, "kv-put")).status, 200);
		}
	})().catch((e: unknown) => e);
	assert.ok(err instanceof MigrationDirtyError, `expected MigrationDirtyError, got ${String(err)}`);
});

await check("a write still pending in ctx.waitUntil makes the export fail", async () => {
	const late = `${run}-late`;
	assert.equal((await app(late, "seed")).status, 200);
	assert.equal((await app(late, "late-write")).status, 200);
	const { id } = await migrator.resolve("ROOMS", { name: late });
	const drain = async () => {
		for await (const _ of migrator.exportObject({ binding: "ROOMS", id })) {
		}
	};
	const err = await drain().catch((e: unknown) => e);
	assert.ok(err instanceof MigrationDirtyError, `expected MigrationDirtyError, got ${String(err)}`);
	assert.equal((await app(late, "release")).status, 200);
	await drain();
});

await check("backfill finds the namespace and lists the objects through the Cloudflare API", async () => {
	// Cloudflare's list API shows new objects only after a few minutes.
	for (let attempt = 0; attempt < 20; attempt++) {
		const seen = await listed();
		if (seen.includes(id)) return;
		await new Promise((r) => setTimeout(r, 30_000));
	}
	assert.fail(`${id} never showed up in the Cloudflare list API`);
});

async function listed(): Promise<string[]> {
	const seen: string[] = [];
	const result = await migrator.backfill({
		cloudflare: {
			apiToken: env("CF_API_TOKEN"),
			accountId: env("CF_ACCOUNT_ID"),
			scriptName: "durable-object-migrator-smoke",
			className: "Room",
		},
		startAt: null,
		updateStartAt: () => {},
		migrate: async ({ id }) => {
			seen.push(id);
		},
	});
	assert.deepEqual(result.failed, []);
	return seen;
}
