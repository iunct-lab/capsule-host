import { z } from "zod";
import { specSchema, documentSchema } from "./schema";

// Portable structural schema; cross-field checks still run in validate() at publication and updates.
export const tripSchema = z.object({ schemaVersion: z.literal(1).optional(), spec: specSchema, document: documentSchema }).strict();
// The schema is also what the assistant is asked to answer in (src/assist.ts); only the CLI prints it.
if (import.meta.main) console.log(JSON.stringify(z.toJSONSchema(tripSchema, { target: "draft-7" }), null, 2));
