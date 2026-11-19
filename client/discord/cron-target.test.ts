import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Client } from "discord.js";
import { errorWith } from "../../test-helpers.ts";
import type { ApprovalManager } from "./approval/manager.ts";
import { createDiscordCronPorts } from "./cron-target.ts";

function createFakeClient(
  channel: { send(content: string): Promise<unknown> } | null,
  guildName: string | null = "test-guild",
): Client {
  return {
    channels: {
      fetch: () => Promise.resolve(channel),
    },
    guilds: {
      cache: {
        get: () => (guildName === null ? undefined : { name: guildName }),
      },
    },
  } as unknown as Client;
}

function createPorts(
  client: Client,
  approvalManager: unknown = {},
  guildId = "guild-1",
) {
  return createDiscordCronPorts({
    client,
    guildId,
    approvalManager: approvalManager as ApprovalManager,
  });
}

describe("createDiscordCronPorts", () => {
  test("resolveTarget: 見つからないチャンネルで throw すること", async () => {
    const ports = createPorts(createFakeClient(null));

    await assert.rejects(
      ports.resolveTarget("ch-1"),
      errorWith(Error, "channel ch-1 not found or not a text channel"),
    );
  });

  test("resolveTarget: send を持たないチャンネルで throw すること", async () => {
    const ports = createPorts(
      createFakeClient({} as unknown as { send(c: string): Promise<unknown> }),
    );

    await assert.rejects(
      ports.resolveTarget("ch-1"),
      errorWith(Error, "not a text channel"),
    );
  });

  test("resolveTarget: 短いテキストは 1 回で送信されること", async () => {
    const sent: string[] = [];
    const ports = createPorts(
      createFakeClient({
        send: (c) => {
          sent.push(c);
          return Promise.resolve();
        },
      }),
    );

    const target = await ports.resolveTarget("ch-1");
    await target.send("hello");

    assert.deepStrictEqual(sent, ["hello"]);
  });

  test("resolveTarget: 2000 文字超のテキストが分割されて送信されること", async () => {
    const sent: string[] = [];
    const ports = createPorts(
      createFakeClient({
        send: (c) => {
          sent.push(c);
          return Promise.resolve();
        },
      }),
    );
    const longText = "a".repeat(2500);

    const target = await ports.resolveTarget("ch-1");
    await target.send(longText);

    assert.deepStrictEqual(sent.length > 1, true);
    assert.deepStrictEqual(sent.join(""), longText);
  });

  test("guildTemplateVars: ギルド ID と名前を返すこと", () => {
    const ports = createPorts(createFakeClient(null, "my-guild"));

    assert.deepStrictEqual(ports.guildTemplateVars(), {
      "discord.guild.id": "guild-1",
      "discord.guild.name": "my-guild",
    });
  });

  test("guildTemplateVars: ギルドがキャッシュに無ければ名前が空文字になること", () => {
    const ports = createPorts(createFakeClient(null, null));

    assert.deepStrictEqual(ports.guildTemplateVars(), {
      "discord.guild.id": "guild-1",
      "discord.guild.name": "",
    });
  });

  test("createCanUseTool: 承認リクエストが指定 channelId 宛に送られること", async () => {
    const calls: Array<string | undefined> = [];
    const approvalManager = {
      requestApproval: (
        _toolName: string,
        _input: Record<string, unknown>,
        channelId: string | undefined,
      ) => {
        calls.push(channelId);
        return Promise.resolve({ decision: "allow" as const });
      },
    };
    const ports = createPorts(createFakeClient(null), approvalManager);

    await ports.createCanUseTool("ch-approval")("Bash", { command: "ls" }, {
      signal: new AbortController().signal,
      toolUseID: "tu-1",
      requestId: "req-1",
    } as never);

    assert.deepStrictEqual(calls, ["ch-approval"]);
  });
});
