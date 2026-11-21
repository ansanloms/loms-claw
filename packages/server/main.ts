import { serve } from "@hono/node-server";
import { createApp } from "./api/app.ts";

const server = serve({
  fetch: createApp().fetch,
  port: 3000,
  hostname: "127.0.0.1",
});

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
