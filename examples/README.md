# Examples

Each example imports `src/client.ts` from this repo. In your project, copy `src/client.ts` next to your code instead.

| Example | Shows |
|---|---|
| [`export-to-sqlite/`](export-to-sqlite/export.ts) | Move one Durable Object into a local `.sqlite` file |
| [`postgres/`](postgres/migrate.ts) | Postgres holds the done list, a lock per Durable Object, and the backfill position. Data goes to `.sqlite` files. |
| [`rivet/`](rivet/registry.ts) | Each Durable Object becomes a Rivet Actor with the same name. The actor imports its data in `onMigrate`. [`server.ts`](rivet/server.ts) starts the actors. [`backfill.ts`](rivet/backfill.ts) wakes the rest. |

Translating SQLite SQL into Postgres tables is not included. The export is SQLite SQL.
