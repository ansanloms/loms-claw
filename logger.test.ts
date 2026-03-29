import { assertEquals } from "@std/assert";
import { createLogger } from "./logger.ts";

Deno.test("createLogger", async (t) => {
  await t.step("全メソッドが定義されていること", () => {
    const log = createLogger("test");
    assertEquals(typeof log.debug, "function");
    assertEquals(typeof log.info, "function");
    assertEquals(typeof log.warn, "function");
    assertEquals(typeof log.error, "function");
  });

  await t.step("info が console.log に出力すること", () => {
    const calls: unknown[][] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => calls.push(args);
    try {
      const log = createLogger("ns");
      log.info("hello", "world");
      assertEquals(calls.length, 1);
      const output = calls[0].join(" ");
      assertEquals(output.includes("[INFO ]"), true);
      assertEquals(output.includes("[ns]"), true);
      assertEquals(output.includes("hello"), true);
      assertEquals(output.includes("world"), true);
    } finally {
      console.log = originalLog;
    }
  });

  await t.step("error が console.error に出力すること", () => {
    const calls: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => calls.push(args);
    try {
      const log = createLogger("ns");
      log.error("fail");
      assertEquals(calls.length, 1);
      const output = calls[0].join(" ");
      assertEquals(output.includes("[ERROR]"), true);
    } finally {
      console.error = originalError;
    }
  });

  await t.step("warn が console.warn に出力すること", () => {
    const calls: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      const log = createLogger("ns");
      log.warn("caution");
      assertEquals(calls.length, 1);
      const output = calls[0].join(" ");
      assertEquals(output.includes("[WARN ]"), true);
    } finally {
      console.warn = originalWarn;
    }
  });
});
