import { assertEquals } from "@std/assert";
import { isAuthorized, shouldRespond } from "./guard.ts";
import type { Config } from "../config.ts";

const baseConfig: Config = {
  discord: {
    token: "token",
    guildId: "guild-1",
    userId: "user-1",
    activeChannelIds: [],
  },
  storePath: "/tmp/test-loms-claw.kv",
  claude: {
    maxTurns: 10,
    verbose: false,
    timeout: 300000,
    cwd: "/tmp",
    apiPort: 3000,
    defaults: {},
  },
  voice: {
    enabled: false,
    whisper: { url: "http://localhost:8178", noSpeechProbThreshold: 0.6 },
    tts: {
      url: "http://localhost:8000",
      model: "voicevox",
      speaker: "1",
      speed: 1,
    },
    minSpeechMs: 500,
    speechRms: 200,
    interruptRms: 500,
    autoLeaveMs: 600000,
    speechDebounceMs: 500,
    notificationTone: true,
    autoJoinVc: false,
  },
  log: {
    level: "INFO",
    bufferSize: 1000,
  },
};

Deno.test("isAuthorized", async (t) => {
  await t.step("正しいギルド・ユーザーで許可されること", () => {
    assertEquals(isAuthorized("guild-1", "user-1", false, baseConfig), true);
  });

  await t.step("bot ユーザーは拒否されること", () => {
    assertEquals(isAuthorized("guild-1", "user-1", true, baseConfig), false);
  });

  await t.step("異なるギルドは拒否されること", () => {
    assertEquals(
      isAuthorized("guild-other", "user-1", false, baseConfig),
      false,
    );
  });

  await t.step("異なるユーザーは拒否されること", () => {
    assertEquals(
      isAuthorized("guild-1", "user-other", false, baseConfig),
      false,
    );
  });

  await t.step("ギルドが null (DM) の場合は拒否されること", () => {
    assertEquals(isAuthorized(null, "user-1", false, baseConfig), false);
  });
});

const activeChannels = ["ch-active-1", "ch-active-2"];

Deno.test("shouldRespond", async (t) => {
  await t.step("active channel では反応すること", () => {
    assertEquals(
      shouldRespond("ch-active-1", activeChannels, false, null, false, false),
      true,
    );
  });

  await t.step("非 active channel で mention なしの場合は無視すること", () => {
    assertEquals(
      shouldRespond("ch-other", activeChannels, false, null, false, false),
      false,
    );
  });

  await t.step("非 active channel で mention ありの場合は反応すること", () => {
    assertEquals(
      shouldRespond("ch-other", activeChannels, false, null, true, false),
      true,
    );
  });

  await t.step("スレッドで mention ありの場合は反応すること", () => {
    assertEquals(
      shouldRespond("thread-1", activeChannels, true, "ch-other", true, false),
      true,
    );
  });

  await t.step("親チャンネルが null のスレッドでは無視すること", () => {
    assertEquals(
      shouldRespond("thread-1", activeChannels, true, null, false, false),
      false,
    );
  });

  await t.step(
    "activeChannelIds が空で mention ありの場合は反応すること",
    () => {
      assertEquals(
        shouldRespond("ch-any", [], false, null, true, false),
        true,
      );
    },
  );

  await t.step(
    "activeChannelIds が空で mention なしの場合は無視すること",
    () => {
      assertEquals(
        shouldRespond("ch-any", [], false, null, false, false),
        false,
      );
    },
  );

  // active channel 配下のスレッドも自動応答する (話題分離用途)
  await t.step(
    "active channel のスレッドは mention 無しでも反応すること",
    () => {
      assertEquals(
        shouldRespond(
          "thread-1",
          activeChannels,
          true,
          "ch-active-1",
          false,
          false,
        ),
        true,
      );
    },
  );

  await t.step(
    "active channel のスレッドは mention ありでも反応すること",
    () => {
      assertEquals(
        shouldRespond(
          "thread-1",
          activeChannels,
          true,
          "ch-active-1",
          true,
          false,
        ),
        true,
      );
    },
  );

  await t.step(
    "active channel のスレッドで bot mention なし + 他ユーザーメンションありの場合は無視すること",
    () => {
      assertEquals(
        shouldRespond(
          "thread-1",
          activeChannels,
          true,
          "ch-active-1",
          false,
          true,
        ),
        false,
      );
    },
  );

  await t.step(
    "親が非 active なスレッドは mention 必須であること",
    () => {
      assertEquals(
        shouldRespond(
          "thread-1",
          activeChannels,
          true,
          "ch-other",
          false,
          false,
        ),
        false,
      );
    },
  );

  await t.step(
    "スレッド ID 自体が activeChannelIds に含まれる場合は親が非 active でも反応すること",
    () => {
      assertEquals(
        shouldRespond(
          "thread-1",
          ["thread-1"],
          true,
          "ch-other",
          false,
          false,
        ),
        true,
      );
    },
  );

  await t.step(
    "active channel で bot メンションのみの場合は反応すること",
    () => {
      assertEquals(
        shouldRespond(
          "ch-active-1",
          activeChannels,
          false,
          null,
          true,
          false,
        ),
        true,
      );
    },
  );

  // 他ユーザーメンション判定
  await t.step(
    "active channel で bot メンションなし + 他ユーザーメンションありの場合は無視すること",
    () => {
      assertEquals(
        shouldRespond(
          "ch-active-1",
          activeChannels,
          false,
          null,
          false,
          true,
        ),
        false,
      );
    },
  );

  await t.step(
    "active channel で bot メンション + 他ユーザーメンションありの場合は反応すること",
    () => {
      assertEquals(
        shouldRespond(
          "ch-active-1",
          activeChannels,
          false,
          null,
          true,
          true,
        ),
        true,
      );
    },
  );

  await t.step(
    "非 active channel では他ユーザーメンションに関係なく mention で反応すること",
    () => {
      assertEquals(
        shouldRespond("ch-other", activeChannels, false, null, true, true),
        true,
      );
    },
  );
});
