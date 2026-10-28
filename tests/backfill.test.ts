import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { openDestination, startWorker, type Worker } from "./helpers";

let worker: Worker;
let cloudflare: Server;
let apiUrl: string;
const objects: { id: string; hasStoredData: boolean }[] = [];
const NAMES = ["a", "b", "c", "d", "e", "f", "g"];

beforeAll(async () => {
	worker = await startWorker();
	const migrator = worker.migrator();
	for (const name of NAMES) {
		expect((await worker.app(name, "seed")).status).toBe(200);
		objects.push({ id: (await migrator.resolve("ROOMS", { name })).id, hasStoredData: true });
	}
	objects.splice(3, 0, { id: "0".repeat(64), hasStoredData: false });

	// Stands in for the Cloudflare REST API. Lists 3 objects per page.
	cloudflare = createServer((req, res) => {
		const url = new URL(req.url ?? "", "http://x");
		res.setHeader("content-type", "application/json");
		if (req.headers.authorization !== "Bearer cf-token") {
			res.statusCode = 403;
			return res.end(JSON.stringify({ success: false, errors: [{ message: "bad token" }] }));
		}
		if (url.pathname === "/accounts/acc/workers/durable_objects/namespaces") {
			return res.end(
				JSON.stringify({
					success: true,
					result: [
						{ id: "ns-other", script: "other", class: "Room" },
						{ id: "ns-rooms", script: "my-app", class: "Room" },
					],
					result_info: { page: 1, total_pages: 1 },
				}),
			);
		}
		if (url.pathname === "/accounts/acc/workers/durable_objects/namespaces/ns-rooms/objects") {
			const start = Number(url.searchParams.get("cursor") ?? 0);
			const page = objects.slice(start, start + 3);
			const next = start + 3 < objects.length ? String(start + 3) : "";
			return res.end(JSON.stringify({ success: true, result: page, result_info: { cursor: next } }));
		}
		res.statusCode = 404;
		res.end(JSON.stringify({ success: false, errors: [{ message: "not found" }] }));
	});
	await new Promise<void>((resolve) => cloudflare.listen(0, "127.0.0.1", resolve));
	apiUrl = `http://127.0.0.1:${(cloudflare.address() as AddressInfo).port}`;
});

afterAll(async () => {
	cloudflare?.close();
	await worker?.dispose();
});

test("a backfill stopped halfway resumes from its saved position and moves every Durable Object", async () => {
	const migrator = worker.migrator();
	const destinations = new Map<string, DatabaseSync>();
	const done = new Set<string>();

	// User writes this.
	const migrate = async ({ id }: { id: string }) => {
		if (done.has(id)) return;
		const db = openDestination();
		for await (const page of migrator.exportObject({ binding: "ROOMS", id })) db.exec(page.sql);
		destinations.set(id, db);
		done.add(id);
	};

	let startAt: string | null = null;
	const options = (signal?: AbortSignal) => ({
		cloudflare: { apiToken: "cf-token", accountId: "acc", scriptName: "my-app", className: "Room", apiUrl },
		startAt,
		updateStartAt: (value: string) => {
			startAt = value;
		},
		concurrency: 2,
		signal,
	});

	const stop = new AbortController();
	const first = migrator.backfill({
		...options(stop.signal),
		migrate: async (target) => {
			await migrate(target);
			if (done.size === 3) stop.abort();
		},
	});
	await expect(first).rejects.toThrow();
	expect(done.size).toBeLessThan(NAMES.length);
	expect(startAt).not.toBeNull();

	const second = await migrator.backfill({ ...options(), migrate });

	expect(second.failed).toEqual([]);
	expect(done.size).toBe(NAMES.length);
	for (const { id, hasStoredData } of objects) {
		if (!hasStoredData) continue;
		const db = destinations.get(id)!;
		expect(db.prepare(`SELECT count(*) AS n FROM notes`).get()).toEqual({ n: 3 });
	}
	// Every migrated Durable Object now rejects app traffic on Cloudflare.
	for (const name of NAMES) expect((await worker.app(name, "ping")).status).toBe(503);
});

test("a Durable Object that keeps failing is reported, and the rest still move", async () => {
	const migrator = worker.migrator();
	const broken = objects[0]!.id;
	const moved: string[] = [];

	const result = await migrator.backfill({
		cloudflare: { apiToken: "cf-token", accountId: "acc", scriptName: "my-app", className: "Room", apiUrl },
		startAt: null,
		updateStartAt: () => {},
		retries: 1,
		migrate: async ({ id }) => {
			if (id === broken) throw new Error("destination is down");
			moved.push(id);
		},
	});

	expect(result.failed.map((f) => f.id)).toEqual([broken]);
	expect(result.done).toBe(NAMES.length - 1);
	expect(moved).not.toContain(broken);
});

test("a wrong Cloudflare token fails with the API error", async () => {
	const result = worker.migrator().backfill({
		cloudflare: { apiToken: "nope", accountId: "acc", scriptName: "my-app", className: "Room", apiUrl },
		startAt: null,
		updateStartAt: () => {},
		migrate: async () => {},
	});
	await expect(result).rejects.toMatchObject({ code: "migrator.cloudflare_api", status: 403 });
});

test("a Durable Object that failed is retried when the backfill resumes", async () => {
	const migrator = worker.migrator();
	const broken = objects[0]!.id;
	const cloudflareOptions = { apiToken: "cf-token", accountId: "acc", scriptName: "my-app", className: "Room", apiUrl };
	let startAt: string | null = null;
	const saveStartAt = (value: string) => {
		startAt = value;
	};

	const first = await migrator.backfill({
		cloudflare: cloudflareOptions,
		startAt,
		updateStartAt: saveStartAt,
		retries: 0,
		migrate: async ({ id }) => {
			if (id === broken) throw new Error("destination is down");
		},
	});
	expect(first.failed.map((f) => f.id)).toEqual([broken]);

	const retried: string[] = [];
	await migrator.backfill({
		cloudflare: cloudflareOptions,
		startAt,
		updateStartAt: saveStartAt,
		migrate: async ({ id }) => {
			retried.push(id);
		},
	});
	expect(retried).toContain(broken);
});
