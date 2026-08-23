import { assertEquals } from "@std/assert";
import { SelfMentionRateLimiter } from "./ratelimit.ts";

const BASE = Temporal.Instant.from("2026-01-01T00:00:00Z");

/**
 * 可変の現在時刻を返すクロージャを作る。`advance()` で経過分を進められる。
 */
function fakeClock(start: Temporal.Instant) {
  let current = start;
  return {
    now: () => current,
    advance: (minutes: number) => {
      current = current.add({ minutes });
    },
  };
}

Deno.test("SelfMentionRateLimiter", async (t) => {
  await t.step("上限未満の連続 tryConsume が許可されること", () => {
    const clock = fakeClock(BASE);
    const limiter = new SelfMentionRateLimiter(3, 10, clock.now);
    assertEquals(limiter.tryConsume(), true);
    assertEquals(limiter.tryConsume(), true);
    assertEquals(limiter.tryConsume(), true);
  });

  await t.step("上限到達後のウィンドウ内 tryConsume が拒否されること", () => {
    const clock = fakeClock(BASE);
    const limiter = new SelfMentionRateLimiter(2, 10, clock.now);
    assertEquals(limiter.tryConsume(), true);
    assertEquals(limiter.tryConsume(), true);
    assertEquals(limiter.tryConsume(), false);
  });

  await t.step("ウィンドウ経過後に再び許可されること", () => {
    const clock = fakeClock(BASE);
    const limiter = new SelfMentionRateLimiter(2, 10, clock.now);
    assertEquals(limiter.tryConsume(), true);
    assertEquals(limiter.tryConsume(), true);
    assertEquals(limiter.tryConsume(), false);

    clock.advance(11);
    assertEquals(limiter.tryConsume(), true);
  });

  await t.step("ウィンドウ境界ちょうどではまだ拒否されること", () => {
    const clock = fakeClock(BASE);
    const limiter = new SelfMentionRateLimiter(2, 10, clock.now);
    assertEquals(limiter.tryConsume(), true);
    assertEquals(limiter.tryConsume(), true);
    assertEquals(limiter.tryConsume(), false);

    // windowStart は inclusive (>=) のため、ちょうど windowMinutes 経過した
    // 時点では最初の消費タイムスタンプがまだウィンドウ内に残り、拒否される。
    clock.advance(10);
    assertEquals(limiter.tryConsume(), false);
  });

  await t.step("isExhausted が枠を消費せずに超過状態を返すこと", () => {
    const clock = fakeClock(BASE);
    const limiter = new SelfMentionRateLimiter(2, 10, clock.now);
    assertEquals(limiter.isExhausted(), false);
    assertEquals(limiter.tryConsume(), true);
    assertEquals(limiter.isExhausted(), false);
    assertEquals(limiter.isExhausted(), false);
    assertEquals(limiter.tryConsume(), true);
    assertEquals(limiter.isExhausted(), true);
    assertEquals(limiter.tryConsume(), false);

    clock.advance(11);
    assertEquals(limiter.isExhausted(), false);
  });
});
