import { describe, test } from "node:test";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { join } from "@std/path/join";
import { addToSettingsAllowList, isInAllowList } from "./approval-settings.ts";

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

  test("JSON が不正な場合は投げ、ファイルの内容を変えないこと", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
    const settingsPath = join(dir, "settings.json");
    const broken = '{"permissions": {"allow": ["Read"],}}';
    await writeFile(settingsPath, broken);

    await assert.rejects(
      addToSettingsAllowList(settingsPath, "Edit"),
      /settings\.json is invalid JSON/,
    );

    assert.deepStrictEqual(await readFile(settingsPath, "utf8"), broken);
  });

  test("同時に 2 回呼んでも両方のツールが allow に残ること", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
    const settingsPath = join(dir, "settings.json");

    await Promise.all([
      addToSettingsAllowList(settingsPath, "Read"),
      addToSettingsAllowList(settingsPath, "Edit"),
    ]);

    const result = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepStrictEqual([...result.permissions.allow].sort(), [
      "Edit",
      "Read",
    ]);
  });

  test("先行する呼び出しが失敗しても、待たずに積んだ後続の書き込みが実行されること", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
    const settingsPath = join(dir, "settings.json");
    await writeFile(settingsPath, "not json");

    // 先行の reject を待たずに後続を積み、結果はすぐ受ける (未処理 reject を作らない)。
    // 修復は先行の reject ハンドラの中で同期的に書く。チェーン内の後続は先行の
    // 完了後に tail 経由で起動するため、後続の readFile より必ず前に修復が済む。
    const failed = addToSettingsAllowList(settingsPath, "Read");
    failed.catch(() => writeFileSync(settingsPath, "{}"));
    const results = Promise.allSettled([
      failed,
      addToSettingsAllowList(settingsPath, "Edit"),
    ]);

    const [first, second] = await results;
    assert.deepStrictEqual(first.status, "rejected");
    assert.deepStrictEqual(second.status, "fulfilled");

    const result = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepStrictEqual(result.permissions.allow, ["Edit"]);
  });

  test("不正 JSON のエラーに SyntaxError が cause として残ること", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
    const settingsPath = join(dir, "settings.json");
    await writeFile(settingsPath, "not json");

    await assert.rejects(
      addToSettingsAllowList(settingsPath, "Read"),
      (e: unknown) => e instanceof Error && e.cause instanceof SyntaxError,
    );
  });

  test("settings.json が symlink でも symlink が保たれ実体に書くこと", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
    const realPath = join(dir, "real.json");
    const linkPath = join(dir, "settings.json");
    await writeFile(realPath, JSON.stringify({ env: { A: "1" } }));
    await symlink(realPath, linkPath);

    await addToSettingsAllowList(linkPath, "Read");

    assert.deepStrictEqual((await lstat(linkPath)).isSymbolicLink(), true);
    const result = JSON.parse(await readFile(realPath, "utf8"));
    assert.deepStrictEqual(result, {
      env: { A: "1" },
      permissions: { allow: ["Read"] },
    });
  });

  test("既存ファイルの mode が保たれること", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
    const settingsPath = join(dir, "settings.json");
    await writeFile(settingsPath, "{}");
    await chmod(settingsPath, 0o600);

    await addToSettingsAllowList(settingsPath, "Read");

    assert.deepStrictEqual((await stat(settingsPath)).mode & 0o777, 0o600);
  });

  test("hooks と env を保持して追記すること", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
    const settingsPath = join(dir, "settings.json");
    const original = {
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] },
      env: { LOG_LEVEL: "debug" },
      permissions: { allow: ["Read"] },
    };
    await writeFile(settingsPath, JSON.stringify(original));

    await addToSettingsAllowList(settingsPath, "Edit");

    const result = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepStrictEqual(result, {
      ...original,
      permissions: { allow: ["Read", "Edit"] },
    });
  });

  test("書き込み後に一時ファイルが残らないこと", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
    const settingsPath = join(dir, "settings.json");

    await addToSettingsAllowList(settingsPath, "Read");

    assert.deepStrictEqual(await readdir(dir), ["settings.json"]);
  });

  test("ENOENT 以外の読み取りエラーは握り潰さず投げること", async () => {
    // ファイルの代わりにディレクトリを指すと readFile は EISDIR で失敗する。
    // 読み取り時点のエラーが伝わること (後段の writeFile の失敗ではないこと) を
    // code と syscall (read) で確かめる。
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));

    await assert.rejects(
      addToSettingsAllowList(dir, "Read"),
      (e: unknown) =>
        e instanceof Error &&
        "code" in e &&
        e.code === "EISDIR" &&
        "syscall" in e &&
        e.syscall === "read",
    );
  });

  test("トップレベルが JSON オブジェクトでなければ投げ、ファイルの内容を変えないこと", async () => {
    for (const raw of ["null", "[]", "1", '"x"']) {
      const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
      const settingsPath = join(dir, "settings.json");
      await writeFile(settingsPath, raw);

      await assert.rejects(
        addToSettingsAllowList(settingsPath, "Read"),
        /settings\.json is not a JSON object/,
      );

      assert.deepStrictEqual(await readFile(settingsPath, "utf8"), raw);
    }
  });

  test("permissions がオブジェクトでなければ投げ、ファイルの内容を変えないこと", async () => {
    for (const permissions of [[], "bad", 1]) {
      const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
      const settingsPath = join(dir, "settings.json");
      const raw = JSON.stringify({ permissions });
      await writeFile(settingsPath, raw);

      await assert.rejects(
        addToSettingsAllowList(settingsPath, "Read"),
        /permissions is not a JSON object/,
      );

      assert.deepStrictEqual(await readFile(settingsPath, "utf8"), raw);
    }
  });

  test("permissions.allow が配列でなければ投げ、ファイルの内容を変えないこと", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
    const settingsPath = join(dir, "settings.json");
    const raw = JSON.stringify({
      permissions: { allow: "x", deny: ["Bash"] },
    });
    await writeFile(settingsPath, raw);

    await assert.rejects(
      addToSettingsAllowList(settingsPath, "Edit"),
      /permissions\.allow is not an array/,
    );

    assert.deepStrictEqual(await readFile(settingsPath, "utf8"), raw);
  });
  test("permissions や permissions.allow が null なら作り直し、兄弟キーを保つこと", async () => {
    for (const permissions of [
      null,
      { allow: null, deny: ["Bash"] },
    ] as const) {
      const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
      const settingsPath = join(dir, "settings.json");
      await writeFile(settingsPath, JSON.stringify({ env: {}, permissions }));

      await addToSettingsAllowList(settingsPath, "Read");

      const result = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.deepStrictEqual(result, {
        env: {},
        permissions:
          permissions === null
            ? { allow: ["Read"] }
            : { allow: ["Read"], deny: ["Bash"] },
      });
    }
  });

  test("permissions に allow が無ければ作り、兄弟キーを保つこと", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
    const settingsPath = join(dir, "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({ permissions: { deny: ["Bash"] } }),
    );

    await addToSettingsAllowList(settingsPath, "Read");

    const result = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepStrictEqual(result, {
      permissions: { allow: ["Read"], deny: ["Bash"] },
    });
  });

  test("permissions.allow に文字列以外の要素があれば投げ、ファイルの内容を変えないこと", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
    const settingsPath = join(dir, "settings.json");
    const raw = JSON.stringify({ permissions: { allow: ["Read", 1, null] } });
    await writeFile(settingsPath, raw);

    await assert.rejects(
      addToSettingsAllowList(settingsPath, "Edit"),
      /permissions\.allow has a non-string entry/,
    );

    assert.deepStrictEqual(await readFile(settingsPath, "utf8"), raw);
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
