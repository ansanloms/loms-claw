/**
 * ログ取得 API ルート。
 *
 * メモリ上のリングバッファからログエントリを取得する。
 * `claude -p` から `curl http://127.0.0.1:{port}/logs` で参照可能。
 */

import { Hono } from "hono";
import { getLogEntries, type LogFilter, type LogLevel } from "../../logger.ts";

const VALID_LEVELS = new Set<string>(["DEBUG", "INFO", "WARN", "ERROR"]);

/**
 * ログ取得ルートを生成する。
 */
export function createLogsRoutes() {
  const app = new Hono();

  // GET /
  app.get("/", (c) => {
    const levelParam = c.req.query("level")?.toUpperCase();
    const namespace = c.req.query("namespace");
    const since = c.req.query("since");
    const limitParam = c.req.query("limit");

    const filter: LogFilter = {};

    if (levelParam) {
      if (!VALID_LEVELS.has(levelParam)) {
        return c.json(
          {
            error:
              `invalid level: ${levelParam}. valid: DEBUG, INFO, WARN, ERROR`,
          },
          400,
        );
      }
      filter.level = levelParam as LogLevel;
    }

    if (namespace) {
      filter.namespace = namespace;
    }

    if (since) {
      try {
        Temporal.Instant.from(since);
        filter.since = since;
      } catch {
        return c.json({ error: "invalid since: must be ISO 8601" }, 400);
      }
    }

    if (limitParam) {
      const n = Number(limitParam);
      if (!Number.isInteger(n) || n < 1) {
        return c.json({ error: "limit must be a positive integer" }, 400);
      }
      filter.limit = n;
    }

    const entries = getLogEntries(filter);
    return c.json(entries);
  });

  return app;
}
