import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Les tests vident les tables : ils tournent sur une base dédiée (TEST_DATABASE_URL),
// jamais sur la base de développement.
const envFile = resolve(import.meta.dirname, "../../../../.env");
if (!process.env.TEST_DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error("TEST_DATABASE_URL manquant (voir .env.example)");
if (!new URL(testUrl).pathname.endsWith("_test")) {
  throw new Error(`TEST_DATABASE_URL doit viser une base dont le nom finit par _test : ${testUrl}`);
}
process.env.DATABASE_URL = testUrl;
