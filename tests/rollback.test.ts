import { afterAll, beforeAll, expect, test } from "vitest";
import { seed, startWorker, type Worker } from "./helpers";

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
