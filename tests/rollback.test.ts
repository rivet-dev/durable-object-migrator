import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { seed, sourceSnapshot, startWorker, type Worker } from "./helpers";

let worker: Worker;

beforeAll(async () => {
	worker = await startWorker();
});

afterAll(async () => {
	await worker?.dispose();
});

test("MIGRATOR_DISABLED=true makes migrated Durable Objects serve the app again", async () => {
	await seed(worker, "rollback");
	const migrator = worker.migrator();
	const { id } = await migrator.resolve("ROOMS", { name: "rollback" });
	for await (const _ of migrator.exportObject({ binding: "ROOMS", id })) {
	}
	expect((await worker.app("rollback", "ping")).status).toBe(503);

	await worker.disableMigrator();

	const res = await worker.app("rollback", "ping");
	expect(res.status).toBe(200);
	expect(await res.text()).toBe("pong");
	expect(await (await worker.app("rollback", "rpc-note")).text()).toBe("ok");
});

test("an alarm that comes due while a Durable Object is migrated runs after rollback", async () => {
	// Its own Worker: the test above leaves this one with the migrator disabled.
	const fresh = await startWorker();
	try {
		await seed(fresh, "alarmed");
		expect((await fresh.app("alarmed", "schedule?in=1000")).status).toBe(200);
		const migrator = fresh.migrator();
		const { id } = await migrator.resolve("ROOMS", { name: "alarmed" });
		for await (const _ of migrator.exportObject({ binding: "ROOMS", id })) {
		}

		// Let the alarm's scheduled time pass while the object is migrated.
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		await fresh.disableMigrator();

		// The alarm runs asynchronously once the object starts again, so poll for its write.
		await vi.waitFor(
			async () => {
				const snapshot = await sourceSnapshot(fresh, "alarmed");
				expect(JSON.stringify(snapshot.tables.notes?.rows)).toContain("alarm ran");
			},
			{ timeout: 10_000, interval: 250 },
		);
	} finally {
		await fresh.dispose();
	}
});
