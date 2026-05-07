import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { registerCompareRoutes } from "./routes/compare.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerOpponentRoutes } from "./routes/opponents.js";
import { registerSearchRoutes } from "./routes/search.js";
import { getEnv } from "./env.js";

export async function buildServer() {
  const app = Fastify({ logger: true });
  registerCors(app);
  await registerHealthRoutes(app);
  await registerSearchRoutes(app);
  await registerOpponentRoutes(app);
  await registerCompareRoutes(app);
  return app;
}

function registerCors(app: FastifyInstance) {
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
    reply.header("Access-Control-Max-Age", "86400");
  });

  app.options("/*", async (_request, reply) => reply.code(204).send());
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  const env = getEnv();
  const app = await buildServer();
  await app.listen({ port: env.port, host: "0.0.0.0" });
}
