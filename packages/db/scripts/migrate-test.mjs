// Applique les migrations sur la base de test (TEST_DATABASE_URL). Prisma la crée si besoin.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envFile = resolve(import.meta.dirname, "../../../.env");
if (!process.env.TEST_DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) {
  console.error("TEST_DATABASE_URL manquant ou ne visant pas une base *_test");
  process.exit(1);
}

const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  env: { ...process.env, DATABASE_URL: url },
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
