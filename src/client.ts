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
	statements: string[];
};

export type BackfillOptions = {
	cloudflare: {
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
	failed: { id: string; error: unknown }[];
};

export function createClient(opts: ClientOptions) {
	const call = async <T>(binding: string, action: string, params: Record<string, string>, signal?: AbortSignal) => {
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
		const body = (await res.json()) as T | { error: { code: string; message: string } };
		if (!res.ok) {
			const { code, message } = (body as { error: { code: string; message: string } }).error;
			if (code === "migrator.dirty") throw new MigrationDirtyError(message);
			throw new MigratorError(code, message, res.status);
		}
		return body as T;
	};

	return {
		/**
		 * Yields one Durable Object as pages of SQL. Run every page in order on an
		 * empty database with foreign keys off. When it finishes, the Durable Object
		 * on Cloudflare rejects app traffic.
		 *
		 * Throws `MigrationDirtyError` if the object was written to during the export.
		 */
		async *exportObject(target: { binding: string; id: string; signal?: AbortSignal }): AsyncGenerator<ExportPage> {
			type Page = { statements: string[]; cursor: string | null };
			const fetchPage = (cursor: string) => {
				const params: Record<string, string> = { id: target.id };
				if (cursor) params.cursor = cursor;
				const p = call<Page>(target.binding, "export", params, target.signal);
				// Handled when awaited. This only stops an unhandled rejection if the caller stops early.
				p.catch(() => {});
				return p;
			};

			let next = fetchPage("");
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
		resolve(binding: string, target: { name: string } | { id: string }): Promise<{ id: string; name: string | null }> {
			return call(binding, "resolve", "name" in target ? { name: target.name } : { id: target.id });
		},

		/** Lists every Durable Object with stored data and runs `migrate` on each one. */
		backfill(opts: BackfillOptions): Promise<BackfillResult> {
			return backfill(opts);
		},
	};
}

// Backfill
// =======================================================================================

type Position = { listCursor: string | null; index: number };

async function backfill(opts: BackfillOptions): Promise<BackfillResult> {
	const concurrency = opts.concurrency ?? 8;
	const retries = opts.retries ?? 3;
	const result: BackfillResult = { done: 0, failed: [] };

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

	const start: Position = opts.startAt ? (JSON.parse(opts.startAt) as Position) : { listCursor: null, index: 0 };
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
				const id = page.ids[skip + i]!;
				if (id === null) return;
				const error = await withRetries(retries, opts.signal, () => opts.migrate({ id }));
				if (error === undefined) {
					result.done++;
				} else {
					failedOnce = true;
					result.failed.push({ id, error });
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
	return result;
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
): Promise<unknown> {
	for (let attempt = 0; ; attempt++) {
		try {
			await fn();
			return undefined;
		} catch (err) {
			if (attempt >= retries || signal?.aborted) return err;
			await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
		}
	}
}

async function cloudflareGet<T>(
	cf: BackfillOptions["cloudflare"],
	path: string,
): Promise<{ result: T; result_info?: any }> {
	const res = await fetch(`${cf.apiUrl ?? CLOUDFLARE_API}/accounts/${cf.accountId}${path}`, {
		headers: { authorization: `Bearer ${cf.apiToken}` },
	});
	const body = (await res.json().catch(() => null)) as {
		success?: boolean;
		result: T;
		result_info?: any;
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

async function findNamespace(cf: BackfillOptions["cloudflare"]): Promise<string> {
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
	cf: BackfillOptions["cloudflare"],
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
