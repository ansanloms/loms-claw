import { assertEquals, assertRejects } from "@std/assert";
import { ScopeQueue } from "./queue.ts";

/**
 * 手動で解決できる deferred promise。実行順序を決定論的に制御するために使う。
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

Deno.test("ScopeQueue", async (t) => {
  await t.step("同一 key では投入順に直列実行されること", async () => {
    const queue = new ScopeQueue();
    const order: number[] = [];
    const gate1 = deferred();

    // 1 件目は gate1 が開くまで完了しない。
    const p1 = queue.enqueue("ch", async () => {
      await gate1.promise;
      order.push(1);
    });
    // 2 件目は 1 件目が完了するまで開始されない。
    const p2 = queue.enqueue("ch", () => {
      order.push(2);
      return Promise.resolve();
    });

    // gate1 を開くまでは 1 件目も完了しないので order は空のまま。
    assertEquals(order, []);

    gate1.resolve();
    await Promise.all([p1, p2]);

    assertEquals(order, [1, 2]);
  });

  await t.step("別 key のタスクは並行に走れること", async () => {
    const queue = new ScopeQueue();
    const gateA = deferred();
    const order: string[] = [];

    // key A は gateA が開くまでブロックする。
    const pa = queue.enqueue("A", async () => {
      await gateA.promise;
      order.push("A");
    });
    // key B は A のブロックに関係なく即座に完了できる。
    const pb = queue.enqueue("B", () => {
      order.push("B");
      return Promise.resolve();
    });

    // A がブロック中でも B は完了する。
    await pb;
    assertEquals(order, ["B"]);

    gateA.resolve();
    await pa;
    assertEquals(order, ["B", "A"]);
  });

  await t.step("前段がスローしても後続タスクが実行されること", async () => {
    const queue = new ScopeQueue();
    const order: number[] = [];

    const p1 = queue.enqueue("ch", () => {
      order.push(1);
      return Promise.reject(new Error("boom"));
    });
    const p2 = queue.enqueue("ch", () => {
      order.push(2);
      return Promise.resolve();
    });

    // 1 件目の reject は呼び出し側へ伝播する。
    await assertRejects(() => p1, Error, "boom");
    // 2 件目は前段の失敗に巻き込まれず実行される。
    await p2;

    assertEquals(order, [1, 2]);
  });

  await t.step("チェーン完了後に key が削除されること", async () => {
    const queue = new ScopeQueue();

    const p = queue.enqueue("ch", () => Promise.resolve());
    // 実行中 / 待機中は busy。
    assertEquals(queue.isBusy("ch"), true);

    await p;
    // settle 後の microtask で削除されるため 1 tick 待つ。
    await Promise.resolve();

    assertEquals(queue.isBusy("ch"), false);
  });

  await t.step("未投入の key は busy でないこと", () => {
    const queue = new ScopeQueue();
    assertEquals(queue.isBusy("nope"), false);
  });
});
