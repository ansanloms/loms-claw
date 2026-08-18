import { assertEquals } from "@std/assert";
import {
  isAuthorized,
  isAuthorizedSelfMessage,
  parseHopMarker,
  resolveActive,
  shouldRespond,
  shouldRespondToSelf,
} from "./guard.ts";
import type { Config } from "../config.ts";

const baseConfig: Config = {
  discord: {
    token: "token",
    guildId: "guild-1",
    userId: "user-1",
    activeChannelIds: [],
    selfMention: {
      enabled: true,
      maxHops: 3,
      rateLimit: { maxCount: 6, windowMinutes: 10 },
    },
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

  await t.step(
    "非 active channel で override が true なら mention 無しでも反応すること",
    () => {
      assertEquals(
        shouldRespond(
          "ch-other",
          activeChannels,
          false,
          null,
          false,
          false,
          true,
        ),
        true,
      );
    },
  );

  await t.step(
    "active channel で override が false なら mention 必須になること",
    () => {
      assertEquals(
        shouldRespond(
          "ch-active-1",
          activeChannels,
          false,
          null,
          false,
          false,
          false,
        ),
        false,
      );
    },
  );

  await t.step(
    "override が true でも bot mention 無し + 他ユーザーメンションありは無視すること",
    () => {
      assertEquals(
        shouldRespond(
          "ch-other",
          activeChannels,
          false,
          null,
          false,
          true,
          true,
        ),
        false,
      );
    },
  );
});

Deno.test("resolveActive", async (t) => {
  await t.step(
    "override が true なら config のリストに無くても true になること",
    () => {
      assertEquals(
        resolveActive("ch-other", activeChannels, false, null, true),
        true,
      );
    },
  );

  await t.step(
    "override が false なら config のリストにあっても false になること",
    () => {
      assertEquals(
        resolveActive("ch-active-1", activeChannels, false, null, false),
        false,
      );
    },
  );

  await t.step(
    "override が undefined なら config のリスト判定にフォールバックすること",
    () => {
      assertEquals(
        resolveActive("ch-active-1", activeChannels, false, null, undefined),
        true,
      );
      assertEquals(
        resolveActive("ch-other", activeChannels, false, null, undefined),
        false,
      );
    },
  );

  await t.step(
    "override が undefined でスレッドの場合、親チャンネルが active なら true になること",
    () => {
      assertEquals(
        resolveActive(
          "thread-1",
          activeChannels,
          true,
          "ch-active-1",
          undefined,
        ),
        true,
      );
    },
  );
});

Deno.test("isAuthorizedSelfMessage", async (t) => {
  await t.step(
    "enabled + 自 bot ID + 正しいギルドで許可されること",
    () => {
      assertEquals(
        isAuthorizedSelfMessage("guild-1", "bot-1", "bot-1", baseConfig),
        true,
      );
    },
  );

  await t.step("selfMention.enabled が false の場合は拒否されること", () => {
    const config: Config = {
      ...baseConfig,
      discord: {
        ...baseConfig.discord,
        selfMention: { ...baseConfig.discord.selfMention, enabled: false },
      },
    };
    assertEquals(
      isAuthorizedSelfMessage("guild-1", "bot-1", "bot-1", config),
      false,
    );
  });

  await t.step("異なるギルドは拒否されること", () => {
    assertEquals(
      isAuthorizedSelfMessage("guild-other", "bot-1", "bot-1", baseConfig),
      false,
    );
  });

  await t.step("guildId が null (DM) の場合は拒否されること", () => {
    assertEquals(
      isAuthorizedSelfMessage(null, "bot-1", "bot-1", baseConfig),
      false,
    );
  });

  await t.step(
    "authorId が botUserId と異なる (他 bot) 場合は拒否されること",
    () => {
      assertEquals(
        isAuthorizedSelfMessage("guild-1", "other-bot", "bot-1", baseConfig),
        false,
      );
    },
  );

  await t.step("botUserId が null の場合は拒否されること", () => {
    assertEquals(
      isAuthorizedSelfMessage("guild-1", "bot-1", null, baseConfig),
      false,
    );
  });
});

Deno.test("parseHopMarker", async (t) => {
  await t.step("[hop:1] から 1 が取れること", () => {
    assertEquals(parseHopMarker("[hop:1]"), 1);
  });

  await t.step("本文中の [hop:2] から 2 が取れること", () => {
    assertEquals(parseHopMarker("依頼本文 [hop:2] 続き"), 2);
  });

  await t.step("マーカーが無い場合は null であること", () => {
    assertEquals(parseHopMarker("マーカー無しの本文"), null);
  });

  await t.step("[hop:0] は null であること", () => {
    assertEquals(parseHopMarker("[hop:0]"), null);
  });

  await t.step("[hop:abc] は null であること", () => {
    assertEquals(parseHopMarker("[hop:abc]"), null);
  });

  await t.step("負数マーカーは null であること", () => {
    assertEquals(parseHopMarker("[hop:-1]"), null);
  });

  await t.step("複数マーカーは最初の正規表現一致を採用すること", () => {
    assertEquals(parseHopMarker("[hop:2] [hop:5]"), 2);
    assertEquals(parseHopMarker("[hop:0] [hop:5]"), null);
    assertEquals(parseHopMarker("[hop:abc] [hop:2]"), 2);
  });
});

Deno.test("shouldRespondToSelf", async (t) => {
  await t.step("メンション + 有効な hop なら true であること", () => {
    assertEquals(shouldRespondToSelf(true, 1, 3, undefined), true);
  });

  await t.step("メンション無しは false であること", () => {
    assertEquals(shouldRespondToSelf(false, 1, 3, undefined), false);
  });

  await t.step("hop が null (マーカー無し) は false であること", () => {
    assertEquals(shouldRespondToSelf(true, null, 3, undefined), false);
  });

  await t.step("hop が maxHops 超過は false であること", () => {
    assertEquals(shouldRespondToSelf(true, 4, 3, undefined), false);
  });

  await t.step(
    "activeOverride が false は false であること (kill switch)",
    () => {
      assertEquals(shouldRespondToSelf(true, 1, 3, false), false);
    },
  );

  await t.step("activeOverride が true / undefined は通ること", () => {
    assertEquals(shouldRespondToSelf(true, 1, 3, true), true);
    assertEquals(shouldRespondToSelf(true, 1, 3, undefined), true);
  });

  await t.step("hop が maxHops ちょうどの場合は反応すること", () => {
    assertEquals(shouldRespondToSelf(true, 3, 3, undefined), true);
  });
});
