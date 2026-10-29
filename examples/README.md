# Examples

Each example imports `@rivet-dev/durable-object-migrator`, linked to the source in this repo. In your project, install it from npm.

| Example | Shows |
|---|---|
| [`export-to-sqlite/`](export-to-sqlite/export.ts) | Move one Durable Object into a local `.sqlite` file |
| [`postgres/`](postgres/migrate.ts) | Postgres holds the done list, a lock per Durable Object, and the backfill position. Data goes to `.sqlite` files. |
| [`alchemy/`](alchemy/alchemy.run.ts) | An Alchemy v2 stack with both kinds of Durable Object: a plain class ([`plain-worker.ts`](alchemy/plain-worker.ts)) and an Effect-native one ([`Chat.ts`](alchemy/Chat.ts)) |
| [`rivet/`](rivet/registry.ts) | Each Durable Object becomes a Rivet Actor with the same name. The actor imports its data in `onMigrate`. [`server.ts`](rivet/server.ts) starts the actors. [`backfill.ts`](rivet/backfill.ts) wakes the rest. |

Translating SQLite SQL into Postgres tables is not included. The export is SQLite SQL.
