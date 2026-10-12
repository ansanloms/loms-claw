import { describe, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { errorWith } from "./test-helpers.ts";
import { loadConfig } from "./config.ts";

const ENV_KEY = "LOMS_CLAW_CONFIG";

/** 一時ディレクトリ配下の config ファイルパスを返す (ファイル自体は作らない)。 */
function makeTempConfigPath(): string {
  return join(mkdtempSync(join(tmpdir(), "loms-claw-test-")), "config.json");
}

const requiredFields = {
  discord: {
    token: "test-token",
    guildId: "test-guild",
    userId: "test-user",
  },
};

/**
 * 一時 JSON に configOverride を書き出し、LOMS_CLAW_CONFIG で指してから fn を実行する。
 * 実行後に環境変数を元に戻し、一時ファイルを削除する。
 */
function withTempConfig(
  contents: Record<string, unknown>,
  fn: () => void,
): void {
  const original = process.env[ENV_KEY];
  const path = makeTempConfigPath();
  try {
    writeFileSync(path, JSON.stringify(contents));
    process.env[ENV_KEY] = path;
    fn();
  } finally {
    if (original === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = original;
    }
    try {
      rmSync(dirname(path), { recursive: true });
    } catch {
      /* ignore */
    }
  }
}

describe("loadConfig", () => {
  test("必須フィールドのみでデフォルト値が補完されること", () => {
    withTempConfig(requiredFields, () => {
      const config = loadConfig();
      assert.deepStrictEqual(config.discord.token, "test-token");
      assert.deepStrictEqual(config.discord.guildId, "test-guild");
      assert.deepStrictEqual(config.discord.userId, "test-user");
      assert.deepStrictEqual(config.discord.activeChannelIds, []);
      assert.deepStrictEqual(config.storePath, ".claude/loms-claw.sqlite");
      assert.deepStrictEqual(config.claude.defaults.model, undefined);
      assert.deepStrictEqual(config.claude.defaults.effort, undefined);
      assert.deepStrictEqual(config.claude.maxTurns, 10);
      assert.deepStrictEqual(config.claude.timeout, 300000);
      assert.deepStrictEqual(config.claude.apiPort, 3000);
      assert.deepStrictEqual(config.claude.defaults.showThinking, false);
      assert.deepStrictEqual(config.log.level, "INFO");
      assert.deepStrictEqual(config.log.bufferSize, 1000);
    });
  });

  test("claude.cwd が process.cwd() で実行時注入されること", () => {
    withTempConfig(requiredFields, () => {
      const config = loadConfig();
      assert.deepStrictEqual(config.claude.cwd, process.cwd());
    });
  });

  test("discord.token 未設定でエラーになること", () => {
    const { token: _omit, ...restDiscord } = requiredFields.discord;
    withTempConfig({ discord: restDiscord }, () => {
      assert.throws(() => loadConfig(), errorWith(Error, "token"));
    });
  });

  test("discord.guildId が空文字列でエラーになること", () => {
    withTempConfig(
      { discord: { ...requiredFields.discord, guildId: "" } },
      () => {
        assert.throws(() => loadConfig(), errorWith(Error, "guildId"));
      },
    );
  });

  test("discord.token が空文字列でエラーになること", () => {
    withTempConfig(
      { discord: { ...requiredFields.discord, token: "" } },
      () => {
        assert.throws(() => loadConfig(), errorWith(Error, "token"));
      },
    );
  });

  test("discord.userId 未設定でエラーになること", () => {
    const { userId: _omit, ...rest } = requiredFields.discord;
    withTempConfig({ discord: rest }, () => {
      assert.throws(() => loadConfig(), errorWith(Error, "userId"));
    });
  });

  test("log.bufferSize が minimum 未満でエラーになること", () => {
    withTempConfig(
      { ...requiredFields, log: { level: "INFO", bufferSize: 0 } },
      () => {
        assert.throws(() => loadConfig(), errorWith(Error, "bufferSize"));
      },
    );
  });

  test("log.bufferSize が maximum 超過でエラーになること", () => {
    withTempConfig(
      { ...requiredFields, log: { level: "INFO", bufferSize: 10001 } },
      () => {
        assert.throws(() => loadConfig(), errorWith(Error, "bufferSize"));
      },
    );
  });

  test("claude.defaults.effort の enum 違反でエラーになること", () => {
    withTempConfig(
      { ...requiredFields, claude: { defaults: { effort: "invalid" } } },
      () => {
        assert.throws(() => loadConfig(), errorWith(Error, "effort"));
      },
    );
  });

  test("maxTurns が string のとき型不一致でエラーになること", () => {
    withTempConfig({ ...requiredFields, claude: { maxTurns: "ten" } }, () => {
      assert.throws(() => loadConfig(), errorWith(Error, "maxTurns"));
    });
  });

  test("未知プロパティ (additionalProperties) を拒否すること", () => {
    withTempConfig({ ...requiredFields, UNKNOWN_KEY: "nope" }, () => {
      assert.throws(() => loadConfig(), errorWith(Error, "UNKNOWN_KEY"));
    });
  });

  test("log.level の enum 違反でエラーになること", () => {
    withTempConfig(
      { ...requiredFields, log: { level: "VERBOSE", bufferSize: 1000 } },
      () => {
        assert.throws(() => loadConfig(), errorWith(Error, "level"));
      },
    );
  });

  test("discord.activeChannelIds を配列として受け取れること", () => {
    withTempConfig(
      {
        discord: {
          ...requiredFields.discord,
          activeChannelIds: ["ch-1", "ch-2"],
        },
      },
      () => {
        const config = loadConfig();
        assert.deepStrictEqual(config.discord.activeChannelIds, [
          "ch-1",
          "ch-2",
        ]);
      },
    );
  });

  test("claude.defaults.model / effort を指定できること", () => {
    withTempConfig(
      {
        ...requiredFields,
        claude: { defaults: { model: "opus", effort: "high" } },
      },
      () => {
        const config = loadConfig();
        assert.deepStrictEqual(config.claude.defaults.model, "opus");
        assert.deepStrictEqual(config.claude.defaults.effort, "high");
      },
    );
  });

  test("claude 設定を上書きできること", () => {
    withTempConfig(
      {
        ...requiredFields,
        claude: {
          maxTurns: 5,
          timeout: 60000,
          apiPort: 4000,
        },
      },
      () => {
        const config = loadConfig();
        assert.deepStrictEqual(config.claude.maxTurns, 5);
        assert.deepStrictEqual(config.claude.timeout, 60000);
        assert.deepStrictEqual(config.claude.apiPort, 4000);
      },
    );
  });

  test("claude.verbose を含む config は additionalProperties: false で検証エラーになること", () => {
    withTempConfig(
      {
        ...requiredFields,
        claude: {
          maxTurns: 10,
          timeout: 300000,
          apiPort: 3000,
          defaults: {},
          verbose: true,
        },
      },
      () => {
        assert.throws(() => loadConfig(), errorWith(Error, "verbose"));
      },
    );
  });

  test("LOMS_CLAW_CONFIG で指定したパスが読まれること", () => {
    const path = makeTempConfigPath();
    const original = process.env[ENV_KEY];
    try {
      writeFileSync(
        path,
        JSON.stringify({ ...requiredFields, storePath: "/tmp/custom.kv" }),
      );
      process.env[ENV_KEY] = path;
      const config = loadConfig();
      assert.deepStrictEqual(config.storePath, "/tmp/custom.kv");
    } finally {
      if (original === undefined) {
        delete process.env[ENV_KEY];
      } else {
        process.env[ENV_KEY] = original;
      }
      try {
        rmSync(dirname(path), { recursive: true });
      } catch {
        /* ignore */
      }
    }
  });

  test("ファイルが存在しない場合にエラーになること", () => {
    const original = process.env[ENV_KEY];
    process.env[ENV_KEY] = "/tmp/__does-not-exist__.json";
    try {
      assert.throws(
        () => loadConfig(),
        errorWith(Error, "failed to read config file"),
      );
    } finally {
      if (original === undefined) {
        delete process.env[ENV_KEY];
      } else {
        process.env[ENV_KEY] = original;
      }
    }
  });

  test("不正な JSON でパースエラーになること", () => {
    const path = makeTempConfigPath();
    const original = process.env[ENV_KEY];
    try {
      writeFileSync(path, "{ not valid json");
      process.env[ENV_KEY] = path;
      assert.throws(
        () => loadConfig(),
        errorWith(Error, "failed to parse config file"),
      );
    } finally {
      if (original === undefined) {
        delete process.env[ENV_KEY];
      } else {
        process.env[ENV_KEY] = original;
      }
      try {
        rmSync(dirname(path), { recursive: true });
      } catch {
        /* ignore */
      }
    }
  });
});
