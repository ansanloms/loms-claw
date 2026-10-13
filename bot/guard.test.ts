import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Config } from "../config.ts";
import {
  isAuthorized,
  isAuthorizedSelfMessage,
  resolveActive,
  shouldRespond,
} from "./guard.ts";

const baseConfig: Config = {
  discord: {
    token: "token",
    guildId: "guild-1",
    userId: "user-1",
    activeChannelIds: [],
  },
  storePath: "/tmp/test-loms-claw.sqlite",
  claude: {
    maxTurns: 10,
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

describe("isAuthorized", () => {
  test("正しいギルド・ユーザーで許可されること", () => {
    assert.deepStrictEqual(
      isAuthorized("guild-1", "user-1", false, baseConfig),
      true,
    );
  });

  test("bot ユーザーは拒否されること", () => {
    assert.deepStrictEqual(
      isAuthorized("guild-1", "user-1", true, baseConfig),
      false,
    );
  });

  test("異なるギルドは拒否されること", () => {
    assert.deepStrictEqual(
      isAuthorized("guild-other", "user-1", false, baseConfig),
      false,
    );
  });

  test("異なるユーザーは拒否されること", () => {
    assert.deepStrictEqual(
      isAuthorized("guild-1", "user-other", false, baseConfig),
      false,
    );
  });

  test("ギルドが null (DM) の場合は拒否されること", () => {
    assert.deepStrictEqual(
      isAuthorized(null, "user-1", false, baseConfig),
      false,
    );
  });
});

const activeChannels = ["ch-active-1", "ch-active-2"];

describe("shouldRespond", () => {
  test("active channel では反応すること", () => {
    assert.deepStrictEqual(
      shouldRespond("ch-active-1", activeChannels, false, null, false, false),
      true,
    );
  });

  test("非 active channel で mention なしの場合は無視すること", () => {
    assert.deepStrictEqual(
      shouldRespond("ch-other", activeChannels, false, null, false, false),
      false,
    );
  });

  test("非 active channel で mention ありの場合は反応すること", () => {
    assert.deepStrictEqual(
      shouldRespond("ch-other", activeChannels, false, null, true, false),
      true,
    );
  });

  test("スレッドで mention ありの場合は反応すること", () => {
    assert.deepStrictEqual(
      shouldRespond("thread-1", activeChannels, true, "ch-other", true, false),
      true,
    );
  });

  test("親チャンネルが null のスレッドでは無視すること", () => {
    assert.deepStrictEqual(
      shouldRespond("thread-1", activeChannels, true, null, false, false),
      false,
    );
  });

  test("activeChannelIds が空で mention ありの場合は反応すること", () => {
    assert.deepStrictEqual(
      shouldRespond("ch-any", [], false, null, true, false),
      true,
    );
  });

  test("activeChannelIds が空で mention なしの場合は無視すること", () => {
    assert.deepStrictEqual(
      shouldRespond("ch-any", [], false, null, false, false),
      false,
    );
  });

  // active channel 配下のスレッドも自動応答する (話題分離用途)
  test("active channel のスレッドは mention 無しでも反応すること", () => {
    assert.deepStrictEqual(
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
  });

  test("active channel のスレッドは mention ありでも反応すること", () => {
    assert.deepStrictEqual(
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
  });

  test("active channel のスレッドで bot mention なし + 他ユーザーメンションありの場合は無視すること", () => {
    assert.deepStrictEqual(
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
  });

  test("親が非 active なスレッドは mention 必須であること", () => {
    assert.deepStrictEqual(
      shouldRespond("thread-1", activeChannels, true, "ch-other", false, false),
      false,
    );
  });

  test("スレッド ID 自体が activeChannelIds に含まれる場合は親が非 active でも反応すること", () => {
    assert.deepStrictEqual(
      shouldRespond("thread-1", ["thread-1"], true, "ch-other", false, false),
      true,
    );
  });

  test("active channel で bot メンションのみの場合は反応すること", () => {
    assert.deepStrictEqual(
      shouldRespond("ch-active-1", activeChannels, false, null, true, false),
      true,
    );
  });

  // 他ユーザーメンション判定
  test("active channel で bot メンションなし + 他ユーザーメンションありの場合は無視すること", () => {
    assert.deepStrictEqual(
      shouldRespond("ch-active-1", activeChannels, false, null, false, true),
      false,
    );
  });

  test("active channel で bot メンション + 他ユーザーメンションありの場合は反応すること", () => {
    assert.deepStrictEqual(
      shouldRespond("ch-active-1", activeChannels, false, null, true, true),
      true,
    );
  });

  test("非 active channel では他ユーザーメンションに関係なく mention で反応すること", () => {
    assert.deepStrictEqual(
      shouldRespond("ch-other", activeChannels, false, null, true, true),
      true,
    );
  });

  test("非 active channel で override が true なら mention 無しでも反応すること", () => {
    assert.deepStrictEqual(
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
  });

  test("active channel で override が false なら mention 必須になること", () => {
    assert.deepStrictEqual(
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
  });

  test("override が true でも bot mention 無し + 他ユーザーメンションありは無視すること", () => {
    assert.deepStrictEqual(
      shouldRespond("ch-other", activeChannels, false, null, false, true, true),
      false,
    );
  });
});

describe("resolveActive", () => {
  test("override が true なら config のリストに無くても true になること", () => {
    assert.deepStrictEqual(
      resolveActive("ch-other", activeChannels, false, null, true),
      true,
    );
  });

  test("override が false なら config のリストにあっても false になること", () => {
    assert.deepStrictEqual(
      resolveActive("ch-active-1", activeChannels, false, null, false),
      false,
    );
  });

  test("override が undefined なら config のリスト判定にフォールバックすること", () => {
    assert.deepStrictEqual(
      resolveActive("ch-active-1", activeChannels, false, null, undefined),
      true,
    );
    assert.deepStrictEqual(
      resolveActive("ch-other", activeChannels, false, null, undefined),
      false,
    );
  });

  test("override が undefined でスレッドの場合、親チャンネルが active なら true になること", () => {
    assert.deepStrictEqual(
      resolveActive("thread-1", activeChannels, true, "ch-active-1", undefined),
      true,
    );
  });
});

describe("isAuthorizedSelfMessage", () => {
  test("自 bot ID + 正しいギルドで許可されること", () => {
    assert.deepStrictEqual(
      isAuthorizedSelfMessage("guild-1", "bot-1", "bot-1", baseConfig),
      true,
    );
  });

  test("異なるギルドは拒否されること", () => {
    assert.deepStrictEqual(
      isAuthorizedSelfMessage("guild-other", "bot-1", "bot-1", baseConfig),
      false,
    );
  });

  test("guildId が null (DM) の場合は拒否されること", () => {
    assert.deepStrictEqual(
      isAuthorizedSelfMessage(null, "bot-1", "bot-1", baseConfig),
      false,
    );
  });

  test("authorId が botUserId と異なる (他 bot) 場合は拒否されること", () => {
    assert.deepStrictEqual(
      isAuthorizedSelfMessage("guild-1", "other-bot", "bot-1", baseConfig),
      false,
    );
  });

  test("botUserId が null の場合は拒否されること", () => {
    assert.deepStrictEqual(
      isAuthorizedSelfMessage("guild-1", "bot-1", null, baseConfig),
      false,
    );
  });
});
