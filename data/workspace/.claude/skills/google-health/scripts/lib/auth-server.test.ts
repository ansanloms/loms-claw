import { assertEquals } from "@std/assert";
import { runAuthServer } from "./auth-server.ts";

/** port: 0 で listen し、実際に bind された port が確定するのを待つ。 */
function listenOnEphemeralPort(
  params: Omit<Parameters<typeof runAuthServer>[0], "port" | "onListen">,
): {
  resultPromise: Promise<Awaited<ReturnType<typeof runAuthServer>>>;
  port: Promise<number>;
} {
  let resolvePort: (port: number) => void;
  const port = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });
  const resultPromise = runAuthServer({
    ...params,
    port: 0,
    onListen: (info) => resolvePort(info.port),
  });
  return { resultPromise, port };
}

Deno.test("runAuthServer: state が一致する /?code= を受けると exchangeCode が呼ばれ ok:true で終了する (他パスは 404 で継続)", async () => {
  const received: string[] = [];
  const { resultPromise, port } = listenOnEphemeralPort({
    state: "expected-state",
    exchangeCode: (code) => {
      received.push(code);
      return Promise.resolve();
    },
  });
  const boundPort = await port;

  // favicon 等の他パスは 404 を返して listen を継続する。
  const notFound = await fetch(`http://127.0.0.1:${boundPort}/favicon.ico`);
  assertEquals(notFound.status, 404);
  await notFound.body?.cancel();

  const res = await fetch(
    `http://127.0.0.1:${boundPort}/?code=auth-code&state=expected-state`,
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();

  const result = await resultPromise;
  assertEquals(result.ok, true);
  assertEquals(received, ["auth-code"]);
});

Deno.test("runAuthServer: state が一致する /?error= を受けると ok:false (reason に error を含む) で終了する", async () => {
  const { resultPromise, port } = listenOnEphemeralPort({
    state: "expected-state",
    exchangeCode: () => {
      throw new Error("呼ばれてはいけない");
    },
  });
  const boundPort = await port;

  const res = await fetch(
    `http://127.0.0.1:${boundPort}/?error=access_denied&state=expected-state`,
  );
  assertEquals(res.status, 400);
  await res.body?.cancel();

  const result = await resultPromise;
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.reason.includes("access_denied"), true);
  }
});

Deno.test("runAuthServer: state が不一致な /?code= は 400 を返して listen を継続する (settle しない)", async () => {
  const received: string[] = [];
  const { resultPromise, port } = listenOnEphemeralPort({
    state: "expected-state",
    exchangeCode: (code) => {
      received.push(code);
      return Promise.resolve();
    },
    // このテストはタイムアウトの発火自体を検証しないため、既定 (5 分) のままにする。
    // 短い timeoutMs を設定すると、後続の goodRes fetch より先にタイムアウトが発火して
    // server.shutdown() が走り、goodRes が接続エラーになる (並列実行時の負荷でこの間隔が伸びると顕在化する)。
  });
  const boundPort = await port;

  const badRes = await fetch(
    `http://127.0.0.1:${boundPort}/?code=auth-code&state=wrong-state`,
  );
  assertEquals(badRes.status, 400);
  await badRes.body?.cancel();
  assertEquals(received, []);

  // state 不一致では settle しないため、正しい state で再送すれば交換が進む。
  const goodRes = await fetch(
    `http://127.0.0.1:${boundPort}/?code=auth-code&state=expected-state`,
  );
  assertEquals(goodRes.status, 200);
  await goodRes.body?.cancel();

  const result = await resultPromise;
  assertEquals(result.ok, true);
  assertEquals(received, ["auth-code"]);
});

Deno.test("runAuthServer: state が不一致な /?error= も 400 を返して listen を継続する", async () => {
  const { resultPromise, port } = listenOnEphemeralPort({
    state: "expected-state",
    exchangeCode: () => {
      throw new Error("呼ばれてはいけない");
    },
  });
  const boundPort = await port;

  const badRes = await fetch(
    `http://127.0.0.1:${boundPort}/?error=access_denied&state=wrong-state`,
  );
  assertEquals(badRes.status, 400);
  await badRes.body?.cancel();

  const goodRes = await fetch(
    `http://127.0.0.1:${boundPort}/?error=access_denied&state=expected-state`,
  );
  assertEquals(goodRes.status, 400);
  await goodRes.body?.cancel();

  const result = await resultPromise;
  assertEquals(result.ok, false);
});

Deno.test("runAuthServer: state パラメータ自体が無い /?code= も 400 を返して listen を継続する", async () => {
  const { resultPromise, port } = listenOnEphemeralPort({
    state: "expected-state",
    exchangeCode: () => {
      throw new Error("呼ばれてはいけない");
    },
    // 並列実行時の負荷で badRes fetch がずれ込んでも誤発火しないよう、余裕を持った値にする。
    timeoutMs: 1000,
  });
  const boundPort = await port;

  const badRes = await fetch(`http://127.0.0.1:${boundPort}/?code=auth-code`);
  assertEquals(badRes.status, 400);
  await badRes.body?.cancel();

  const result = await resultPromise;
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.reason.includes("タイムアウト"), true);
  }
});

Deno.test("runAuthServer: code・error のどちらも来なければ timeoutMs でタイムアウトする", async () => {
  const { resultPromise, port } = listenOnEphemeralPort({
    state: "expected-state",
    exchangeCode: () => {
      throw new Error("呼ばれてはいけない");
    },
    // 並列実行時の負荷でも誤って早期に発火しないよう、余裕を持った値にする。
    timeoutMs: 1000,
  });
  await port;

  const result = await resultPromise;
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.reason.includes("タイムアウト"), true);
  }
});
