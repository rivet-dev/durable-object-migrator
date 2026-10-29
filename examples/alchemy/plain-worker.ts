// A plain-class Durable Object. It needs only src/worker.ts.
import { DurableObject } from "cloudflare:workers";
import { migratable, migrationRoute } from "../../src/worker.ts";

type Env = {
	ROOMS: DurableObjectNamespace<RoomImpl>;
	WORKER_MIGRATOR_TOKEN: string;
};

class RoomImpl extends DurableObject<Env> {
	async addMessage(text: string): Promise<void> {
		this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, text TEXT)`);
		this.ctx.storage.sql.exec(`INSERT INTO messages(text) VALUES (?)`, text);
	}
}

export const Room = migratable(RoomImpl);

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const migration = migrationRoute(req, env, { token: env.WORKER_MIGRATOR_TOKEN });
		if (migration) return migration;

		const name = new URL(req.url).searchParams.get("room") ?? "lobby";
		await env.ROOMS.getByName(name).addMessage(await req.text());
		return new Response("sent");
	},
};
