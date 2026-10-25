import { createDb } from "./client";

const h = createDb();
await h.migrate();
console.log(`migrations applied (${h.driver})`);
await h.close();
