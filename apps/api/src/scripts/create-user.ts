import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
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

if (!email || positional.length !== 1) {
  console.error(
    "Usage: npm run create-user -w api -- email@example.com [--reset]\n" +
      "Prompts for the password, or reads it as the first line of stdin.",
  );
  process.exit(1);
}

/** Password from a hidden prompt (TTY) or the first line of stdin, never argv. */
async function readPassword(): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    const rl = createInterface({ input });
    for await (const line of rl) {
      rl.close();
      return line;
    }
    return "";
  }

  const rl = createInterface({ input, output: process.stdout, terminal: true });
  const ask = (prompt: string) =>
    new Promise<string>((resolve) => {
      process.stdout.write(prompt);
      // Echo nothing while typing.
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput =
        () => {};
      rl.question("", (answer) => {
        process.stdout.write("\n");
        resolve(answer);
      });
    });
  const first = await ask("Password: ");
  const second = await ask("Repeat password: ");
  rl.close();
  if (first !== second) {
    console.error("Passwords do not match");
    process.exit(1);
  }
  return first;
}

const password = await readPassword();
if (!password) {
  console.error("Password required");
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
