import { prisma } from "@hub/db";
import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";
import { createSmtpMailer } from "./lib/mailer.js";
import { S3Storage } from "./lib/storage.js";

const env = loadEnv();
const storage = new S3Storage(env);
const app = buildApp(env, { prisma, mailer: createSmtpMailer(env), storage });

storage
  .ensureBucket()
  .catch((err) => app.log.warn(err, `bucket S3 « ${env.S3_BUCKET} » inaccessible : les photos ne fonctionneront pas`))
  .finally(() =>
    app.listen({ port: env.API_PORT, host: "0.0.0.0" }).catch((err) => {
      app.log.error(err);
      process.exit(1);
    }),
  );
