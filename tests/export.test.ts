import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MigrationDirtyError, MigratorError, createClient } from "../src/client";
import { TOKEN, destinationSnapshot, openDestination, seed, sourceSnapshot, startWorker, type Worker } from "./helpers";

let worker: Worker;

beforeAll(async () => {
	worker = await startWorker();
});

afterAll(async () => {
	await worker?.dispose();
});

async function exportInto(name: string) {
	const migrator = worker.migrator();
	const { id } = await migrator.resolve("ROOMS", { name });
	const db = openDestination();
	let pages = 0;
	for await (const page of migrator.exportObject({ binding: "ROOMS", id })) {
		db.exec(page.sql);
		pages++;
	}
	return { db, pages, id };
}

/** One export page over plain HTTP, for requests the client would never send. */
function exportRequest(id: string, cursor?: string) {
	const url = new URL("/__migrate/ROOMS/export", worker.url);
	url.searchParams.set("id", id);
	if (cursor !== undefined) url.searchParams.set("cursor", cursor);
	return fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
}

describe("export", () => {
	test("a Durable Object full of hard cases arrives with identical data", async () => {
		await seed(worker, "fidelity", { big: true });
		const source = await sourceSnapshot(worker, "fidelity");

		const { db, pages } = await exportInto("fidelity");

		expect(pages).toBeGreaterThan(1);
		expect(destinationSnapshot(db)).toEqual(source);
	});

	test("a SQL write during the export makes it fail, and the retry includes the write", async () => {
		await seed(worker, "dirty-sql", { big: true });
		const migrator = worker.migrator();
		const { id } = await migrator.resolve("ROOMS", { name: "dirty-sql" });

		const attempt = async () => {
			let first = true;
			for await (const _ of migrator.exportObject({ binding: "ROOMS", id })) {
				if (!first) continue;
				first = false;
				expect((await worker.app("dirty-sql", "write?body=written%20mid-export")).status).toBe(200);
			}
		};
		await expect(attempt()).rejects.toBeInstanceOf(MigrationDirtyError);

		const { db } = await exportInto("dirty-sql");
		expect(db.prepare(`SELECT count(*) AS n FROM notes WHERE body = 'written mid-export'`).get()).toEqual({ n: 1 });
	});

	test("a KV write during the export makes it fail", async () => {
		await seed(worker, "dirty-kv", { big: true });
		const migrator = worker.migrator();
		const { id } = await migrator.resolve("ROOMS", { name: "dirty-kv" });

		const attempt = async () => {
			let first = true;
			for await (const _ of migrator.exportObject({ binding: "ROOMS", id })) {
				if (!first) continue;
				first = false;
				expect((await worker.app("dirty-kv", "kv-put")).status).toBe(200);
			}
		};
		await expect(attempt()).rejects.toBeInstanceOf(MigrationDirtyError);
	});

	test("a Durable Object that restarts during the export makes it fail, and the retry succeeds", async () => {
		await seed(worker, "evicted", { big: true });
		const migrator = worker.migrator();
		const { id } = await migrator.resolve("ROOMS", { name: "evicted" });

		// Pages are fetched by hand so no request to the object is in flight
		// during eviction. exportObject always prefetches the next page, and
		// workerd's test eviction waits for every request to drain.
		const first = (await (await exportRequest(id)).json()) as { cursor: string };

		// A restart resets the write counter, so the export cannot prove nothing was written.
		await worker.evict("evicted");

		const second = await exportRequest(id, first.cursor);
		expect(second.status).toBe(409);
		expect(await second.json()).toMatchObject({ error: { code: "migrator.dirty" } });

		const { db } = await exportInto("evicted");
		expect(db.prepare(`SELECT count(*) AS n FROM notes`).get()).toEqual({ n: 3 });
	});
});

describe("bad requests", () => {
	test("a malformed cursor or one with an unknown phase gets 400 instead of a crash or an endless export", async () => {
		await seed(worker, "bad-cursor", { big: true });
		const { id } = await worker.migrator().resolve("ROOMS", { name: "bad-cursor" });
		const { cursor } = (await (await exportRequest(id)).json()) as { cursor: string };

		for (const bad of ["null", JSON.stringify({ ...JSON.parse(cursor), phase: "done" })]) {
			const res = await exportRequest(id, bad);
			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({ error: { code: "migrator.bad_request" } });
		}
	});

	test("a Durable Object with key-value storage is reported as unsupported", async () => {
		const migrator = worker.migrator();
		const { id } = await migrator.resolve("KV_ROOMS", { name: "kv" });

		const pages = migrator.exportObject({ binding: "KV_ROOMS", id });
		await expect(pages.next()).rejects.toMatchObject({ code: "migrator.unsupported", status: 501 });
	});

	test("a binding whose class is not wrapped with migratable fails with the real error", async () => {
		const migrator = worker.migrator();
		const { id } = await migrator.resolve("PLAIN", { name: "plain" });

		const pages = migrator.exportObject({ binding: "PLAIN", id });
		await expect(pages.next()).rejects.toMatchObject({ code: "migrator.internal", status: 502 });
	});
});

describe("background work", () => {
	test("a write still pending in ctx.waitUntil makes the export fail, and the retry includes it", async () => {
		await seed(worker, "late");
		expect((await worker.app("late", "late-write")).status).toBe(200);

		const migrator = worker.migrator();
		const { id } = await migrator.resolve("ROOMS", { name: "late" });
		const attempt = async () => {
			for await (const _ of migrator.exportObject({ binding: "ROOMS", id })) {
			}
		};
		await expect(attempt()).rejects.toBeInstanceOf(MigrationDirtyError);

		expect((await worker.app("late", "release")).status).toBe(200);
		const { db } = await exportInto("late");
		expect(db.prepare(`SELECT count(*) AS n FROM notes WHERE body = 'late write'`).get()).toEqual({ n: 1 });
	});
});

describe("after migration", () => {
	test("app fetch and RPC are rejected, and a second export still carries the data and the alarm", async () => {
		await seed(worker, "moved");
		const { alarm } = await sourceSnapshot(worker, "moved");
		await exportInto("moved");

		const fetched = await worker.app("moved", "ping");
		expect(fetched.status).toBe(503);
		expect(await fetched.json()).toMatchObject({ error: { code: "migrator.moved" } });

		const rpc = await worker.app("moved", "rpc-note");
		expect(await rpc.text()).toContain("migrator.moved");

		// For example, the destination failed after the last page and migrate runs again.
		const again = await exportInto("moved");
		expect(again.db.prepare(`SELECT count(*) AS n FROM notes`).get()).toEqual({ n: 3 });
		expect(again.db.prepare(`SELECT value FROM __do_meta WHERE key = 'alarm'`).get()).toEqual({ value: alarm });
	});
});

describe("auth", () => {
	test("a wrong token gets no data", async () => {
		await seed(worker, "secret");
		const bad = createClient({ workerUrl: worker.url, token: "wrong" });

		await expect(bad.resolve("ROOMS", { name: "secret" })).rejects.toMatchObject({ code: "migrator.unauthorized" });
	});

	test("an app that forwards requests to the Durable Object does not expose the export", async () => {
		await seed(worker, "forwarded");
		const { id } = await worker.migrator().resolve("ROOMS", { name: "forwarded" });

		const res = await worker.app("forwarded", `forward/__migrate/ROOMS/export?id=${id}`);

		expect(res.status).toBe(401);
		expect(await res.text()).not.toContain("CREATE TABLE");
	});

	test("a workerUrl that points at the new server instead of Cloudflare fails with a clear error", async () => {
		// Stands in for the new server that the main domain points at after DNS cutover.
		const server = createServer((_, res) => res.end("hello from the new server"));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		const wrong = createClient({ workerUrl: `http://127.0.0.1:${port}`, token: TOKEN });

		try {
			const err = await wrong.resolve("ROOMS", { name: "x" }).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(MigratorError);
			expect(err).toMatchObject({ code: "migrator.not_a_migrator" });
		} finally {
			server.close();
		}
	});
});
