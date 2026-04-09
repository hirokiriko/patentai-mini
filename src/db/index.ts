import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

const db = drizzle({
  connection: {
    url: process.env.DATABASE_URL ?? "file:./data/app.db",
  },
  schema,
});

export { db };
