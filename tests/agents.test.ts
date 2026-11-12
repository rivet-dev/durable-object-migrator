import { afterAll, beforeAll, expect, test } from "vitest";
import { openDestination, startWorker, type Worker } from "./helpers";

let worker: Worker;

beforeAll(async () => {
	worker = await startWorker();
});

afterAll(async () => {
	await worker?.dispose();
});

const counter = (name: string, action = "") => fetch(new URL(`/counter/${name}/${action}`, worker.url));

test("an Agents SDK Agent works when wrapped, exports its state, and is rejected once migrated", async () => {
	expect(await (await counter("agent")).json()).toEqual({ n: 1 });
	expect(await (await counter("agent")).json()).toEqual({ n: 2 });
	expect(await (await counter("agent", "rpc-count")).json()).toBe(2);

	const migrator = worker.migrator();
	const { id } = await migrator.resolve("COUNTERS", { name: "agent" });
	const db = openDestination();
	for await (const page of migrator.exportObject({ binding: "COUNTERS", id })) db.exec(page.sql);
	const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all();
	expect(tables.length).toBeGreaterThan(2);

	const fetched = await counter("agent");
	expect(fetched.status).toBe(503);
	expect(await fetched.json()).toMatchObject({ error: { code: "migrator.moved" } });
	expect(await (await counter("agent", "rpc-count")).text()).toContain("migrator.moved");
});
