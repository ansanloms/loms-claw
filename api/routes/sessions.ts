/**
 * sessions ルート。
 *
 * 対象のチャンネル / スレッドのセッションへ依頼 (プロンプト) を渡し、そのスコープの
 * キューに積む。処理の完了は待たず、受け付けた時点で 202 を返す。
 */

import { type Context, Hono } from "hono";
import type { FromSchema } from "json-schema-to-ts";
import { createLogger } from "../../logger.ts";
import type { internalSchemas } from "../internal-schemas.ts";
import { matchesSchema, schemaErrorOf } from "../validate.ts";

const log = createLogger("api-sessions");

/** 依頼の対象。`threadId` があればそのスレッド、無ければ `channelId` のチャンネル。 */
export interface SessionTarget {
  channelId: string;
  threadId?: string;
}

/** {@link SessionsRouteContext.submitMessage} の結果。 */
export type SessionSubmitResult =
  | "accepted"
  | "not-found"
  | "rate-limited"
  | "unavailable";

/** Discord の Snowflake (数字 17〜20 桁)。これ以外の ID は `channels.fetch` に渡さない。 */
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * sessions ルートに注入する依存関係。
 */
export interface SessionsRouteContext {
  /**
   * 依頼を対象スコープのキューに積む。
   * - `accepted`: 積んだ (処理の完了は待たない)。
   * - `not-found`: 対象が存在しない・ギルド外・送信できない種別・親子の不一致。
   * - `rate-limited`: 依頼のレート制限の超過。
   * - `unavailable`: 終了処理中で受け付けられない。
   */
  submitMessage: (
    target: SessionTarget,
    prompt: string,
    source?: string,
  ) => Promise<SessionSubmitResult>;
}

/** request body が RequestPostSessionMessage スキーマに適合するかの型ガード。 */
function isSessionMessageBody(
  value: unknown,
): value is FromSchema<(typeof internalSchemas)["RequestPostSessionMessage"]> {
  return matchesSchema("RequestPostSessionMessage", value);
}

/**
 * sessions ルートを生成する。
 *
 * @param ctx - 依存関係コンテキスト。未注入なら全ルートが 503。
 */
export function createSessionsRoutes(ctx?: SessionsRouteContext) {
  const app = new Hono();

  const handle = async (
    c: Context,
    target: SessionTarget,
  ): Promise<Response> => {
    if (!ctx) {
      return c.json({ error: "sessions not available" }, 503);
    }
    if (
      !SNOWFLAKE.test(target.channelId) ||
      (target.threadId !== undefined && !SNOWFLAKE.test(target.threadId))
    ) {
      return c.json(
        { error: "channelId and threadId must be 17-20 digit snowflakes" },
        400,
      );
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (!isSessionMessageBody(body)) {
      return c.json(
        { error: schemaErrorOf("RequestPostSessionMessage", body) },
        400,
      );
    }
    const result = await ctx.submitMessage(target, body.prompt, body.source);
    if (result === "not-found") {
      return c.json({ error: "channel or thread not found" }, 404);
    }
    if (result === "unavailable") {
      return c.json({ error: "sessions not available (shutting down)" }, 503);
    }
    if (result === "rate-limited") {
      return c.json({ error: "session request rate limit exceeded" }, 429);
    }
    log.debug(
      `session request accepted: ${target.threadId ?? target.channelId}`,
    );
    return c.json({ ok: true }, 202);
  };

  app.post("/:channelId/messages", (c) =>
    handle(c, { channelId: c.req.param("channelId") }),
  );

  app.post("/:channelId/:threadId/messages", (c) =>
    handle(c, {
      channelId: c.req.param("channelId"),
      threadId: c.req.param("threadId"),
    }),
  );

  return app;
}
