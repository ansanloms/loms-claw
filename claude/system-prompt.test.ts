import { assertEquals } from "@std/assert";
import { join } from "jsr:@std/path@^1/join";
import { resolveSystemPrompt } from "./system-prompt.ts";

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
 * .claude/system-prompt/ 配下にファイルを作成する。
 */
async function writePromptFile(
  cwd: string,
  name: string,
  content: string,
): Promise<void> {
  const dir = join(cwd, ".claude", "system-prompt");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, name), content);
}

Deno.test("resolveSystemPrompt", async (t) => {
  await t.step("全ファイル不在で undefined を返すこと", async () => {
    await withTempDir(async (dir) => {
      const result = await resolveSystemPrompt(dir, "chat", "ch-1");
      assertEquals(result, undefined);
    });
  });

  await t.step("DEFAULT.md のみ存在時にその内容を返すこと", async () => {
    await withTempDir(async (dir) => {
      await writePromptFile(dir, "DEFAULT.md", "default prompt");
      const result = await resolveSystemPrompt(dir, "chat", "ch-1");
      assertEquals(result, "default prompt");
    });
  });

  await t.step(
    "chat コンテキストで DEFAULT.md + CHAT.md が結合されること",
    async () => {
      await withTempDir(async (dir) => {
        await writePromptFile(dir, "DEFAULT.md", "default");
        await writePromptFile(dir, "CHAT.md", "chat specific");
        const result = await resolveSystemPrompt(dir, "chat", "ch-1");
        assertEquals(result, "default\n\nchat specific");
      });
    },
  );

  await t.step(
    "vc コンテキストで DEFAULT.md + VC.md が結合されること",
    async () => {
      await withTempDir(async (dir) => {
        await writePromptFile(dir, "DEFAULT.md", "default");
        await writePromptFile(dir, "VC.md", "vc specific");
        const result = await resolveSystemPrompt(dir, "vc", "ch-1");
        assertEquals(result, "default\n\nvc specific");
      });
    },
  );

  await t.step(
    "chat コンテキストで VC.md は読まれないこと",
    async () => {
      await withTempDir(async (dir) => {
        await writePromptFile(dir, "VC.md", "vc only");
        const result = await resolveSystemPrompt(dir, "chat", "ch-1");
        assertEquals(result, undefined);
      });
    },
  );

  await t.step(
    "vc コンテキストで CHAT.md は読まれないこと",
    async () => {
      await withTempDir(async (dir) => {
        await writePromptFile(dir, "CHAT.md", "chat only");
        const result = await resolveSystemPrompt(dir, "vc", "ch-1");
        assertEquals(result, undefined);
      });
    },
  );

  await t.step(
    "チャンネル ID ファイルが結合されること",
    async () => {
      await withTempDir(async (dir) => {
        await writePromptFile(dir, "DEFAULT.md", "default");
        await writePromptFile(dir, "ch-123.md", "channel specific");
        const result = await resolveSystemPrompt(dir, "chat", "ch-123");
        assertEquals(result, "default\n\nchannel specific");
      });
    },
  );

  await t.step(
    "全 3 種のファイルが順序通りに結合されること",
    async () => {
      await withTempDir(async (dir) => {
        await writePromptFile(dir, "DEFAULT.md", "default");
        await writePromptFile(dir, "VC.md", "vc");
        await writePromptFile(dir, "ch-456.md", "channel");
        const result = await resolveSystemPrompt(dir, "vc", "ch-456");
        assertEquals(result, "default\n\nvc\n\nchannel");
      });
    },
  );

  await t.step("空白のみのファイルはスキップされること", async () => {
    await withTempDir(async (dir) => {
      await writePromptFile(dir, "DEFAULT.md", "  \n  ");
      await writePromptFile(dir, "CHAT.md", "chat");
      const result = await resolveSystemPrompt(dir, "chat", "ch-1");
      assertEquals(result, "chat");
    });
  });
});
