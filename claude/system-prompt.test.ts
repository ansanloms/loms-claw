import { describe, test } from "node:test";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile as writeTextFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { join } from "@std/path/join";
import { type PromptScope, SystemPromptStore } from "./system-prompt.ts";

/**
 * テスト用の一時ディレクトリを作成し、コールバック実行後に削除する。
 */
async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true });
  }
}

/**
 * ディレクトリ内にファイルを作成する。
 */
async function writeFile(
  dir: string,
  name: string,
  content: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeTextFile(join(dir, name), content);
}

const ch = (channelId: string): PromptScope => ({ channelId });
const th = (channelId: string, threadId: string): PromptScope => ({
  channelId,
  threadId,
});

describe("SystemPromptStore", () => {
  test("ディレクトリ不在で undefined を返すこと", async () => {
    await withTempDir(async (dir) => {
      const store = new SystemPromptStore(join(dir, "nonexistent"));
      await store.load();
      assert.deepStrictEqual(store.resolve("chat", ch("ch-1")), undefined);
    });
  });

  test("DEFAULT.md のみ存在時にその内容を返すこと", async () => {
    await withTempDir(async (dir) => {
      await writeFile(dir, "DEFAULT.md", "default prompt");
      const store = new SystemPromptStore(dir);
      await store.load();
      assert.deepStrictEqual(
        store.resolve("chat", ch("ch-1")),
        "default prompt",
      );
    });
  });

  test("chat コンテキストで DEFAULT.md + CHAT.md が結合されること", async () => {
    await withTempDir(async (dir) => {
      await writeFile(dir, "DEFAULT.md", "default");
      await writeFile(dir, "CHAT.md", "chat specific");
      const store = new SystemPromptStore(dir);
      await store.load();
      assert.deepStrictEqual(
        store.resolve("chat", ch("ch-1")),
        "default\n\nchat specific",
      );
    });
  });

  test("チャンネル ID ファイルが結合されること", async () => {
    await withTempDir(async (dir) => {
      await writeFile(dir, "DEFAULT.md", "default");
      await writeFile(dir, "ch-123.md", "channel specific");
      const store = new SystemPromptStore(dir);
      await store.load();
      assert.deepStrictEqual(
        store.resolve("chat", ch("ch-123")),
        "default\n\nchannel specific",
      );
    });
  });

  test("全 3 種のファイルが順序通りに結合されること", async () => {
    await withTempDir(async (dir) => {
      await writeFile(dir, "DEFAULT.md", "default");
      await writeFile(dir, "CHAT.md", "chat");
      await writeFile(dir, "ch-456.md", "channel");
      const store = new SystemPromptStore(dir);
      await store.load();
      assert.deepStrictEqual(
        store.resolve("chat", ch("ch-456")),
        "default\n\nchat\n\nchannel",
      );
    });
  });

  test("空白のみのファイルはスキップされること", async () => {
    await withTempDir(async (dir) => {
      await writeFile(dir, "DEFAULT.md", "  \n  ");
      await writeFile(dir, "CHAT.md", "chat");
      const store = new SystemPromptStore(dir);
      await store.load();
      assert.deepStrictEqual(store.resolve("chat", ch("ch-1")), "chat");
    });
  });

  test("resolve() は load() 後に同期で呼べること", async () => {
    await withTempDir(async (dir) => {
      await writeFile(dir, "DEFAULT.md", "sync test");
      const store = new SystemPromptStore(dir);
      await store.load();
      // 同期呼び出し（Promise ではない）
      const result = store.resolve("chat", ch("ch-1"));
      assert.deepStrictEqual(typeof result, "string");
      assert.deepStrictEqual(result, "sync test");
    });
  });

  test("テンプレート変数が置換されること", async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        dir,
        "DEFAULT.md",
        "Guild: {{discord.guild.name}} Channel: {{discord.channel.id}}",
      );
      const store = new SystemPromptStore(dir);
      await store.load();
      const result = store.resolve("chat", ch("ch-1"), {
        "discord.guild.name": "test-guild",
        "discord.channel.id": "ch-1",
      });
      assert.deepStrictEqual(result, "Guild: test-guild Channel: ch-1");
    });
  });

  test("cron コンテキストで DEFAULT.md + CRON.md が結合されること", async () => {
    await withTempDir(async (dir) => {
      await writeFile(dir, "DEFAULT.md", "default");
      await writeFile(dir, "CRON.md", "cron specific");
      const store = new SystemPromptStore(dir);
      await store.load();
      assert.deepStrictEqual(
        store.resolve("cron", ch("ch-1")),
        "default\n\ncron specific",
      );
    });
  });

  test("cron コンテキストで CHAT.md は読まれないこと", async () => {
    await withTempDir(async (dir) => {
      await writeFile(dir, "CHAT.md", "chat only");
      const store = new SystemPromptStore(dir);
      await store.load();
      assert.deepStrictEqual(store.resolve("cron", ch("ch-1")), undefined);
    });
  });

  test("CRON.md がチャンネル ID ファイルとしてスキャンされないこと", async () => {
    await withTempDir(async (dir) => {
      await writeFile(dir, "CRON.md", "cron prompt");
      const store = new SystemPromptStore(dir);
      await store.load();
      // "CRON" はチャンネル ID として扱われない
      assert.deepStrictEqual(store.resolve("chat", ch("CRON")), undefined);
    });
  });

  test("vars 未指定時はテンプレート変数がそのまま残ること", async () => {
    await withTempDir(async (dir) => {
      await writeFile(dir, "DEFAULT.md", "ID: {{discord.channel.id}}");
      const store = new SystemPromptStore(dir);
      await store.load();
      const result = store.resolve("chat", ch("ch-1"));
      assert.deepStrictEqual(result, "ID: {{discord.channel.id}}");
    });
  });

  // ── thread スコープのフォールバック ───────────────────

  test("thread スコープで thread ファイル無しなら親 channel ファイルが読まれること", async () => {
    await withTempDir(async (dir) => {
      await writeFile(dir, "DEFAULT.md", "default");
      await writeFile(dir, "ch-parent.md", "parent channel prompt");
      const store = new SystemPromptStore(dir);
      await store.load();
      assert.deepStrictEqual(
        store.resolve("chat", th("ch-parent", "thread-1")),
        "default\n\nparent channel prompt",
      );
    });
  });

  test("thread スコープで thread ファイルがあれば優先され channel ファイルは読まれないこと", async () => {
    await withTempDir(async (dir) => {
      await writeFile(dir, "DEFAULT.md", "default");
      await writeFile(dir, "ch-parent.md", "parent channel prompt");
      await writeFile(dir, "thread-1.md", "thread specific prompt");
      const store = new SystemPromptStore(dir);
      await store.load();
      assert.deepStrictEqual(
        store.resolve("chat", th("ch-parent", "thread-1")),
        "default\n\nthread specific prompt",
      );
    });
  });

  test("thread スコープで thread / channel どちらのファイルも無ければ DEFAULT のみになること", async () => {
    await withTempDir(async (dir) => {
      await writeFile(dir, "DEFAULT.md", "default");
      const store = new SystemPromptStore(dir);
      await store.load();
      assert.deepStrictEqual(
        store.resolve("chat", th("ch-parent", "thread-1")),
        "default",
      );
    });
  });

  test("channel スコープでは thread ID と同名のファイルがあっても読まれないこと", async () => {
    await withTempDir(async (dir) => {
      await writeFile(dir, "DEFAULT.md", "default");
      await writeFile(dir, "thread-1.md", "thread specific");
      const store = new SystemPromptStore(dir);
      await store.load();
      // channel スコープ ("thread-1" 自体を channelId として渡したわけではない)
      assert.deepStrictEqual(store.resolve("chat", ch("ch-other")), "default");
    });
  });

  test("thread フォールバックで読まれた channel ファイル内のテンプレート変数も置換されること", async () => {
    await withTempDir(async (dir) => {
      await writeFile(dir, "DEFAULT.md", "default");
      await writeFile(
        dir,
        "ch-parent.md",
        "Channel ID: {{discord.channel.id}}",
      );
      const store = new SystemPromptStore(dir);
      await store.load();
      // thread スコープで channel ファイルがフォールバック採用される際も
      // vars が適用される (発話地点の ID = thread.id が入る)。
      const result = store.resolve("chat", th("ch-parent", "thread-1"), {
        "discord.channel.id": "thread-1",
      });
      assert.deepStrictEqual(result, "default\n\nChannel ID: thread-1");
    });
  });

  test("channelId が空文字なら channel ファイル検索に hit しないこと", async () => {
    await withTempDir(async (dir) => {
      await writeFile(dir, "DEFAULT.md", "default");
      await writeFile(dir, "CRON.md", "cron");
      // 空文字をキーとした .md は存在しないので何も追加で乗らない
      const store = new SystemPromptStore(dir);
      await store.load();
      assert.deepStrictEqual(store.resolve("cron", ch("")), "default\n\ncron");
    });
  });
});
