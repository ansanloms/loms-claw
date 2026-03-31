import { assertEquals } from "@std/assert";
import { createMcpServer } from "./tools.ts";
import type { McpContext } from "./types.ts";

/**
 * createMcpServer が McpServer インスタンスを返すことを確認する。
 * ツールハンドラの実行テストは discord.js Client のモックが必要なため、
 * ここでは登録されるツール名の検証に留める。
 */

/** 最小限のモック Client。ツール登録時には使われない。 */
const mockCtx: McpContext = {
  // deno-lint-ignore no-explicit-any
  client: {} as any,
  guildId: "test-guild-id",
};

const expectedTools = [
  "discord_send_message",
  "discord_get_channel_info",
  "discord_list_channels",
  "discord_add_reaction",
  "discord_get_message",
  "discord_search_messages",
  "discord_get_guild_members",
];

Deno.test("createMcpServer", async (t) => {
  await t.step("McpServer インスタンスを返すこと", () => {
    const server = createMcpServer(mockCtx);
    assertEquals(typeof server, "object");
    assertEquals(typeof server.connect, "function");
    assertEquals(typeof server.close, "function");
  });

  await t.step("7 つのツールが登録されること", () => {
    const server = createMcpServer(mockCtx);

    // _registeredTools は SDK の内部プロパティ（plain object）。
    // 公開 API でツール一覧を取得する手段がないため直接参照している。
    // SDK バージョンアップで壊れるリスクあり。
    // deno-lint-ignore no-explicit-any
    const registeredTools = (server as any)._registeredTools;
    const toolNames = Object.keys(registeredTools);

    assertEquals(toolNames.length, expectedTools.length);
    for (const name of expectedTools) {
      assertEquals(
        toolNames.includes(name),
        true,
        `ツール ${name} が登録されていること`,
      );
    }
  });
});
