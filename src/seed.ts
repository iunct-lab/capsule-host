import { emptyTrip } from "./template";
import { validate } from "./schema";
const seed = emptyTrip(process.env.CAPSULE_TRIP_START ?? new Date().toISOString().slice(0, 10));
console.log(JSON.stringify({ schemaVersion: 1, ...validate(seed.spec, seed.document, Date.now()) }, null, 2));
