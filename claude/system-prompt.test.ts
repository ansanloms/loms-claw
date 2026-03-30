import { assertEquals } from "@std/assert";
import { join } from "jsr:@std/path@^1/join";
import { SystemPromptStore } from "./system-prompt.ts";

/**
 * テスト用の一時ディレクトリを作成し、コールバック実行後に削除する。
 */
async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
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
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, name), content);
}

Deno.test("SystemPromptStore", async (t) => {
  await t.step("ディレクトリ不在で undefined を返すこと", async () => {
    await withTempDir(async (dir) => {
      const store = new SystemPromptStore(join(dir, "nonexistent"));
      await store.load();
      assertEquals(store.resolve("chat", "ch-1"), undefined);
    });
  });

  await t.step("DEFAULT.md のみ存在時にその内容を返すこと", async () => {
    await withTempDir(async (dir) => {
      await writeFile(dir, "DEFAULT.md", "default prompt");
      const store = new SystemPromptStore(dir);
      await store.load();
      assertEquals(store.resolve("chat", "ch-1"), "default prompt");
    });
  });

  await t.step(
    "chat コンテキストで DEFAULT.md + CHAT.md が結合されること",
    async () => {
      await withTempDir(async (dir) => {
        await writeFile(dir, "DEFAULT.md", "default");
        await writeFile(dir, "CHAT.md", "chat specific");
        const store = new SystemPromptStore(dir);
        await store.load();
        assertEquals(store.resolve("chat", "ch-1"), "default\n\nchat specific");
      });
    },
  );

  await t.step(
    "vc コンテキストで DEFAULT.md + VC.md が結合されること",
    async () => {
      await withTempDir(async (dir) => {
        await writeFile(dir, "DEFAULT.md", "default");
        await writeFile(dir, "VC.md", "vc specific");
        const store = new SystemPromptStore(dir);
        await store.load();
        assertEquals(store.resolve("vc", "ch-1"), "default\n\nvc specific");
      });
    },
  );

  await t.step("chat コンテキストで VC.md は読まれないこと", async () => {
    await withTempDir(async (dir) => {
      await writeFile(dir, "VC.md", "vc only");
      const store = new SystemPromptStore(dir);
      await store.load();
      assertEquals(store.resolve("chat", "ch-1"), undefined);
    });
  });

  await t.step("vc コンテキストで CHAT.md は読まれないこと", async () => {
    await withTempDir(async (dir) => {
      await writeFile(dir, "CHAT.md", "chat only");
      const store = new SystemPromptStore(dir);
      await store.load();
      assertEquals(store.resolve("vc", "ch-1"), undefined);
    });
  });

  await t.step("チャンネル ID ファイルが結合されること", async () => {
    await withTempDir(async (dir) => {
      await writeFile(dir, "DEFAULT.md", "default");
      await writeFile(dir, "ch-123.md", "channel specific");
      const store = new SystemPromptStore(dir);
      await store.load();
      assertEquals(
        store.resolve("chat", "ch-123"),
        "default\n\nchannel specific",
      );
    });
  });

  await t.step("全 3 種のファイルが順序通りに結合されること", async () => {
    await withTempDir(async (dir) => {
      await writeFile(dir, "DEFAULT.md", "default");
      await writeFile(dir, "VC.md", "vc");
      await writeFile(dir, "ch-456.md", "channel");
      const store = new SystemPromptStore(dir);
      await store.load();
      assertEquals(store.resolve("vc", "ch-456"), "default\n\nvc\n\nchannel");
    });
  });

  await t.step("空白のみのファイルはスキップされること", async () => {
    await withTempDir(async (dir) => {
      await writeFile(dir, "DEFAULT.md", "  \n  ");
      await writeFile(dir, "CHAT.md", "chat");
      const store = new SystemPromptStore(dir);
      await store.load();
      assertEquals(store.resolve("chat", "ch-1"), "chat");
    });
  });

  await t.step("resolve() は load() 後に同期で呼べること", async () => {
    await withTempDir(async (dir) => {
      await writeFile(dir, "DEFAULT.md", "sync test");
      const store = new SystemPromptStore(dir);
      await store.load();
      // 同期呼び出し（Promise ではない）
      const result = store.resolve("chat", "ch-1");
      assertEquals(typeof result, "string");
      assertEquals(result, "sync test");
    });
  });
});
