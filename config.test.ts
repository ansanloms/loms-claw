import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { loadConfig } from "./config.ts";

const ENV_KEY = "LOMS_CLAW_CONFIG";

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
  const original = Deno.env.get(ENV_KEY);
  const path = Deno.makeTempFileSync({ suffix: ".json" });
  try {
    Deno.writeTextFileSync(path, JSON.stringify(contents));
    Deno.env.set(ENV_KEY, path);
    fn();
  } finally {
    if (original === undefined) {
      Deno.env.delete(ENV_KEY);
    } else {
      Deno.env.set(ENV_KEY, original);
    }
    try {
      Deno.removeSync(path);
    } catch { /* ignore */ }
  }
}

Deno.test("loadConfig", async (t) => {
  await t.step("必須フィールドのみでデフォルト値が補完されること", () => {
    withTempConfig(requiredFields, () => {
      const config = loadConfig();
      assertEquals(config.discord.token, "test-token");
      assertEquals(config.discord.guildId, "test-guild");
      assertEquals(config.discord.userId, "test-user");
      assertEquals(config.discord.activeChannelIds, []);
      assertEquals(config.storePath, ".claude/loms-claw.kv");
      assertEquals(config.claude.defaults.model, undefined);
      assertEquals(config.claude.defaults.effort, undefined);
      assertEquals(config.claude.maxTurns, 10);
      assertEquals(config.claude.verbose, true);
      assertEquals(config.claude.timeout, 300000);
      assertEquals(config.claude.apiPort, 3000);
      assertEquals(config.voice.enabled, false);
      assertEquals(config.voice.whisper.url, "http://localhost:8178");
      assertEquals(config.voice.tts.url, "http://localhost:8000");
      assertEquals(config.voice.tts.model, "voicevox");
      assertEquals(config.voice.tts.speaker, "1");
      assertEquals(config.voice.tts.speed, 1);
      assertEquals(config.voice.minSpeechMs, 500);
      assertEquals(config.voice.speechRms, 200);
      assertEquals(config.voice.interruptRms, 500);
      assertEquals(config.voice.autoLeaveMs, 600000);
      assertEquals(config.voice.speechDebounceMs, 500);
      assertEquals(config.voice.noSpeechProbThreshold, 0.6);
      assertEquals(config.voice.notificationTone, true);
      assertEquals(config.voice.autoJoinVc, false);
      assertEquals(config.log.level, "INFO");
      assertEquals(config.log.bufferSize, 1000);
    });
  });

  await t.step("claude.cwd が Deno.cwd() で実行時注入されること", () => {
    withTempConfig(requiredFields, () => {
      const config = loadConfig();
      assertEquals(config.claude.cwd, Deno.cwd());
    });
  });

  await t.step("discord.token 未設定でエラーになること", () => {
    const { token: _omit, ...restDiscord } = requiredFields.discord;
    withTempConfig({ discord: restDiscord }, () => {
      assertThrows(() => loadConfig(), Error, "token");
    });
  });

  await t.step("discord.guildId が空文字列でエラーになること", () => {
    withTempConfig(
      { discord: { ...requiredFields.discord, guildId: "" } },
      () => {
        assertThrows(() => loadConfig(), Error, "guildId");
      },
    );
  });

  await t.step("型不一致でエラーになること (maxTurns が string)", () => {
    withTempConfig(
      { ...requiredFields, claude: { maxTurns: "ten" } },
      () => {
        assertThrows(() => loadConfig(), Error, "maxTurns");
      },
    );
  });

  await t.step("未知プロパティ (additionalProperties) を拒否すること", () => {
    withTempConfig(
      { ...requiredFields, UNKNOWN_KEY: "nope" },
      () => {
        const err = assertThrows(() => loadConfig(), Error);
        assertStringIncludes(err.message, "UNKNOWN_KEY");
      },
    );
  });

  await t.step("log.level の enum 違反でエラーになること", () => {
    withTempConfig(
      { ...requiredFields, log: { level: "VERBOSE", bufferSize: 1000 } },
      () => {
        assertThrows(() => loadConfig(), Error, "level");
      },
    );
  });

  await t.step("discord.activeChannelIds を配列として受け取れること", () => {
    withTempConfig(
      {
        discord: {
          ...requiredFields.discord,
          activeChannelIds: ["ch-1", "ch-2"],
        },
      },
      () => {
        const config = loadConfig();
        assertEquals(config.discord.activeChannelIds, ["ch-1", "ch-2"]);
      },
    );
  });

  await t.step("claude.defaults.model / effort を指定できること", () => {
    withTempConfig(
      {
        ...requiredFields,
        claude: { defaults: { model: "opus", effort: "high" } },
      },
      () => {
        const config = loadConfig();
        assertEquals(config.claude.defaults.model, "opus");
        assertEquals(config.claude.defaults.effort, "high");
      },
    );
  });

  await t.step("claude 設定を上書きできること", () => {
    withTempConfig(
      {
        ...requiredFields,
        claude: {
          maxTurns: 5,
          verbose: false,
          timeout: 60000,
          apiPort: 4000,
        },
      },
      () => {
        const config = loadConfig();
        assertEquals(config.claude.maxTurns, 5);
        assertEquals(config.claude.verbose, false);
        assertEquals(config.claude.timeout, 60000);
        assertEquals(config.claude.apiPort, 4000);
      },
    );
  });

  await t.step("voice.autoJoinVc が false で無効になること", () => {
    withTempConfig(
      { ...requiredFields, voice: { autoJoinVc: false } },
      () => {
        const config = loadConfig();
        assertEquals(config.voice.autoJoinVc, false);
      },
    );
  });

  await t.step("voice.autoJoinVc が true で全 VC 対象になること", () => {
    withTempConfig(
      { ...requiredFields, voice: { autoJoinVc: true } },
      () => {
        const config = loadConfig();
        assertEquals(config.voice.autoJoinVc, true);
      },
    );
  });

  await t.step(
    "voice.autoJoinVc が string 配列で指定 VC のみ対象になること",
    () => {
      withTempConfig(
        {
          ...requiredFields,
          voice: { autoJoinVc: ["ch-1", "ch-2"] },
        },
        () => {
          const config = loadConfig();
          assertEquals(config.voice.autoJoinVc, ["ch-1", "ch-2"]);
        },
      );
    },
  );

  await t.step("voice.autoJoinVc が不正な値でエラーになること", () => {
    withTempConfig(
      { ...requiredFields, voice: { autoJoinVc: "invalid" } },
      () => {
        assertThrows(() => loadConfig(), Error, "autoJoinVc");
      },
    );
  });

  await t.step("LOMS_CLAW_CONFIG で指定したパスが読まれること", () => {
    const path = Deno.makeTempFileSync({ suffix: ".json" });
    const original = Deno.env.get(ENV_KEY);
    try {
      Deno.writeTextFileSync(
        path,
        JSON.stringify({ ...requiredFields, storePath: "/tmp/custom.kv" }),
      );
      Deno.env.set(ENV_KEY, path);
      const config = loadConfig();
      assertEquals(config.storePath, "/tmp/custom.kv");
    } finally {
      if (original === undefined) {
        Deno.env.delete(ENV_KEY);
      } else {
        Deno.env.set(ENV_KEY, original);
      }
      try {
        Deno.removeSync(path);
      } catch { /* ignore */ }
    }
  });

  await t.step("ファイルが存在しない場合にエラーになること", () => {
    const original = Deno.env.get(ENV_KEY);
    Deno.env.set(ENV_KEY, "/tmp/__does-not-exist__.json");
    try {
      assertThrows(() => loadConfig(), Error, "failed to read config file");
    } finally {
      if (original === undefined) {
        Deno.env.delete(ENV_KEY);
      } else {
        Deno.env.set(ENV_KEY, original);
      }
    }
  });

  await t.step("不正な JSON でパースエラーになること", () => {
    const path = Deno.makeTempFileSync({ suffix: ".json" });
    const original = Deno.env.get(ENV_KEY);
    try {
      Deno.writeTextFileSync(path, "{ not valid json");
      Deno.env.set(ENV_KEY, path);
      assertThrows(() => loadConfig(), Error, "failed to parse config file");
    } finally {
      if (original === undefined) {
        Deno.env.delete(ENV_KEY);
      } else {
        Deno.env.set(ENV_KEY, original);
      }
      try {
        Deno.removeSync(path);
      } catch { /* ignore */ }
    }
  });
});
