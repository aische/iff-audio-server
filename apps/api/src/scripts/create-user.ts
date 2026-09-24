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

const email = process.argv[2]?.trim().toLowerCase();
const password = process.argv[3];

if (!email || !password) {
  console.error(
    "Usage: npm run create-user -w api -- email@example.com password",
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
