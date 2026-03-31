import { assertEquals } from "@std/assert";
import { join } from "@std/path/join";
import { addToSettingsAllowList } from "./settings.ts";

Deno.test("addToSettingsAllowList", async (t) => {
  await t.step("ファイルが存在しない場合は新規作成すること", async () => {
    const dir = await Deno.makeTempDir();
    const settingsPath = join(dir, ".claude", "settings.json");

    await addToSettingsAllowList(settingsPath, "mcp__discord__send_message");

    const result = JSON.parse(await Deno.readTextFile(settingsPath));
    assertEquals(result, {
      permissions: {
        allow: ["mcp__discord__send_message"],
      },
    });
  });

  await t.step("既存フィールドを保持してマージすること", async () => {
    const dir = await Deno.makeTempDir();
    const settingsPath = join(dir, "settings.json");
    await Deno.writeTextFile(
      settingsPath,
      JSON.stringify({ env: { LOG_LEVEL: "debug" } }, null, 2) + "\n",
    );

    await addToSettingsAllowList(settingsPath, "Bash(git status)");

    const result = JSON.parse(await Deno.readTextFile(settingsPath));
    assertEquals(result, {
      env: { LOG_LEVEL: "debug" },
      permissions: {
        allow: ["Bash(git status)"],
      },
    });
  });

  await t.step(
    "既存の permissions.allow に追記すること",
    async () => {
      const dir = await Deno.makeTempDir();
      const settingsPath = join(dir, "settings.json");
      await Deno.writeTextFile(
        settingsPath,
        JSON.stringify(
          { permissions: { allow: ["Read"], deny: ["Bash(rm *)"] } },
          null,
          2,
        ) + "\n",
      );

      await addToSettingsAllowList(settingsPath, "Edit");

      const result = JSON.parse(await Deno.readTextFile(settingsPath));
      assertEquals(result, {
        permissions: {
          allow: ["Read", "Edit"],
          deny: ["Bash(rm *)"],
        },
      });
    },
  );

  await t.step("重複するツール名を追加しないこと", async () => {
    const dir = await Deno.makeTempDir();
    const settingsPath = join(dir, "settings.json");

    await addToSettingsAllowList(settingsPath, "Read");
    await addToSettingsAllowList(settingsPath, "Read");

    const result = JSON.parse(await Deno.readTextFile(settingsPath));
    assertEquals(result.permissions.allow, ["Read"]);
  });
});
