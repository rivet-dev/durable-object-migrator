import { DurableObject } from "cloudflare:workers";
import { stringify } from "devalue";
import { migratable, migrationRoute } from "../../src/worker";
import { snapshot } from "./snapshot";

interface Env {
	ROOMS: DurableObjectNamespace<RoomImpl>;
	WORKER_MIGRATOR_TOKEN: string;
}

const ALARM_AT = Date.UTC(2099, 0, 1);

class RoomImpl extends DurableObject<Env> {
	release?: () => void;

	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const sql = this.ctx.storage.sql;
		switch (url.pathname) {
			case "/seed":
				await this.seed(url.searchParams.get("big") === "1");
				return new Response("ok");
			case "/write":
				sql.exec(`INSERT INTO notes(body) VALUES (?)`, url.searchParams.get("body") ?? "late write");
				return new Response("ok");
			case "/kv-put":
				await this.ctx.storage.put("late", { at: new Date(1) });
				return new Response("ok");
			case "/ping":
				return new Response("pong");
			case "/late-write":
				// Answers now and writes later, once /release is called.
				this.ctx.waitUntil(
					new Promise<void>((resolve) => {
						this.release = resolve;
					}).then(() => {
						sql.exec(`INSERT INTO notes(body) VALUES ('late write')`);
					}),
				);
				return new Response("ok");
			case "/schedule":
				await this.ctx.storage.setAlarm(Date.now() + Number(url.searchParams.get("in") ?? 0));
				return new Response("ok");
			case "/release":
				this.release?.();
				return new Response("ok");
			case "/snapshot": {
				const kv = [...(await this.ctx.storage.list())].map(([k, v]) => [k, stringify(v)]);
				return Response.json({
					...snapshot((q) => [...sql.exec(q).raw()]),
					kv,
					alarm: await this.ctx.storage.getAlarm(),
				});
			}
			default:
				return new Response("not found", { status: 404 });
		}
	}

	async addNote(body: string): Promise<string> {
		this.ctx.storage.sql.exec(`INSERT INTO notes(body) VALUES (?)`, body);
		return "ok";
	}

	async alarm(): Promise<void> {
		this.ctx.storage.sql.exec(`INSERT INTO notes(body) VALUES ('alarm ran')`);
	}

	async seed(big: boolean): Promise<void> {
		const sql = this.ctx.storage.sql;
		sql.exec(`CREATE TABLE notes(id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT, n INTEGER, r REAL, b BLOB)`);
		sql.exec(`INSERT INTO notes(body, n, r, b) VALUES
			('it''s ünïcödé 🎉', 9007199254740993, 5.0, x'00ff'),
			(NULL, -9223372036854775808, 0.1 + 0.2, NULL),
			('deleted', 0, 1e308, x''),
			('negative zero', 1, -0.0, zeroblob(3))`);
		// Leaves the AUTOINCREMENT sequence above the highest id.
		sql.exec(`DELETE FROM notes WHERE body = 'deleted'`);

		// No INTEGER PRIMARY KEY, so rowids must survive the copy as-is.
		sql.exec(`CREATE TABLE loose(a TEXT, b INTEGER)`);
		sql.exec(`INSERT INTO loose VALUES ('one', 1), ('two', 2), ('three', 3)`);
		sql.exec(`DELETE FROM loose WHERE b = 2`);

		// Composite key and more rows than one query reads.
		sql.exec(`CREATE TABLE pairs(k TEXT, n INTEGER, v TEXT, PRIMARY KEY (k, n)) WITHOUT ROWID`);
		sql.exec(`WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 1200)
			INSERT INTO pairs SELECT 'k' || (i % 7), i, 'v' || i FROM c`);

		// The child table comes before its parent, so rows arrive child first.
		sql.exec(`CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id))`);
		sql.exec(`CREATE TABLE parent(id INTEGER PRIMARY KEY, label TEXT)`);
		sql.exec(`INSERT INTO parent VALUES (1, 'p')`);
		sql.exec(`INSERT INTO child VALUES (1, 1)`);

		sql.exec(`CREATE TABLE gen(a INTEGER, doubled INTEGER GENERATED ALWAYS AS (a * 2) STORED)`);
		sql.exec(`INSERT INTO gen(a) VALUES (21)`);

		if (big) {
			// Rows close to Cloudflare's 2 MB limit force the export over several pages.
			sql.exec(`CREATE TABLE files(id INTEGER PRIMARY KEY, data BLOB)`);
			for (let i = 0; i < 4; i++) sql.exec(`INSERT INTO files(data) VALUES (randomblob(1500000))`);
		}

		sql.exec(`CREATE INDEX notes_body ON notes(body)`);
		sql.exec(
			`CREATE TRIGGER notes_audit AFTER INSERT ON notes BEGIN INSERT INTO loose(a, b) VALUES ('audit', NEW.id); END`,
		);
		sql.exec(`CREATE VIEW note_bodies AS SELECT body FROM notes`);

		await this.ctx.storage.put("config", {
			theme: "dark",
			at: new Date(0),
			tags: new Map([["a", 1]]),
			bytes: new Uint8Array([0, 255]),
			big: 10n,
		});
		await this.ctx.storage.put("a-key", "plain");
		await this.ctx.storage.setAlarm(ALARM_AT);
	}
}

export const Room = migratable(RoomImpl);

export const KvRoom = migratable(class extends DurableObject<Env> {});

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const migration = migrationRoute(req, env, { token: env.WORKER_MIGRATOR_TOKEN });
		if (migration) return migration;

		// /app/:name/:action
		const [, app, name, action, ...rest] = new URL(req.url).pathname.split("/");
		if (app !== "app" || !name || !action) return new Response("not found", { status: 404 });
		const stub = env.ROOMS.get(env.ROOMS.idFromName(name));

		if (action === "rpc-note") {
			try {
				return new Response(await stub.addNote("from rpc"));
			} catch (err) {
				return new Response(String(err), { status: 500 });
			}
		}
		// Forwards any path to the Durable Object, the way many apps do.
		if (action === "forward") {
			const url = new URL(req.url);
			url.pathname = `/${rest.join("/")}`;
			return stub.fetch(new Request(url, req));
		}
		const url = new URL(req.url);
		url.pathname = `/${action}`;
		return stub.fetch(new Request(url, req));
	},
};
