import { assertEquals, assertThrows } from "@std/assert";
import { loadConfig } from "./config.ts";

function withEnv(
  vars: Record<string, string>,
  fn: () => void,
): void {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    originals[key] = Deno.env.get(key);
    Deno.env.set(key, vars[key]);
  }
  try {
    fn();
  } finally {
    for (const [key, original] of Object.entries(originals)) {
      if (original === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, original);
      }
    }
  }
}

const requiredEnv = {
  DISCORD_TOKEN: "test-token",
  GUILD_ID: "test-guild",
  AUTHORIZED_USER_ID: "test-user",
};

Deno.test("loadConfig", async (t) => {
  await t.step("必須の環境変数を読み込むこと", () => {
    withEnv(requiredEnv, () => {
      const config = loadConfig();
      assertEquals(config.discordToken, "test-token");
      assertEquals(config.guildId, "test-guild");
      assertEquals(config.authorizedUserId, "test-user");
    });
  });

  await t.step("DISCORD_TOKEN 未設定でエラーになること", () => {
    withEnv({ GUILD_ID: "g", AUTHORIZED_USER_ID: "u" }, () => {
      Deno.env.delete("DISCORD_TOKEN");
      assertThrows(() => loadConfig(), Error, "DISCORD_TOKEN");
    });
  });

  await t.step("GUILD_ID 未設定でエラーになること", () => {
    withEnv({ DISCORD_TOKEN: "t", AUTHORIZED_USER_ID: "u" }, () => {
      Deno.env.delete("GUILD_ID");
      assertThrows(() => loadConfig(), Error, "GUILD_ID");
    });
  });

  await t.step("AUTHORIZED_USER_ID 未設定でエラーになること", () => {
    withEnv({ DISCORD_TOKEN: "t", GUILD_ID: "g" }, () => {
      Deno.env.delete("AUTHORIZED_USER_ID");
      assertThrows(() => loadConfig(), Error, "AUTHORIZED_USER_ID");
    });
  });

  await t.step("ACTIVE_CHANNEL_IDS をカンマ区切りでパースすること", () => {
    withEnv(
      { ...requiredEnv, ACTIVE_CHANNEL_IDS: "ch-1, ch-2 , ch-3" },
      () => {
        const config = loadConfig();
        assertEquals(config.activeChannelIds, ["ch-1", "ch-2", "ch-3"]);
      },
    );
  });

  await t.step("ACTIVE_CHANNEL_IDS 未設定時は空配列になること", () => {
    withEnv(requiredEnv, () => {
      Deno.env.delete("ACTIVE_CHANNEL_IDS");
      const config = loadConfig();
      assertEquals(config.activeChannelIds, []);
    });
  });

  await t.step("claude 設定のデフォルト値が適用されること", () => {
    withEnv(requiredEnv, () => {
      const config = loadConfig();
      assertEquals(config.claude.maxTurns, 10);
      assertEquals(config.claude.verbose, true);
      assertEquals(config.claude.timeout, 300000);
      assertEquals(config.claude.approvalPort, 3000);
    });
  });

  await t.step("claude 設定を環境変数で上書きできること", () => {
    withEnv(
      {
        ...requiredEnv,
        CLAUDE_MAX_TURNS: "5",
        CLAUDE_VERBOSE: "false",
        CLAUDE_TIMEOUT: "60000",
        APPROVAL_PORT: "4000",
      },
      () => {
        const config = loadConfig();
        assertEquals(config.claude.maxTurns, 5);
        assertEquals(config.claude.verbose, false);
        assertEquals(config.claude.timeout, 60000);
        assertEquals(config.claude.approvalPort, 4000);
      },
    );
  });

  await t.step("voice 設定のデフォルト値が適用されること", () => {
    withEnv(requiredEnv, () => {
      Deno.env.delete("VOICE_ENABLED");
      const config = loadConfig();
      assertEquals(config.voice.enabled, false);
      assertEquals(config.voice.whisperUrl, "http://localhost:8178");
      assertEquals(config.voice.ttsUrl, "http://localhost:8000");
      assertEquals(config.voice.ttsModel, "voicevox");
      assertEquals(config.voice.ttsSpeaker, "1");
      assertEquals(config.voice.ttsSpeed, 1);
      assertEquals(config.voice.minSpeechMs, 500);
      assertEquals(config.voice.speechRms, 200);
      assertEquals(config.voice.interruptRms, 500);
      assertEquals(config.voice.autoLeaveMs, 600000);
      assertEquals(config.voice.speechDebounceMs, 500);
      assertEquals(config.voice.notificationTone, true);
      assertEquals(config.voice.autoJoinVc, false);
    });
  });

  await t.step("VOICE_ENABLED=true で有効になること", () => {
    withEnv({ ...requiredEnv, VOICE_ENABLED: "true" }, () => {
      const config = loadConfig();
      assertEquals(config.voice.enabled, true);
    });
  });

  await t.step("AUTO_JOIN_VC=true で全 VC 対象になること", () => {
    withEnv({ ...requiredEnv, AUTO_JOIN_VC: "true" }, () => {
      const config = loadConfig();
      assertEquals(config.voice.autoJoinVc, true);
    });
  });

  await t.step("AUTO_JOIN_VC=false で無効になること", () => {
    withEnv({ ...requiredEnv, AUTO_JOIN_VC: "false" }, () => {
      const config = loadConfig();
      assertEquals(config.voice.autoJoinVc, false);
    });
  });

  await t.step(
    "AUTO_JOIN_VC がカンマ区切りの場合はチャンネル ID 配列になること",
    () => {
      withEnv({ ...requiredEnv, AUTO_JOIN_VC: "ch-1, ch-2" }, () => {
        const config = loadConfig();
        assertEquals(config.voice.autoJoinVc, ["ch-1", "ch-2"]);
      });
    },
  );

  await t.step("voice 設定を環境変数で上書きできること", () => {
    withEnv(
      {
        ...requiredEnv,
        WHISPER_URL: "http://whisper:9000",
        OPENAI_TTS_URL: "http://tts:9001",
        OPENAI_TTS_MODEL: "custom-model",
        OPENAI_TTS_SPEAKER: "42",
        OPENAI_TTS_SPEED: "1.5",
        MIN_SPEECH_MS: "300",
        SPEECH_RMS: "150",
        INTERRUPT_RMS: "400",
        AUTO_LEAVE_MS: "-1",
        SPEECH_DEBOUNCE_MS: "1000",
        NOTIFICATION_TONE: "false",
      },
      () => {
        const config = loadConfig();
        assertEquals(config.voice.whisperUrl, "http://whisper:9000");
        assertEquals(config.voice.ttsUrl, "http://tts:9001");
        assertEquals(config.voice.ttsModel, "custom-model");
        assertEquals(config.voice.ttsSpeaker, "42");
        assertEquals(config.voice.ttsSpeed, 1.5);
        assertEquals(config.voice.minSpeechMs, 300);
        assertEquals(config.voice.speechRms, 150);
        assertEquals(config.voice.interruptRms, 400);
        assertEquals(config.voice.autoLeaveMs, -1);
        assertEquals(config.voice.speechDebounceMs, 1000);
        assertEquals(config.voice.notificationTone, false);
      },
    );
  });
});
