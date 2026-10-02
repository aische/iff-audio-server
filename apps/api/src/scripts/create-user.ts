import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import { eq } from "drizzle-orm";
import { createDb, users } from "@iff/db";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
dotenv.config({ path: path.join(root, ".env") });

const args = process.argv.slice(2);
const reset = args.includes("--reset");
const positional = args.filter((arg) => arg !== "--reset");
const email = positional[0]?.trim().toLowerCase();
const password = positional[1];

if (!email || !password || positional.length !== 2) {
  console.error(
    "Usage: npm run create-user -w api -- email@example.com password [--reset]",
  );
  process.exit(1);
}
if (password.length < 8) {
  console.error("Password must be at least 8 characters");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const db = createDb(process.env.DATABASE_URL);

const [existing] = await db
  .select()
  .from(users)
  .where(eq(users.email, email))
  .limit(1);

if (reset) {
  if (!existing) {
    console.error("No such user:", email);
    process.exit(1);
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const [user] = await db
    .update(users)
    .set({ passwordHash })
    .where(eq(users.id, existing.id))
    .returning({ id: users.id, email: users.email });
  console.log("Reset password for user:", user);
  process.exit(0);
}

if (existing) {
  console.error("User already exists:", email);
  process.exit(1);
}

const passwordHash = await bcrypt.hash(password, 12);
const [user] = await db
  .insert(users)
  .values({ email, passwordHash })
  .returning({ id: users.id, email: users.email });

console.log("Created user:", user);
process.exit(0);
