import { assertEquals } from "@std/assert";
import { createLogger, getLogEntries } from "./logger.ts";

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

Deno.test("getLogEntries", async (t) => {
  // テスト用のユニークな namespace でバッファの他エントリと隔離する
  const NS = `test-getLogEntries-${crypto.randomUUID().slice(0, 8)}`;

  // コンソール出力を抑制するヘルパー
  function silenced(fn: () => void): void {
    const origLog = console.log;
    const origWarn = console.warn;
    const origErr = console.error;
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    try {
      fn();
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origErr;
    }
  }

  // テスト用エントリを投入
  silenced(() => {
    const log = createLogger(NS);
    log.debug("d1");
    log.info("i1");
    log.warn("w1");
    log.error("e1");
    log.info("i2");
  });

  await t.step("namespace フィルタで対象エントリのみ返すこと", () => {
    const entries = getLogEntries({ namespace: NS, limit: 1000 });
    assertEquals(entries.length, 5);
  });

  await t.step("level フィルタで指定レベル以上のみ返すこと", () => {
    const entries = getLogEntries({
      namespace: NS,
      level: "WARN",
      limit: 1000,
    });
    assertEquals(entries.length, 2);
    assertEquals(
      entries.every((e) => e.level === "WARN" || e.level === "ERROR"),
      true,
    );
  });

  await t.step("limit で件数を制限できること", () => {
    const entries = getLogEntries({ namespace: NS, limit: 2 });
    assertEquals(entries.length, 2);
    // 最新の2件が返る
    assertEquals(entries[1].message, "i2");
  });

  await t.step("since で時刻以降のみ返すこと", () => {
    const all = getLogEntries({ namespace: NS, limit: 1000 });
    // 2番目のエントリのタイムスタンプを since に指定
    const since = all[1].timestamp;
    const filtered = getLogEntries({ namespace: NS, since, limit: 1000 });
    assertEquals(filtered.every((e) => e.timestamp >= since), true);
  });

  await t.step("エントリの構造が正しいこと", () => {
    const entries = getLogEntries({ namespace: NS, limit: 1 });
    const entry = entries[0];
    assertEquals(typeof entry.timestamp, "string");
    assertEquals(typeof entry.level, "string");
    assertEquals(entry.namespace, NS);
    assertEquals(typeof entry.message, "string");
  });

  await t.step("引数を含むメッセージが文字列化されること", () => {
    const NS2 = `test-args-${crypto.randomUUID().slice(0, 8)}`;
    silenced(() => {
      const log = createLogger(NS2);
      log.info("msg", { key: "val" });
    });
    const entries = getLogEntries({ namespace: NS2, limit: 1 });
    assertEquals(entries[0].message.includes("msg"), true);
    assertEquals(entries[0].message.includes('"key"'), true);
  });

  await t.step("Error の stack が展開されること", () => {
    const NS3 = `test-error-${crypto.randomUUID().slice(0, 8)}`;
    silenced(() => {
      const log = createLogger(NS3);
      log.error("boom:", new Error("explicit failure"));
    });
    const entries = getLogEntries({ namespace: NS3, limit: 1 });
    assertEquals(entries[0].message.includes("boom:"), true);
    assertEquals(entries[0].message.includes("explicit failure"), true);
    // stack に最低限ファイル名が含まれること
    assertEquals(entries[0].message.includes("logger.test.ts"), true);
  });
});
