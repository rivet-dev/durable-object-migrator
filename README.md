<h1 align="center">Durable Object Migrator</h1>

<p align="center">Move Cloudflare Durable Objects to your own server with no downtime and no lost writes.</p>

<p align="center">
  <a href="docs/guide.md">Guide</a> ·
  <a href="examples/">Examples</a> ·
  <a href="https://rivet.dev/discord">Discord</a>
</p>

## What it does

Cloudflare has no way to export a Durable Object's data. This repo adds an export route to your Worker, then copies each Durable Object to your new server in three steps:

1. **Wrap.** Add 2 lines to your Worker.
2. **Copy on first use.** Point your domain at the new server. Each Durable Object is copied the first time a request needs it.
3. **Backfill.** A background job copies every Durable Object that got no requests. If it stops, it picks up where it left off.

Works with SQLite-backed Durable Objects (`new_sqlite_classes` in your wrangler config). Older KV-backed ones are not supported.

> [!NOTE]
> Your app keeps running during a copy. If a Durable Object is written to while it is being copied, the copy is thrown away and runs again. After a clean copy, the old Durable Object refuses requests, so no write can land on it by mistake. Nothing on Cloudflare is ever deleted.

## Getting started

This is a repo, not a package. Copy two files:

| File | Goes in | Does |
|---|---|---|
| [`src/worker.ts`](src/worker.ts) | Your Cloudflare Worker | Adds the export route, and blocks a Durable Object once it is copied |
| [`src/client.ts`](src/client.ts) | Your new server | Copies each Durable Object's data, and finds the ones nobody used |

**Worker:**

```ts
import { migratable, migrationRoute } from "./migrator"; // src/worker.ts

export const Room = migratable(RoomImpl); // wraps your Durable Object class

export default {
  fetch: (req, env, ctx) =>
    migrationRoute(req, env, { token: env.WORKER_MIGRATOR_TOKEN }) ?? app.fetch(req, env, ctx),
};
```

Set `WORKER_MIGRATOR_TOKEN` with `wrangler secret put` and deploy. Nothing changes for your users yet.

**New server:**

```ts
import { createClient } from "./migrator-client"; // src/client.ts

// Use your workers.dev URL. Your domain will point at the new server.
const migrator = createClient({ workerUrl: "https://my-app.workers.dev", token });

// You write this. It must be safe to call more than once.
async function migrate({ id }) {
  if (await isDone(id)) return;
  await clearDestination(id);
  for await (const page of migrator.exportObject({ binding: "ROOMS", id })) {
    await destination(id).exec(page.sql);
  }
  await markDone(id);
}
```

Call `migrate` before you handle a request for that Durable Object. Run `migrator.backfill({ ..., migrate })` to copy the rest. The [guide](docs/guide.md) covers the full switch-over and how to roll back.

## API

| Where | API | Does |
|---|---|---|
| Worker | `migratable(DOClass)` | Wraps your Durable Object class. Adds the export, and blocks requests once it is copied. |
| Worker | `migrationRoute(req, env, { token })` | Handles the migrator's requests (`/__migrate/*`). Returns `null` for everything else, so your app handles it. |
| Server | `createClient({ workerUrl, token })` | Connects to your Worker |
| Server | `migrator.exportObject({ binding, id })` | Returns the Durable Object's data as SQL, one page at a time. Throws `MigrationDirtyError` if it was written to during the copy. |
| Server | `migrator.resolve(binding, { name } \| { id })` | Converts a name to an id, or an id to its name |
| Server | `migrator.backfill({ cloudflare, startAt, updateStartAt, migrate, concurrency?, retries?, signal? })` | Calls `migrate` for every Durable Object on Cloudflare, 8 at a time. Saves its place so it can resume. Returns `{ done, failed }`. |

| Worker env var | Does |
|---|---|
| `WORKER_MIGRATOR_TOKEN` | Required. A secret your Worker and your new server share. |
| `MIGRATOR_DISABLED` | Set to `true` to roll back. Every Durable Object serves requests again. |

## Resources

- [Guide](docs/guide.md): how to switch over, how to roll back, and what is not supported.
- [Examples](examples/): copy into a `.sqlite` file, track progress in Postgres, copy into Rivet Actors.
- [Migration skill](skills/durable-object-migrator/SKILL.md): give it to your coding agent to set this up in your project.
- [Discord](https://rivet.dev/discord): questions and support.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) to run the tests and the check against a real Cloudflare account.

## License

Apache 2.0
