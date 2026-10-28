// durable-object-migrator: Cloudflare side.
//
// Copy this file into your Worker. It needs `devalue` (npm i devalue).
//
//   export const Room = migratable(RoomImpl);
//   export default {
//     fetch: (req, env, ctx) =>
//       migrationRoute(req, env, { token: env.WORKER_MIGRATOR_TOKEN }) ?? app.fetch(req, env, ctx),
//   };
//
// Only SQLite-backed Durable Objects are supported.

import { stringify } from "devalue";

const ROUTE_PREFIX = "/__migrate/";
const MIGRATOR_HEADER = "x-migrator";
const TOKEN_ENV = "WORKER_MIGRATOR_TOKEN";
const DISABLED_ENV = "MIGRATOR_DISABLED";

// Tables owned by this file. They never appear in an export.
const STATE_TABLE = "__migrator";
const KV_TABLE = "__do_kv";
const META_TABLE = "__do_meta";

// One export page stays near this size. A single row can be up to 2 MB on
// Cloudflare, so a page always holds at least one row.
const PAGE_BYTES = 4 * 1024 * 1024;
const ROWS_PER_QUERY = 500;
const KV_PER_LIST = 128;

const HANDLER_NAMES = new Set([
	"constructor",
	"fetch",
	"alarm",
	"webSocketMessage",
	"webSocketClose",
	"webSocketError",
]);

type Env = Record<string, unknown>;
type DurableObjectClass = new (...args: any[]) => object;

const STATE = Symbol("durable-object-migrator");

/**
 * Wraps a Durable Object class so it can export itself.
 *
 * The returned class behaves exactly like `Base` until it is migrated. After
 * that, app traffic (fetch, RPC, alarms, hibernated WebSockets) is rejected
 * with `migrator.moved`, so a late write cannot land on the old copy.
 */
export function migratable<T extends DurableObjectClass>(Base: T): T {
	const base = Base.prototype as Record<string, any>;

	class Migratable extends Base {
		constructor(...args: any[]) {
			super(...args);
			const [ctx, env] = args as [DurableObjectState, Env];
			(this as any)[STATE] = new MigratorState(ctx, env);
		}
	}
	const proto = Migratable.prototype as Record<string, any>;

	proto.fetch = async function (this: any, req: Request): Promise<Response> {
		const m: MigratorState = this[STATE];
		if (new URL(req.url).pathname.startsWith(ROUTE_PREFIX)) return m.handle(req);
		if (m.isMigrated()) return movedResponse();
		if (typeof base.fetch !== "function") {
			throw new Error("this Durable Object does not implement fetch()");
		}
		return m.track(() => base.fetch.call(this, req));
	};

	if (typeof base.alarm === "function") {
		proto.alarm = async function (this: any, info: unknown) {
			const m: MigratorState = this[STATE];
			// The export already saved the alarm time for the new server.
			if (m.isMigrated()) return;
			return m.track(() => base.alarm.call(this, info));
		};
	}

	for (const name of ["webSocketMessage", "webSocketClose", "webSocketError"]) {
		if (typeof base[name] !== "function") continue;
		proto[name] = function (this: any, ...args: unknown[]) {
			const m: MigratorState = this[STATE];
			m.guard();
			return m.track(() => base[name].apply(this, args));
		};
	}

	for (const name of rpcMethodNames(Base)) {
		proto[name] = function (this: any, ...args: unknown[]) {
			const m: MigratorState = this[STATE];
			m.guard();
			return m.track(() => base[name].apply(this, args));
		};
	}

	return Migratable;
}

/**
 * Handles `/__migrate/*` in your Worker's fetch. Returns `null` for every other
 * request so your app handles it.
 */
export function migrationRoute(req: Request, env: Env, opts: { token: string | undefined }): Promise<Response> | null {
	const url = new URL(req.url);
	if (!url.pathname.startsWith(ROUTE_PREFIX)) return null;
	return routeToObject(req, url, env, opts.token);
}

async function routeToObject(req: Request, url: URL, env: Env, token: string | undefined): Promise<Response> {
	if (!token) {
		return errorResponse(500, "migrator.not_configured", `${TOKEN_ENV} is not set on the Worker`);
	}
	if (!tokenMatches(req, token)) {
		return errorResponse(401, "migrator.unauthorized", "missing or wrong migrator token");
	}

	const [binding, action] = url.pathname.slice(ROUTE_PREFIX.length).split("/");
	const ns = env[binding ?? ""] as DurableObjectNamespace | undefined;
	if (!ns || typeof ns.idFromName !== "function") {
		return errorResponse(404, "migrator.unknown_binding", `no Durable Object binding named "${binding}"`);
	}

	const name = url.searchParams.get("name");
	if (action === "resolve" && name !== null) {
		// Computed in the Worker. The Durable Object is not woken.
		return jsonResponse({ id: ns.idFromName(name).toString(), name });
	}

	const idParam = url.searchParams.get("id");
	if (!idParam) return errorResponse(400, "migrator.bad_request", "missing ?id= or ?name=");
	let id: DurableObjectId;
	try {
		id = ns.idFromString(idParam);
	} catch {
		return errorResponse(400, "migrator.bad_request", `"${idParam}" is not a Durable Object id for this binding`);
	}
	return ns.get(id).fetch(req);
}

class MigratorState {
	readonly instanceId = crypto.randomUUID();
	readonly sql: SqlStorage | null;
	#migrated = false;
	#savedName: string | null = null;
	#savedAlarm: number | null = null;
	#inFlight = 0;

	constructor(
		readonly ctx: DurableObjectState,
		readonly env: Env,
	) {
		this.#countWaitUntil();
		this.sql = sqlOrNull(ctx);
		if (!this.sql) return;
		// Created on first write, so a Durable Object nobody migrates stays untouched.
		const exists = this.sql.exec(`SELECT 1 FROM sqlite_master WHERE name = ?`, STATE_TABLE).toArray().length > 0;
		if (!exists) return;
		for (const row of this.sql.exec(`SELECT key, value FROM "${STATE_TABLE}"`)) {
			if (row.key === "state") this.#migrated = row.value === "migrated";
			if (row.key === "name") this.#savedName = row.value as string;
			if (row.key === "alarm") this.#savedAlarm = row.value as number;
		}
		if (this.#migrated && this.env[DISABLED_ENV] === "true" && this.#savedAlarm !== null) {
			this.#restoreAlarm(this.#savedAlarm);
		}
	}

	// Rollback: the export removed the alarm, so put it back. A time already in
	// the past makes it run right away.
	#restoreAlarm(at: number): void {
		this.ctx.blockConcurrencyWhile(async () => {
			if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(at);
			this.sql!.exec(`DELETE FROM "${STATE_TABLE}" WHERE key = 'alarm'`);
			this.#savedAlarm = null;
		});
	}

	// Work handed to ctx.waitUntil can write after its request has returned. It
	// counts as in flight, so an export cannot finish while it may still write.
	// If the runtime ever refuses the override, the object still starts; it only
	// loses this check.
	#countWaitUntil(): void {
		const ctx = this.ctx;
		const waitUntil = ctx.waitUntil.bind(ctx);
		try {
			ctx.waitUntil = (promise: Promise<unknown>) => {
				this.#inFlight++;
				const settle = () => {
					this.#inFlight--;
				};
				promise.then(settle, settle);
				waitUntil(promise);
			};
		} catch (err) {
			console.warn(
				"durable-object-migrator: cannot track ctx.waitUntil; pending background writes are not checked",
				err,
			);
		}
	}

	isMigrated(): boolean {
		return this.#migrated && this.env[DISABLED_ENV] !== "true";
	}

	guard(): void {
		if (this.isMigrated()) {
			throw new Error("migrator.moved: this Durable Object was migrated to a new server");
		}
	}

	get inFlight(): number {
		return this.#inFlight;
	}

	/** Runs an app handler and counts it as in flight until it settles. */
	async track<R>(fn: () => R | Promise<R>): Promise<R> {
		this.#saveName();
		this.#inFlight++;
		try {
			return await fn();
		} finally {
			this.#inFlight--;
		}
	}

	get name(): string | null {
		return this.#savedName ?? this.ctx.id.name ?? null;
	}

	/** `alarm` is the pending alarm the export saw. It is kept so a rollback can set it again. */
	markMigrated(alarm: number | null): void {
		this.#ensureStateTable();
		this.sql!.exec(`INSERT OR REPLACE INTO "${STATE_TABLE}"(key, value) VALUES ('state', 'migrated')`);
		if (alarm !== null) {
			this.sql!.exec(`INSERT OR REPLACE INTO "${STATE_TABLE}"(key, value) VALUES ('alarm', ?)`, alarm);
		}
		this.#migrated = true;
	}

	// Cloudflare never returns a Durable Object's name through its API, and
	// `ctx.id.name` is undefined when the object is reached by id. Saving it
	// here is the only way backfill can turn an id back into a name.
	#saveName(): void {
		const name = this.ctx.id.name;
		if (!this.sql || !name || name === this.#savedName) return;
		this.#ensureStateTable();
		this.sql.exec(`INSERT OR REPLACE INTO "${STATE_TABLE}"(key, value) VALUES ('name', ?)`, name);
		this.#savedName = name;
	}

	#ensureStateTable(): void {
		this.sql!.exec(`CREATE TABLE IF NOT EXISTS "${STATE_TABLE}"(key TEXT PRIMARY KEY, value)`);
	}

	async handle(req: Request): Promise<Response> {
		const token = this.env[TOKEN_ENV] as string | undefined;
		if (!token) {
			return errorResponse(500, "migrator.not_configured", `${TOKEN_ENV} is not set on the Worker`);
		}
		// Checked again here because apps often forward user requests straight
		// to the Durable Object.
		if (!tokenMatches(req, token)) {
			return errorResponse(401, "migrator.unauthorized", "missing or wrong migrator token");
		}
		if (!this.sql) {
			return errorResponse(501, "migrator.unsupported", "only SQLite-backed Durable Objects can be migrated");
		}

		const url = new URL(req.url);
		const action = url.pathname.slice(ROUTE_PREFIX.length).split("/")[1];
		if (action === "resolve") {
			return jsonResponse({ id: this.ctx.id.toString(), name: this.name });
		}
		if (action !== "export") {
			return errorResponse(404, "migrator.bad_request", `unknown action "${action}"`);
		}

		try {
			return jsonResponse(await exportPage(this, this.sql, url.searchParams.get("cursor")));
		} catch (err) {
			if (err instanceof MigratorError) return errorResponse(err.status, err.code, err.message);
			const message = err instanceof Error ? err.message : String(err);
			return errorResponse(500, "migrator.internal", `export failed inside the Durable Object: ${message}`);
		}
	}
}

// Export
// =======================================================================================

type Cursor = {
	instanceId: string;
	startChanges: number;
	schema: number;
	phase: "rows" | "kv" | "tail";
	table: number;
	// rows: quote() literals of the last key. kv: the last key.
	after: string[] | string | null;
};

type TableInfo = {
	name: string;
	sql: string;
	withoutRowid: boolean;
};

class MigratorError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

async function exportPage(
	m: MigratorState,
	sql: SqlStorage,
	cursorParam: string | null,
): Promise<{ statements: string[]; cursor: string | null }> {
	const out: string[] = [];
	let bytes = 0;
	const push = (stmt: string) => {
		out.push(stmt);
		bytes += stmt.length;
	};

	const tables = listTables(sql);
	let cursor: Cursor;
	if (!cursorParam) {
		cursor = {
			instanceId: m.instanceId,
			startChanges: totalChanges(sql),
			schema: schemaFingerprint(sql),
			phase: "rows",
			table: 0,
			after: null,
		};
		push("PRAGMA foreign_keys=OFF;");
		push(`CREATE TABLE "${KV_TABLE}"(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
		push(`CREATE TABLE "${META_TABLE}"(key TEXT PRIMARY KEY, value);`);
		for (const t of tables) push(`${t.sql};`);
	} else {
		cursor = decodeCursor(cursorParam);
		assertClean(m, sql, cursor);
	}

	while (cursor.phase === "rows" && bytes < PAGE_BYTES) {
		const table = tables[cursor.table];
		if (!table) {
			cursor = { ...cursor, phase: "kv", table: 0, after: null };
			break;
		}
		const { statements, lastKey, done } = readRows(sql, table, cursor.after as string[] | null, PAGE_BYTES - bytes);
		for (const s of statements) push(s);
		cursor = done ? { ...cursor, table: cursor.table + 1, after: null } : { ...cursor, after: lastKey };
	}

	while (cursor.phase === "kv" && bytes < PAGE_BYTES) {
		const after = cursor.after as string | null;
		const entries = await m.ctx.storage.list(
			after === null ? { limit: KV_PER_LIST } : { startAfter: after, limit: KV_PER_LIST },
		);
		let last = after;
		for (const [key, value] of entries) {
			push(
				`INSERT INTO "${KV_TABLE}"(key, value) VALUES (${sqlString(key)}, ${sqlString(encodeKvValue(key, value))});`,
			);
			last = key;
		}
		cursor = entries.size < KV_PER_LIST ? { ...cursor, phase: "tail", after: null } : { ...cursor, after: last };
	}

	if (cursor.phase !== "tail" || bytes >= PAGE_BYTES) {
		return { statements: out, cursor: encodeCursor(cursor) };
	}

	const alarm = await m.ctx.storage.getAlarm();
	const finalCursor = cursor;
	m.ctx.storage.transactionSync(() => {
		for (const s of tailStatements(sql, tables, m, alarm)) push(s);
		// The dirty check and the flag share one synchronous transaction, so no
		// write can land between them.
		assertClean(m, sql, finalCursor);
		if (m.inFlight > 0) {
			throw new MigratorError(409, "migrator.dirty", "app requests were still running when the export finished");
		}
		m.markMigrated(alarm);
	});
	// The new server has the alarm time from __do_meta. Removing it here means
	// scheduled work can never run on the old copy.
	if (alarm !== null) await m.ctx.storage.deleteAlarm();
	closeWebSockets(m.ctx);
	return { statements: out, cursor: null };
}

function assertClean(m: MigratorState, sql: SqlStorage, cursor: Cursor): void {
	if (cursor.instanceId !== m.instanceId) {
		throw new MigratorError(409, "migrator.dirty", "the Durable Object restarted during the export");
	}
	if (totalChanges(sql) !== cursor.startChanges) {
		throw new MigratorError(409, "migrator.dirty", "the Durable Object was written to during the export");
	}
	if (schemaFingerprint(sql) !== cursor.schema) {
		throw new MigratorError(409, "migrator.dirty", "the schema changed during the export");
	}
}

function listTables(sql: SqlStorage): TableInfo[] {
	const list = sql.exec<{ schema: string; name: string; type: string; wr: number }>(`PRAGMA table_list`).toArray();
	const byName = new Map(list.filter((t) => t.schema === "main").map((t) => [t.name, t]));
	for (const t of byName.values()) {
		if (t.type === "virtual" && isUserObject(t.name)) {
			throw new MigratorError(
				501,
				"migrator.unsupported",
				`virtual table "${t.name}" (for example FTS5) cannot be exported yet`,
			);
		}
	}
	const master = sql
		.exec<{ name: string; sql: string }>(
			`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL ORDER BY rowid`,
		)
		.toArray();
	return master
		.filter((t) => isUserObject(t.name) && byName.get(t.name)?.type === "table")
		.map((t) => ({ name: t.name, sql: t.sql, withoutRowid: byName.get(t.name)?.wr === 1 }));
}

function readRows(
	sql: SqlStorage,
	table: TableInfo,
	after: string[] | null,
	budget: number,
): { statements: string[]; lastKey: string[] | null; done: boolean } {
	const info = sql
		.exec<{ name: string; type: string; pk: number; hidden: number }>(`PRAGMA table_xinfo(${ident(table.name)})`)
		.toArray();
	const columns = info.filter((c) => c.hidden === 0).map((c) => c.name);
	const pk = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);

	let keyColumns: string[];
	let insertColumns = columns;
	if (table.withoutRowid) {
		keyColumns = pk.map((c) => c.name);
	} else {
		const rowidName = ["rowid", "_rowid_", "oid"].find((n) => !info.some((c) => c.name.toLowerCase() === n));
		if (!rowidName) {
			throw new MigratorError(501, "migrator.unsupported", `table "${table.name}" hides its rowid behind column names`);
		}
		keyColumns = [rowidName];
		// Without an INTEGER PRIMARY KEY, SQLite would renumber rowids on import.
		const pkIsRowid = pk.length === 1 && pk[0]!.type.toUpperCase() === "INTEGER";
		if (!pkIsRowid) insertColumns = [rowidName, ...columns];
	}

	const keySelect = keyColumns.map((c) => `quote(${ident(c)})`).join(", ");
	// quote() keeps numbers exact. Text and blobs come back raw and are encoded
	// in JS, because quote() on a value near the 2 MB limit fails with SQLITE_TOOBIG.
	const valueSelect = insertColumns
		.map(
			(c) =>
				`typeof(${ident(c)}), CASE WHEN typeof(${ident(c)}) IN ('text', 'blob') THEN ${ident(c)} ELSE quote(${ident(c)}) END`,
		)
		.join(", ");
	const orderBy = keyColumns.map(ident).join(", ");
	const insertHead = `INSERT INTO ${ident(table.name)}(${insertColumns.map(ident).join(", ")}) VALUES (`;

	const statements: string[] = [];
	let used = 0;
	let lastKey = after;
	while (used < budget || statements.length === 0) {
		const where = lastKey ? `WHERE (${orderBy}) > (${lastKey.map(assertLiteral).join(", ")})` : "";
		const rows = [
			...sql
				.exec(
					`SELECT ${keySelect}, ${valueSelect} FROM ${ident(table.name)} ${where} ORDER BY ${orderBy} LIMIT ${ROWS_PER_QUERY}`,
				)
				.raw(),
		];
		for (const row of rows) {
			const values: string[] = [];
			for (let i = keyColumns.length; i < row.length; i += 2) values.push(sqlLiteral(row[i] as string, row[i + 1]!));
			const stmt = `${insertHead}${values.join(", ")});`;
			statements.push(stmt);
			used += stmt.length;
			lastKey = row.slice(0, keyColumns.length) as string[];
			if (used >= budget) return { statements, lastKey, done: false };
		}
		if (rows.length < ROWS_PER_QUERY) return { statements, lastKey, done: true };
	}
	return { statements, lastKey, done: false };
}

function tailStatements(sql: SqlStorage, tables: TableInfo[], m: MigratorState, alarm: number | null): string[] {
	const out: string[] = [];
	const exported = new Set(tables.map((t) => t.name));

	const hasSequence = [...sql.exec(`SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'`)].length > 0;
	if (hasSequence) {
		for (const [name, seq] of sql.exec(`SELECT name, quote(seq) FROM sqlite_sequence`).raw()) {
			if (!exported.has(name as string)) continue;
			out.push(`DELETE FROM sqlite_sequence WHERE name = ${sqlString(name as string)};`);
			out.push(`INSERT INTO sqlite_sequence(name, seq) VALUES (${sqlString(name as string)}, ${seq});`);
		}
	}

	out.push(
		`INSERT INTO "${META_TABLE}"(key, value) VALUES ('id', ${sqlString(m.ctx.id.toString())}), ('name', ${
			m.name === null ? "NULL" : sqlString(m.name)
		}), ('alarm', ${alarm === null ? "NULL" : String(alarm)});`,
	);

	// Indexes, triggers and views go last so the inserts stay fast and
	// triggers do not fire during the import.
	const objects = sql
		.exec<{ name: string; tbl_name: string; sql: string }>(
			`SELECT name, tbl_name, sql FROM sqlite_master WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL ORDER BY rowid`,
		)
		.toArray();
	for (const o of objects) {
		if (!isUserObject(o.name) || !isUserObject(o.tbl_name)) continue;
		out.push(`${o.sql};`);
	}
	return out;
}

function isUserObject(name: string): boolean {
	const lower = name.toLowerCase();
	return (
		!lower.startsWith("_cf_") &&
		!lower.startsWith("sqlite_") &&
		name !== STATE_TABLE &&
		name !== KV_TABLE &&
		name !== META_TABLE
	);
}

function totalChanges(sql: SqlStorage): number {
	return sql.exec<{ n: number }>(`SELECT total_changes() AS n`).one().n;
}

// `total_changes()` does not count schema changes, so the schema is compared too.
function schemaFingerprint(sql: SqlStorage): number {
	let hash = 0x811c9dc5;
	for (const [name, text] of sql.exec(`SELECT name, sql FROM sqlite_master ORDER BY rowid`).raw()) {
		if (!isUserObject(name as string)) continue;
		for (const ch of `${name}\u0000${text ?? ""}\u0000`) {
			hash ^= ch.charCodeAt(0);
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
	}
	return hash;
}

// KV values can be any structured-clone value. JSON would turn a Date into a
// string, drop a Map's entries, and throw on a BigInt. devalue keeps the types,
// so `devalue.parse` on the new server gives back exactly what was stored.
function encodeKvValue(key: string, value: unknown): string {
	try {
		return stringify(value);
	} catch (err) {
		throw new MigratorError(
			501,
			"migrator.unsupported",
			`KV value for key "${key}" cannot be exported: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function closeWebSockets(ctx: DurableObjectState): void {
	for (const ws of ctx.getWebSockets()) {
		try {
			ws.close(1012, "migrator.moved");
		} catch {
			// Already closed.
		}
	}
}

// Helpers
// =======================================================================================

// Every literal that comes back in a cursor must look like `quote()` output,
// so a cursor can never inject SQL.
const LITERAL = /^(?:NULL|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|'(?:[^']|'')*'|X'[0-9A-Fa-f]*')$/;

function assertLiteral(value: string): string {
	if (!LITERAL.test(value)) throw new MigratorError(400, "migrator.bad_request", "invalid export cursor");
	return value;
}

function encodeCursor(cursor: Cursor): string {
	return JSON.stringify(cursor);
}

function decodeCursor(value: string): Cursor {
	try {
		return JSON.parse(value) as Cursor;
	} catch {
		throw new MigratorError(400, "migrator.bad_request", "invalid export cursor");
	}
}

function sqlLiteral(type: string, value: SqlStorageValue): string {
	if (type === "text") return sqlString(value as string);
	if (type === "blob") return `X'${hex(new Uint8Array(value as ArrayBuffer))}'`;
	return value as string;
}

function hex(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]!];
	return out;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0").toUpperCase());

function ident(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

function sqlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function sqlOrNull(ctx: DurableObjectState): SqlStorage | null {
	try {
		return ctx.storage.sql;
	} catch {
		return null;
	}
}

function rpcMethodNames(Base: DurableObjectClass): string[] {
	const names = new Set<string>();
	for (let proto = Base.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
		// Stop at Cloudflare's `DurableObject` base class.
		if (proto.constructor?.name === "DurableObject") break;
		for (const name of Object.getOwnPropertyNames(proto)) {
			if (HANDLER_NAMES.has(name)) continue;
			const desc = Object.getOwnPropertyDescriptor(proto, name);
			if (desc && typeof desc.value === "function") names.add(name);
		}
	}
	return [...names];
}

const encoder = new TextEncoder();

function tokenMatches(req: Request, token: string): boolean {
	const got = encoder.encode(req.headers.get("authorization") ?? "");
	const want = encoder.encode(`Bearer ${token}`);
	if (got.byteLength !== want.byteLength) return false;
	return crypto.subtle.timingSafeEqual(got, want);
}

function jsonResponse(body: unknown): Response {
	return Response.json(body, { headers: { [MIGRATOR_HEADER]: "1" } });
}

function errorResponse(status: number, code: string, message: string): Response {
	return Response.json({ error: { code, message } }, { status, headers: { [MIGRATOR_HEADER]: "1" } });
}

function movedResponse(): Response {
	return errorResponse(503, "migrator.moved", "this Durable Object was migrated to a new server");
}
