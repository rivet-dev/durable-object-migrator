// Starts the actors from registry.ts. In development this also starts a local
// Rivet Engine at http://127.0.0.1:6420.
//
//   WORKER_URL=... WORKER_MIGRATOR_TOKEN=... node --experimental-transform-types server.ts

import { registry } from "./registry.ts";

registry.start();
