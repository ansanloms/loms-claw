import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";

import { onceReady } from "./ready.ts";

describe("onceReady", () => {
  test("handler が成功したら resolve すること", async () => {
    const emitter = new EventEmitter();
    let called = 0;
    const ready = onceReady(emitter, "ready", async () => {
      called++;
    });
    emitter.emit("ready");
    await ready;
    assert.deepStrictEqual(called, 1);
  });

  test("イベントの引数が handler に渡ること", async () => {
    const emitter = new EventEmitter();
    let received: string | undefined;
    const ready = onceReady<[string]>(emitter, "ready", async (v) => {
      received = v;
    });
    emitter.emit("ready", "client");
    await ready;
    assert.deepStrictEqual(received, "client");
  });

  test("handler が throw したら reject すること", async () => {
    const emitter = new EventEmitter();
    const ready = onceReady(emitter, "ready", async () => {
      throw new Error("boom");
    });
    emitter.emit("ready");
    await assert.rejects(ready, { message: "boom" });
  });

  test("handler が同期 throw しても reject すること", async () => {
    const emitter = new EventEmitter();
    const ready = onceReady(emitter, "ready", () => {
      throw new Error("sync boom");
    });
    emitter.emit("ready");
    await assert.rejects(ready, { message: "sync boom" });
  });

  test("registerCommands を模した handler の throw で reject すること", async () => {
    const emitter = new EventEmitter();
    const registerCommands = async () => {
      throw new Error("Missing Access");
    };
    const ready = onceReady(emitter, "ready", async () => {
      await registerCommands();
    });
    emitter.emit("ready");
    await assert.rejects(ready, { message: "Missing Access" });
  });

  test("loadCronJobsFromDir を模した handler の throw で reject すること", async () => {
    const emitter = new EventEmitter();
    const loadCronJobsFromDir = async () => {
      throw new Error("EACCES");
    };
    const ready = onceReady(emitter, "ready", async () => {
      await loadCronJobsFromDir();
    });
    emitter.emit("ready");
    await assert.rejects(ready, { message: "EACCES" });
  });

  test("await より前に reject しても unhandledRejection にならず、後から await で reject を受けられること", async () => {
    const emitter = new EventEmitter();
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const ready = onceReady(emitter, "ready", async () => {
        throw new Error("early boom");
      });
      emitter.emit("ready");
      // login() の await 中に相当する時間、誰も ready を待たない。
      // microtask と unhandledRejection の判定 (process tick 後) が終わるまで回す。
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setImmediate(r));
      }
      assert.deepStrictEqual(unhandled, []);
      await assert.rejects(ready, { message: "early boom" });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
