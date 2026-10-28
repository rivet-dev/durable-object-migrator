// Reads a SQLite database the same way on both sides (Durable Object and the
// exported copy), so a test can compare the two.

export type Query = (sql: string) => unknown[][];

export type Snapshot = {
	tables: Record<string, { sql: string; rows: string[][] }>;
	objects: string[];
	sequences: unknown[][];
};

const INTERNAL = new Set(["__migrator", "__do_kv", "__do_meta"]);

export function isUserTable(name: string): boolean {
	const lower = name.toLowerCase();
	return !lower.startsWith("_cf_") && !lower.startsWith("sqlite_") && !INTERNAL.has(name);
}

export function snapshot(query: Query): Snapshot {
	const ident = (n: string) => `"${n.replace(/"/g, '""')}"`;
	const list = query(`PRAGMA table_list`).filter((r) => r[0] === "main");
	const withoutRowid = new Set(list.filter((r) => r[4] === 1).map((r) => r[1] as string));

	const tables: Snapshot["tables"] = {};
	for (const [name, sql] of query(`SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name`)) {
		if (!isUserTable(name as string)) continue;
		// cid, name, type, notnull, dflt_value, pk, hidden
		const info = query(`PRAGMA table_xinfo(${ident(name as string)})`);
		const cols = info
			.filter((c) => c[6] !== 1)
			.map((c) => ident(c[1] as string))
			.map((c) => `typeof(${c}), CASE WHEN typeof(${c}) IN ('text', 'blob', 'real') THEN ${c} ELSE quote(${c}) END`);
		const pk = info.filter((c) => (c[5] as number) > 0).sort((a, b) => (a[5] as number) - (b[5] as number));
		const select = withoutRowid.has(name as string)
			? `SELECT ${cols.join(", ")} FROM ${ident(name as string)} ORDER BY ${pk.map((c) => ident(c[1] as string)).join(", ")}`
			: `SELECT 'rowid', quote(rowid), ${cols.join(", ")} FROM ${ident(name as string)} ORDER BY rowid`;
		tables[name as string] = { sql: sql as string, rows: query(select).map(formatRow) };
	}

	const objects = query(
		`SELECT sql FROM sqlite_master WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL ORDER BY name`,
	).map((r) => r[0] as string);

	const hasSequence = query(`SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'`).length > 0;
	const sequences = hasSequence
		? query(`SELECT name, quote(seq) FROM sqlite_sequence ORDER BY name`).filter((r) => isUserTable(r[0] as string))
		: [];

	return { tables, objects, sequences };
}

// Each cell arrives as a (type, value) pair. Integers are quote() literals so
// they stay exact. Reals are raw, because SQLite versions print the same double
// differently. Text and blobs are raw.
function formatRow(row: unknown[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < row.length; i += 2) {
		const [type, value] = [row[i], row[i + 1]];
		if (type === "text") out.push(`text:${value}`);
		else if (type === "blob") out.push(`blob:${toHex(value)}`);
		else if (type === "real") out.push(`real:${Object.is(value, -0) ? "-0" : String(value)}`);
		else out.push(`${type}:${value}`);
	}
	return out;
}

function toHex(value: unknown): string {
	const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : (value as Uint8Array);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
