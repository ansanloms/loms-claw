import { describe, test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { join } from "@std/path/join";
import { addToSettingsAllowList, isInAllowList } from "./settings.ts";

describe("addToSettingsAllowList", () => {
  test("ファイルが存在しない場合は新規作成すること", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
    const settingsPath = join(dir, ".claude", "settings.json");

    await addToSettingsAllowList(
      settingsPath,
      "mcp__claude_ai_Gmail__search_threads",
    );

    const result = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepStrictEqual(result, {
      permissions: {
        allow: ["mcp__claude_ai_Gmail__search_threads"],
      },
    });
  });

  test("既存フィールドを保持してマージすること", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
    const settingsPath = join(dir, "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({ env: { LOG_LEVEL: "debug" } }, null, 2) + "\n",
    );

    await addToSettingsAllowList(settingsPath, "Bash(git status)");

    const result = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepStrictEqual(result, {
      env: { LOG_LEVEL: "debug" },
      permissions: {
        allow: ["Bash(git status)"],
      },
    });
  });

  test("既存の permissions.allow に追記すること", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
    const settingsPath = join(dir, "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify(
        { permissions: { allow: ["Read"], deny: ["Bash(rm *)"] } },
        null,
        2,
      ) + "\n",
    );

    await addToSettingsAllowList(settingsPath, "Edit");

    const result = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepStrictEqual(result, {
      permissions: {
        allow: ["Read", "Edit"],
        deny: ["Bash(rm *)"],
      },
    });
  });

  test("重複するツール名は追加しないこと", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
    const settingsPath = join(dir, "settings.json");

    await addToSettingsAllowList(settingsPath, "Read");
    await addToSettingsAllowList(settingsPath, "Read");

    const result = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepStrictEqual(result.permissions.allow, ["Read"]);
  });
});

describe("isInAllowList", () => {
  test("allow list に含まれるツールで true を返すこと", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
    const settingsPath = join(dir, "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({ permissions: { allow: ["Read", "Bash"] } }),
    );

    assert.deepStrictEqual(await isInAllowList(settingsPath, "Bash"), true);
  });

  test("allow list に含まれないツールで false を返すこと", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
    const settingsPath = join(dir, "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({ permissions: { allow: ["Read"] } }),
    );

    assert.deepStrictEqual(await isInAllowList(settingsPath, "Bash"), false);
  });

  test("ファイルが存在しない場合に false を返すこと", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
    const settingsPath = join(dir, "nonexistent.json");

    assert.deepStrictEqual(await isInAllowList(settingsPath, "Read"), false);
  });

  test("JSON が不正な場合に false を返すこと", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
    const settingsPath = join(dir, "settings.json");
    await writeFile(settingsPath, "not json");

    assert.deepStrictEqual(await isInAllowList(settingsPath, "Read"), false);
  });

  test("permissions.allow が存在しない場合に false を返すこと", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
    const settingsPath = join(dir, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ env: {} }));

    assert.deepStrictEqual(await isInAllowList(settingsPath, "Read"), false);
  });
});
