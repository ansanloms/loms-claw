/**
 * 統合 HTTP サーバー。
 *
 * 承認フック（PreToolUse）と Discord REST API を
 * 単一の Deno.serve() インスタンスで提供する。
 */

import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { ApprovalManager, ApprovalResult } from "../approval/manager.ts";
import type { ApiContext } from "./types.ts";
import {
  addReaction,
  getChannelInfo,
  getGuildMembers,
  getMessage,
  listChannels,
  searchMessages,
  sendMessage,
} from "./discord.ts";
import { type CronApiContext, cronRoutes } from "./cron.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("api-server");

/**
 * ApprovalResult を PreToolUse フックの出力 JSON に変換する。
 */
function toHookOutput(result: ApprovalResult) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: result.decision,
      ...(result.reason ? { permissionDecisionReason: result.reason } : {}),
    },
  };
}

// Discord API ルーティング用の URLPattern 定義。
const routes: {
  pattern: URLPattern;
  method: string;
  handler: (
    req: Request,
    ctx: ApiContext,
    params: Record<string, string>,
  ) => Promise<Response>;
}[] = [
  {
    pattern: new URLPattern({ pathname: "/discord/channels" }),
    method: "GET",
    handler: (req, ctx) => listChannels(req, ctx),
  },
  {
    pattern: new URLPattern({ pathname: "/discord/channels/:id" }),
    method: "GET",
    handler: (req, ctx, params) => getChannelInfo(req, ctx, params),
  },
  {
    pattern: new URLPattern({ pathname: "/discord/channels/:id/messages" }),
    method: "GET",
    handler: (req, ctx, params) => searchMessages(req, ctx, params),
  },
  {
    pattern: new URLPattern({ pathname: "/discord/channels/:id/messages" }),
    method: "POST",
    handler: (req, ctx, params) => sendMessage(req, ctx, params),
  },
  {
    pattern: new URLPattern({
      pathname: "/discord/channels/:id/messages/:mid",
    }),
    method: "GET",
    handler: (req, ctx, params) => getMessage(req, ctx, params),
  },
  {
    pattern: new URLPattern({
      pathname: "/discord/channels/:cid/messages/:mid/reactions",
    }),
    method: "POST",
    handler: (req, ctx, params) => addReaction(req, ctx, params),
  },
  {
    pattern: new URLPattern({ pathname: "/discord/members" }),
    method: "GET",
    handler: (req, ctx) => getGuildMembers(req, ctx),
  },
];

/**
 * 統合 HTTP サーバーを起動する。
 *
 * @param manager - 承認マネージャー。
 * @param discordCtx - Discord API コンテキスト。
 * @param port - リッスンポート。
 * @returns Deno.HttpServer インスタンス（shutdown() で停止可能）。
 */
export function startApiServer(
  manager: ApprovalManager,
  discordCtx: ApiContext,
  cronCtx: CronApiContext | null,
  port: number,
): Deno.HttpServer {
  const server = Deno.serve(
    { port, hostname: "127.0.0.1" },
    async (req) => {
      const url = new URL(req.url);

      log.debug(`${req.method} ${url.pathname}`);

      // 承認フックエンドポイント
      if (req.method === "POST" && url.pathname === "/approval") {
        try {
          const input = (await req.json()) as PreToolUseHookInput;
          log.debug("hook input:", JSON.stringify(input));
          const result = await manager.requestApproval(input);
          return new Response(
            JSON.stringify(toHookOutput(result)),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          log.error("approval request error:", msg);
          return new Response(
            JSON.stringify({ error: msg }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      }

      // Discord API エンドポイント
      if (url.pathname.startsWith("/discord/")) {
        let pathMatched = false;
        for (const route of routes) {
          const match = route.pattern.exec(url);
          if (match) {
            pathMatched = true;
            if (req.method === route.method) {
              const params = match.pathname.groups as Record<string, string>;
              try {
                return await route.handler(req, discordCtx, params);
              } catch (error: unknown) {
                const msg = error instanceof Error
                  ? error.message
                  : String(error);
                log.error("discord api error:", msg);
                return new Response(
                  JSON.stringify({ error: msg }),
                  {
                    status: 500,
                    headers: { "Content-Type": "application/json" },
                  },
                );
              }
            }
          }
        }

        if (pathMatched) {
          return new Response(
            JSON.stringify({ error: "Method Not Allowed" }),
            { status: 405, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response(
          JSON.stringify({ error: "Not Found" }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }

      // Cron API エンドポイント
      if (cronCtx && url.pathname.startsWith("/cron/")) {
        let pathMatched = false;
        for (const route of cronRoutes) {
          const match = route.pattern.exec(url);
          if (match) {
            pathMatched = true;
            if (req.method === route.method) {
              const params = match.pathname.groups as Record<string, string>;
              try {
                return await route.handler(req, cronCtx, params);
              } catch (error: unknown) {
                const msg = error instanceof Error
                  ? error.message
                  : String(error);
                log.error("cron api error:", msg);
                return new Response(
                  JSON.stringify({ error: msg }),
                  {
                    status: 500,
                    headers: { "Content-Type": "application/json" },
                  },
                );
              }
            }
          }
        }

        if (pathMatched) {
          return new Response(
            JSON.stringify({ error: "Method Not Allowed" }),
            { status: 405, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response(
          JSON.stringify({ error: "Not Found" }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({ error: "Not Found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    },
  );

  log.info("API server started on port", port);
  return server;
}
