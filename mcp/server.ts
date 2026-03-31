/**
 * Discord MCP HTTP サーバー。
 *
 * WebStandardStreamableHTTPServerTransport を使い、
 * Deno.serve() で MCP エンドポイントを提供する。
 * stateless モードで動作し、リクエストごとに McpServer を生成する。
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpContext } from "./types.ts";
import { createMcpServer } from "./tools.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("mcp-server");

/**
 * MCP HTTP サーバーを起動する。
 *
 * @param ctx - discord.js Client とギルド ID を含むコンテキスト。
 * @param port - リッスンポート。
 * @returns Deno.HttpServer インスタンス（shutdown() で停止可能）。
 */
export function startMcpServer(
  ctx: McpContext,
  port: number,
): Deno.HttpServer {
  const server = Deno.serve(
    { port, hostname: "127.0.0.1" },
    async (req) => {
      const url = new URL(req.url);

      // MCP エンドポイント: POST /mcp
      if (req.method === "POST" && url.pathname === "/mcp") {
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        const mcpServer = createMcpServer(ctx);
        try {
          await mcpServer.connect(transport);
          const response = await transport.handleRequest(req);
          return response;
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          log.error("MCP request error:", msg);
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal server error" },
              id: null,
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            },
          );
        } finally {
          // stateless モードでもリスナーが残るため明示的にクリーンアップする。
          await mcpServer.close().catch(() => {});
        }
      }

      // GET /mcp は stateless モードでは不要
      if (url.pathname === "/mcp") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed." },
            id: null,
          }),
          {
            status: 405,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response("Not Found", { status: 404 });
    },
  );

  log.info("MCP server started on port", port);
  return server;
}
