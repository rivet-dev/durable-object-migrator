// durable-object-migrator: your new server.
//
// Copy this file into the server that replaces your Worker. It has no
// dependencies and only needs `fetch`.
//
//   const migrator = createClient({ workerUrl: "https://my-app.workers.dev", token });
//   for await (const page of migrator.exportObject({ binding: "ROOMS", id })) db.exec(page.sql);

const ROUTE_PREFIX = "/__migrate/";
const MIGRATOR_HEADER = "x-migrator";
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

export class MigratorError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status?: number,
	) {
		super(`${code}: ${message}`);
		this.name = "MigratorError";
	}
}

/** The Durable Object was written to during the export. Clear what you wrote and migrate it again. */
export class MigrationDirtyError extends MigratorError {
	constructor(message: string) {
		super("migrator.dirty", message, 409);
		this.name = "MigrationDirtyError";
	}
}

export type ClientOptions = {
	/** A URL that still reaches Cloudflare after DNS cutover, for example your workers.dev URL. */
	workerUrl: string;
	/** Same value as `WORKER_MIGRATOR_TOKEN` on the Worker. */
	token: string;
};

export type ExportPage = {
	/** The statements of this page joined into one SQL script. */
	sql: string;
	/** The same statements one by one, for databases that run one statement per call. */
	statements: readonly string[];
};

export type CloudflareOptions = {
	/** Needs a Workers read permission. */
	apiToken: string;
	accountId: string;
	/** Your Worker's name. */
	scriptName: string;
	/** The Durable Object class name, for example "Room". */
	className: string;
	/** Override the Cloudflare API base URL. */
	apiUrl?: string;
};

export type BackfillOptions = {
	cloudflare: CloudflareOptions;
	/** The value last passed to `updateStartAt`, or `null` to start from the beginning. */
	startAt: string | null;
	/** Save this value so a crashed backfill can resume. */
	updateStartAt: (startAt: string) => void | Promise<void>;
	/** Moves one Durable Object. Must be safe to call many times. */
	migrate: (target: { id: string }) => Promise<void>;
	/** Durable Objects migrated at the same time. Default 8. */
	concurrency?: number;
	/** Extra attempts per Durable Object before it is reported as failed. Default 3. */
	retries?: number;
	/** Stops taking new Durable Objects. Ones already running finish first. */
	signal?: AbortSignal;
};

export type BackfillResult = {
	done: number;
	failed: readonly { readonly id: string; readonly error: unknown }[];
};

type ExportResponse = { statements: string[]; cursor: string | null };
type ResolveResponse = { id: string; name: string | null };

export type MigratorClient = {
	exportObject(target: {
		binding: string;
		id: string;
		signal?: AbortSignal;
	}): AsyncGenerator<ExportPage, void, undefined>;
	resolve(binding: string, target: { name: string } | { id: string }): Promise<ResolveResponse>;
	backfill(opts: BackfillOptions): Promise<BackfillResult>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readExport(body: unknown): ExportResponse | null {
	if (!isRecord(body) || !Array.isArray(body.statements)) return null;
	const { statements, cursor } = body;
	if (!statements.every((s) => typeof s === "string")) return null;
	if (cursor !== null && typeof cursor !== "string") return null;
	return { statements, cursor };
}

function readResolve(body: unknown): ResolveResponse | null {
	if (!isRecord(body) || typeof body.id !== "string") return null;
	if (body.name !== null && typeof body.name !== "string") return null;
	return { id: body.id, name: body.name };
}

function readError(body: unknown): { code: string; message: string } | null {
	if (!isRecord(body) || !isRecord(body.error)) return null;
	const { code, message } = body.error;
	return typeof code === "string" && typeof message === "string" ? { code, message } : null;
}

export function createClient(opts: ClientOptions): MigratorClient {
	const call = async <T>(
		binding: string,
		action: string,
		params: Record<string, string>,
		read: (body: unknown) => T | null,
		signal?: AbortSignal,
	): Promise<T> => {
		const url = new URL(`${ROUTE_PREFIX}${encodeURIComponent(binding)}/${action}`, opts.workerUrl);
		for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
		const res = await fetch(url, { headers: { authorization: `Bearer ${opts.token}` }, signal });
		if (!res.headers.has(MIGRATOR_HEADER)) {
			throw new MigratorError(
				"migrator.not_a_migrator",
				`${opts.workerUrl} did not answer as a migrator Worker (HTTP ${res.status}). ` +
					"After DNS cutover, workerUrl must still reach Cloudflare, for example your workers.dev URL.",
				res.status,
			);
		}
		const body: unknown = await res.json().catch(() => undefined);
		if (!res.ok) {
			const error = readError(body);
			if (!error) throw new MigratorError("migrator.bad_response", `HTTP ${res.status} with no error body`, res.status);
			if (error.code === "migrator.dirty") throw new MigrationDirtyError(error.message);
			throw new MigratorError(error.code, error.message, res.status);
		}
		const value = read(body);
		if (value === null) throw new MigratorError("migrator.bad_response", `unexpected ${action} response`, res.status);
		return value;
	};

	return {
		/**
		 * Yields one Durable Object as pages of SQL. Run every page in order on an
		 * empty database with foreign keys off. When it finishes, the Durable Object
		 * on Cloudflare rejects app traffic.
		 *
		 * Throws `MigrationDirtyError` if the object was written to during the export.
		 */
		async *exportObject(target) {
			const fetchPage = (cursor: string | null) => {
				const params: Record<string, string> = cursor === null ? { id: target.id } : { id: target.id, cursor };
				const p = call(target.binding, "export", params, readExport, target.signal);
				// Handled when awaited. This only stops an unhandled rejection if the caller stops early.
				p.catch(() => {});
				return p;
			};

			let next = fetchPage(null);
			while (true) {
				const page = await next;
				// Fetch the next page while the caller writes this one, so the
				// Durable Object stays awake between pages.
				if (page.cursor !== null) next = fetchPage(page.cursor);
				yield { sql: page.statements.join("\n"), statements: page.statements };
				if (page.cursor === null) return;
			}
		},

		/** Turns a name into an id (does not wake the Durable Object), or an id into its saved name (wakes it). */
		resolve(binding, target) {
			return call(binding, "resolve", "name" in target ? { name: target.name } : { id: target.id }, readResolve);
		},

		/** Lists every Durable Object with stored data and runs `migrate` on each one. */
		backfill(backfillOpts) {
			return backfill(backfillOpts);
		},
	};
}

// Backfill
// =======================================================================================

type Position = { listCursor: string | null; index: number };

async function backfill(opts: BackfillOptions): Promise<BackfillResult> {
	const concurrency = opts.concurrency ?? 8;
	const retries = opts.retries ?? 3;
	const failed: { id: string; error: unknown }[] = [];
	let done = 0;

	let saved = opts.startAt;
	let saving = Promise.resolve();
	// The saved position never passes a Durable Object that failed, so a resumed
	// run retries it. Objects after it run again, and `migrate` skips the done ones.
	let failedOnce = false;
	const save = (pos: Position) => {
		if (failedOnce) return saving;
		const value = JSON.stringify(pos);
		saving = saving.then(async () => {
			if (value === saved) return;
			await opts.updateStartAt(value);
			saved = value;
		});
		return saving;
	};

	const start: Position = opts.startAt ? parsePosition(opts.startAt) : { listCursor: null, index: 0 };
	const namespaceId = await findNamespace(opts.cloudflare);

	let listCursor = start.listCursor;
	let skip = start.index;
	while (true) {
		const page = await listObjects(opts.cloudflare, namespaceId, listCursor);
		const pageCursor = listCursor;

		await pool(
			page.ids.length - skip,
			concurrency,
			opts.signal,
			async (i) => {
				const id = page.ids[skip + i];
				if (id == null) return;
				const outcome = await withRetries(retries, opts.signal, () => opts.migrate({ id }));
				if (outcome.ok) {
					done++;
				} else {
					failedOnce = true;
					failed.push({ id, error: outcome.error });
				}
			},
			(mark) => save({ listCursor: pageCursor, index: skip + mark }),
		);

		if (opts.signal?.aborted) {
			await saving;
			opts.signal.throwIfAborted();
		}
		if (!page.nextCursor) break;
		listCursor = page.nextCursor;
		skip = 0;
		await save({ listCursor, index: 0 });
	}
	await saving;
	return { done, failed };
}

function parsePosition(value: string): Position {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		parsed = undefined;
	}
	if (isRecord(parsed)) {
		const { listCursor, index } = parsed;
		if (
			(listCursor === null || typeof listCursor === "string") &&
			typeof index === "number" &&
			Number.isSafeInteger(index) &&
			index >= 0
		) {
			return { listCursor, index };
		}
	}
	throw new MigratorError("migrator.bad_start_at", "startAt is not a value that updateStartAt received");
}

/**
 * Runs `work(0..count-1)` with `concurrency` lanes. After each item, reports the
 * watermark: every index below it is finished, so resuming there repeats nothing
 * that completed.
 */
async function pool(
	count: number,
	concurrency: number,
	signal: AbortSignal | undefined,
	work: (i: number) => Promise<void>,
	onWatermark: (mark: number) => Promise<void>,
): Promise<void> {
	const finished = new Array<boolean>(Math.max(count, 0)).fill(false);
	let next = 0;
	let mark = 0;
	const lane = async () => {
		while (next < count && !signal?.aborted) {
			const i = next++;
			await work(i);
			finished[i] = true;
			while (mark < count && finished[mark]) mark++;
			await onWatermark(mark);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, count) }, lane));
}

async function withRetries(
	retries: number,
	signal: AbortSignal | undefined,
	fn: () => Promise<void>,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
	for (let attempt = 0; ; attempt++) {
		try {
			await fn();
			return { ok: true };
		} catch (error) {
			if (attempt >= retries || signal?.aborted) return { ok: false, error };
			await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
		}
	}
}

type ResultInfo = { total_pages?: number; cursor?: string };

async function cloudflareGet<T>(cf: CloudflareOptions, path: string): Promise<{ result: T; result_info?: ResultInfo }> {
	const res = await fetch(`${cf.apiUrl ?? CLOUDFLARE_API}/accounts/${cf.accountId}${path}`, {
		headers: { authorization: `Bearer ${cf.apiToken}` },
	});
	const body = (await res.json().catch(() => null)) as {
		success?: boolean;
		result: T;
		result_info?: ResultInfo;
		errors?: unknown;
	} | null;
	if (!res.ok || !body?.success) {
		throw new MigratorError(
			"migrator.cloudflare_api",
			`GET ${path} failed with HTTP ${res.status}: ${JSON.stringify(body?.errors ?? body)}`,
			res.status,
		);
	}
	return body;
}

async function findNamespace(cf: CloudflareOptions): Promise<string> {
	type Namespace = { id: string; script?: string; class?: string };
	const seen: string[] = [];
	for (let page = 1; ; page++) {
		const body = await cloudflareGet<Namespace[]>(cf, `/workers/durable_objects/namespaces?per_page=1000&page=${page}`);
		for (const ns of body.result) {
			if (ns.script === cf.scriptName && ns.class === cf.className) return ns.id;
			seen.push(`${ns.script}/${ns.class}`);
		}
		const totalPages = body.result_info?.total_pages ?? 1;
		if (body.result.length === 0 || page >= totalPages) break;
	}
	throw new MigratorError(
		"migrator.cloudflare_api",
		`no Durable Object namespace for script "${cf.scriptName}" and class "${cf.className}". Found: ${seen.join(", ") || "none"}`,
	);
}

async function listObjects(
	cf: CloudflareOptions,
	namespaceId: string,
	cursor: string | null,
): Promise<{ ids: (string | null)[]; nextCursor: string | null }> {
	type DurableObject = { id: string; hasStoredData: boolean };
	const query = cursor ? `limit=10000&cursor=${encodeURIComponent(cursor)}` : "limit=10000";
	const body = await cloudflareGet<DurableObject[]>(
		cf,
		`/workers/durable_objects/namespaces/${namespaceId}/objects?${query}`,
	);
	return {
		// Objects without data keep their slot so saved positions stay stable.
		ids: body.result.map((o) => (o.hasStoredData ? o.id : null)),
		nextCursor: body.result.length > 0 ? body.result_info?.cursor || null : null,
	};
}
