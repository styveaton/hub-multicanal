import { prisma } from "@hub/db";
import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";
import { createSmtpMailer } from "./lib/mailer.js";

const env = loadEnv();
const app = buildApp(env, { prisma, mailer: createSmtpMailer(env) });

app.listen({ port: env.API_PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
