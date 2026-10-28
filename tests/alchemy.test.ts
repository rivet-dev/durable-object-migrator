import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MigrationDirtyError } from "../src/client";
import { openDestination, startAlchemy } from "./helpers";

// The Effect-native Durable Object in tests/alchemy-fixture, served by `alchemy dev`.
let dev: Awaited<ReturnType<typeof startAlchemy>>;

beforeAll(async () => {
	dev = await startAlchemy();
});

afterAll(async () => {
	await dev?.dispose();
});

async function call(name: string, path: string, body?: string) {
	const res = await dev.room(name, path, { method: path === "count" ? "GET" : "POST", body });
	return { status: res.status, body: await res.text() };
}

async function exportInto(name: string) {
	const migrator = dev.migrator();
	const { id } = await migrator.resolve("Room", { name });
	const db = openDestination();
	for await (const page of migrator.exportObject({ binding: "Room", id })) db.exec(page.sql);
	return db;
}

const bodies = (db: DatabaseSync) => db.prepare(`SELECT body FROM notes WHERE body IS NOT NULL ORDER BY id`).all();
const exportedAlarm = (db: DatabaseSync) => db.prepare(`SELECT value FROM __do_meta WHERE key = 'alarm'`).get();
const moved = { status: 503, body: expect.stringContaining('"code":"migrator.moved"') };

describe("Alchemy Effect-native Durable Object", () => {
	test("a write during the export makes it fail, and the retry includes the write", async () => {
		await call("dirty", "seed/big");
		const migrator = dev.migrator();
		const { id } = await migrator.resolve("Room", { name: "dirty" });

		const attempt = async () => {
			let first = true;
			for await (const _ of migrator.exportObject({ binding: "Room", id })) {
				if (!first) continue;
				first = false;
				expect(await call("dirty", "notes", "mid-export")).toEqual({ status: 200, body: "ok" });
			}
		};
		await expect(attempt()).rejects.toBeInstanceOf(MigrationDirtyError);

		const db = await exportInto("dirty");
		expect(bodies(db)).toEqual([{ body: "hello" }, { body: "it's ünïcödé" }, { body: "mid-export" }]);
	});

	test("after migration, RPC and fetch are rejected, and a second export still carries the alarm", async () => {
		await call("moved", "seed/small");
		await call("moved", "schedule");
		const first = await exportInto("moved");
		expect(exportedAlarm(first)).not.toEqual({ value: null });

		expect(await call("moved", "notes", "late")).toEqual(moved);
		expect(await call("moved", "count")).toEqual(moved);

		const again = await exportInto("moved");
		expect(exportedAlarm(again)).toEqual(exportedAlarm(first));
		expect(bodies(again)).not.toContainEqual({ body: "late" });
	});

	// Last, because it restarts `alchemy dev` with the migrator off.
	test("MIGRATOR_DISABLED=true makes a migrated Durable Object serve the app again", async () => {
		await call("rollback", "seed/small");
		await exportInto("rollback");
		expect(await call("rollback", "notes", "before")).toEqual(moved);

		await dev.disableMigrator();

		expect(await call("rollback", "notes", "after")).toEqual({ status: 200, body: "ok" });
		expect(await call("rollback", "count")).toEqual({ status: 200, body: "3" });
	});
});
