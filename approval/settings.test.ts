import { assertEquals } from "@std/assert";
import { join } from "@std/path/join";
import { addToSettingsAllowList, isInAllowList } from "./settings.ts";

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

  await t.step("重複するツール名は追加しないこと", async () => {
    const dir = await Deno.makeTempDir();
    const settingsPath = join(dir, "settings.json");

    await addToSettingsAllowList(settingsPath, "Read");
    await addToSettingsAllowList(settingsPath, "Read");

    const result = JSON.parse(await Deno.readTextFile(settingsPath));
    assertEquals(result.permissions.allow, ["Read"]);
  });
});

Deno.test("isInAllowList", async (t) => {
  await t.step("allow list に含まれるツールで true を返すこと", async () => {
    const dir = await Deno.makeTempDir();
    const settingsPath = join(dir, "settings.json");
    await Deno.writeTextFile(
      settingsPath,
      JSON.stringify({ permissions: { allow: ["Read", "Bash"] } }),
    );

    assertEquals(await isInAllowList(settingsPath, "Bash"), true);
  });

  await t.step(
    "allow list に含まれないツールで false を返すこと",
    async () => {
      const dir = await Deno.makeTempDir();
      const settingsPath = join(dir, "settings.json");
      await Deno.writeTextFile(
        settingsPath,
        JSON.stringify({ permissions: { allow: ["Read"] } }),
      );

      assertEquals(await isInAllowList(settingsPath, "Bash"), false);
    },
  );

  await t.step("ファイルが存在しない場合に false を返すこと", async () => {
    const dir = await Deno.makeTempDir();
    const settingsPath = join(dir, "nonexistent.json");

    assertEquals(await isInAllowList(settingsPath, "Read"), false);
  });

  await t.step("JSON が不正な場合に false を返すこと", async () => {
    const dir = await Deno.makeTempDir();
    const settingsPath = join(dir, "settings.json");
    await Deno.writeTextFile(settingsPath, "not json");

    assertEquals(await isInAllowList(settingsPath, "Read"), false);
  });

  await t.step(
    "permissions.allow が存在しない場合に false を返すこと",
    async () => {
      const dir = await Deno.makeTempDir();
      const settingsPath = join(dir, "settings.json");
      await Deno.writeTextFile(settingsPath, JSON.stringify({ env: {} }));

      assertEquals(await isInAllowList(settingsPath, "Read"), false);
    },
  );
});
