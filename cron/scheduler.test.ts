import { assertEquals } from "@std/assert";
import { CronScheduler } from "./scheduler.ts";
import type { CronJobDef } from "./types.ts";

function makeJob(name: string, schedule: string): CronJobDef {
  return {
    name,
    schedule,
    prompt: "test",
    channelId: "123",
  };
}

/** テスト用の Temporal.ZonedDateTime を作るヘルパー。 */
function zdt(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Temporal.ZonedDateTime {
  return Temporal.ZonedDateTime.from({
    year,
    month,
    day,
    hour,
    minute,
    second: 0,
    timeZone: "Asia/Tokyo",
  });
}

Deno.test("CronScheduler", async (t) => {
  await t.step("replaceAll でジョブが登録されること", () => {
    const scheduler = new CronScheduler(() => {});
    scheduler.replaceAll([makeJob("a", "* * * * *")]);
    assertEquals(scheduler.size, 1);
  });

  await t.step("replaceAll で既存ジョブが差し替えられること", () => {
    const scheduler = new CronScheduler(() => {});
    scheduler.replaceAll([
      makeJob("a", "* * * * *"),
      makeJob("b", "0 9 * * *"),
    ]);
    assertEquals(scheduler.size, 2);
    scheduler.replaceAll([makeJob("c", "0 0 * * *")]);
    assertEquals(scheduler.size, 1);
  });

  await t.step("tick でマッチするジョブのコールバックが呼ばれること", () => {
    const triggered: string[] = [];
    const scheduler = new CronScheduler((job) => triggered.push(job.name));

    scheduler.replaceAll([
      makeJob("always", "* * * * *"),
      makeJob("nine-only", "0 9 * * *"),
    ]);

    // 09:00 → 両方マッチ
    scheduler.tick(zdt(2026, 3, 31, 9, 0));
    assertEquals(triggered, ["always", "nine-only"]);
  });

  await t.step(
    "tick でマッチしないジョブのコールバックは呼ばれないこと",
    () => {
      const triggered: string[] = [];
      const scheduler = new CronScheduler((job) => triggered.push(job.name));

      scheduler.replaceAll([makeJob("nine-only", "0 9 * * *")]);

      // 10:00 → マッチしない
      scheduler.tick(zdt(2026, 3, 31, 10, 0));
      assertEquals(triggered, []);
    },
  );

  await t.step("同一分の二重発火が防止されること", () => {
    const triggered: string[] = [];
    const scheduler = new CronScheduler((job) => triggered.push(job.name));

    scheduler.replaceAll([makeJob("always", "* * * * *")]);

    const time = zdt(2026, 3, 31, 9, 0);
    scheduler.tick(time);
    scheduler.tick(time); // 同じ時刻で再度 tick
    assertEquals(triggered.length, 1);
  });

  await t.step("異なる分では正常に発火すること", () => {
    const triggered: string[] = [];
    const scheduler = new CronScheduler((job) => triggered.push(job.name));

    scheduler.replaceAll([makeJob("always", "* * * * *")]);

    scheduler.tick(zdt(2026, 3, 31, 9, 0));
    scheduler.tick(zdt(2026, 3, 31, 9, 1));
    assertEquals(triggered.length, 2);
  });

  await t.step("start の二重呼び出しでタイマーが重複しないこと", () => {
    const scheduler = new CronScheduler(() => {});
    scheduler.start();
    scheduler.start(); // 二重呼び出し
    scheduler.stop();
  });

  await t.step("stop が冪等であること", () => {
    const scheduler = new CronScheduler(() => {});
    scheduler.stop();
    scheduler.stop(); // 二重呼び出し
  });

  await t.step("replaceAll 後の tick で新しいジョブが評価されること", () => {
    const triggered: string[] = [];
    const scheduler = new CronScheduler((job) => triggered.push(job.name));

    scheduler.replaceAll([makeJob("old", "0 9 * * *")]);
    scheduler.tick(zdt(2026, 3, 31, 9, 0));
    assertEquals(triggered, ["old"]);

    // ジョブを差し替え
    scheduler.replaceAll([makeJob("new", "0 10 * * *")]);
    scheduler.tick(zdt(2026, 3, 31, 10, 0));
    assertEquals(triggered, ["old", "new"]);
  });

  await t.step(
    "不正な cron 式のジョブがあっても他のジョブは実行されること",
    () => {
      const triggered: string[] = [];
      const scheduler = new CronScheduler((job) => triggered.push(job.name));

      scheduler.replaceAll([
        { name: "bad", schedule: "invalid", prompt: "x", channelId: "1" },
        makeJob("good", "* * * * *"),
      ]);

      scheduler.tick(zdt(2026, 3, 31, 9, 0));
      assertEquals(triggered, ["good"]);
    },
  );
});
