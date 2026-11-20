import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import {
  createSessionsRoutes,
  type SessionsRouteContext,
  type SessionTarget,
} from "./sessions.ts";

type SubmitResult = Awaited<ReturnType<SessionsRouteContext["submitMessage"]>>;

function createApp(result: SubmitResult = "accepted") {
  const calls: Array<[SessionTarget, string, string | undefined]> = [];
  const app = new Hono();
  app.route(
    "/sessions",
    createSessionsRoutes({
      submitMessage: (target, prompt, source) => {
        calls.push([target, prompt, source]);
        return Promise.resolve(result);
      },
    }),
  );
  return { app, calls };
}

function post(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("createSessionsRoutes", () => {
  test("POST /:channelId/messages: 受け付けたら 202 で { ok: true } を返し、チャンネルを対象に渡すこと", async () => {
    const { app, calls } = createApp();

    const res = await post(app, "/sessions/10000000000000000/messages", {
      prompt: "hello",
      source: "cron:news.md",
    });

    assert.deepStrictEqual(res.status, 202);
    assert.deepStrictEqual(await res.json(), { ok: true });
    assert.deepStrictEqual(calls, [
      [{ channelId: "10000000000000000" }, "hello", "cron:news.md"],
    ]);
  });

  test("POST /:channelId/:threadId/messages: スレッドを対象に渡し、source 省略時は undefined になること", async () => {
    const { app, calls } = createApp();

    const res = await post(
      app,
      "/sessions/10000000000000000/20000000000000000/messages",
      {
        prompt: "hello",
      },
    );

    assert.deepStrictEqual(res.status, 202);
    assert.deepStrictEqual(calls, [
      [
        { channelId: "10000000000000000", threadId: "20000000000000000" },
        "hello",
        undefined,
      ],
    ]);
  });

  test("POST: JSON が不正なら 400 を返し、依頼を渡さないこと", async () => {
    const { app, calls } = createApp();

    const res = await post(
      app,
      "/sessions/10000000000000000/messages",
      "{not json",
    );

    assert.deepStrictEqual(res.status, 400);
    assert.deepStrictEqual(calls, []);
  });

  test("POST: スキーマ不一致 (prompt 空・source 空・source 101 文字・未知のキー・prompt 無し) は 400 を返すこと", async () => {
    const { app, calls } = createApp();
    const bodies = [
      { prompt: "" },
      { prompt: "a", source: "" },
      { prompt: "a", source: "x".repeat(101) },
      { prompt: "a", extra: 1 },
      { prompt: "a", source: "cron:a\n[偽の注記]" },
      { prompt: "a", source: "cron:a\tb" },
      { prompt: "a", source: "cron:a\x7f" },
      { prompt: " \n\t " },
      {},
    ];

    for (const body of bodies) {
      const res = await post(app, "/sessions/10000000000000000/messages", body);
      assert.deepStrictEqual(res.status, 400, JSON.stringify(body));
    }
    assert.deepStrictEqual(calls, []);
  });

  test("POST: source が 100 文字ちょうどなら受け付けること", async () => {
    const { app } = createApp();

    const res = await post(app, "/sessions/10000000000000000/messages", {
      prompt: "a",
      source: "x".repeat(100),
    });

    assert.deepStrictEqual(res.status, 202);
  });

  test("POST: 対象が見つからなければ 404 を返すこと", async () => {
    const { app } = createApp("not-found");

    const res = await post(
      app,
      "/sessions/10000000000000000/20000000000000000/messages",
      { prompt: "a" },
    );

    assert.deepStrictEqual(res.status, 404);
    assert.ok(
      typeof ((await res.json()) as { error: unknown }).error === "string",
    );
  });

  test("POST: レート制限の超過は 429 を返すこと", async () => {
    const { app } = createApp("rate-limited");

    const res = await post(app, "/sessions/10000000000000000/messages", {
      prompt: "a",
    });

    assert.deepStrictEqual(res.status, 429);
  });

  test("POST: コンテキスト未注入なら両ルートとも 503 を返すこと", async () => {
    const app = new Hono();
    app.route("/sessions", createSessionsRoutes());

    for (const path of [
      "/sessions/10000000000000000/messages",
      "/sessions/10000000000000000/20000000000000000/messages",
    ]) {
      const res = await post(app, path, { prompt: "a" });
      assert.deepStrictEqual(res.status, 503, path);
    }
  });

  test("POST: パスの ID が数字 17〜20 桁でなければ 400 を返し、依頼を渡さないこと", async () => {
    const { app, calls } = createApp();
    const paths = [
      "/sessions/abc/messages",
      "/sessions/1234567890123456/messages",
      "/sessions/123456789012345678901/messages",
      "/sessions/10000000000000000/abc/messages",
      "/sessions/10000000000000000/2000000000000000a/messages",
    ];

    for (const path of paths) {
      const res = await post(app, path, { prompt: "a" });
      assert.deepStrictEqual(res.status, 400, path);
    }
    assert.deepStrictEqual(calls, []);
  });

  test("POST: 日本語や空白を含む source と、空白を含む prompt は受け付けること", async () => {
    const { app, calls } = createApp();

    const res = await post(app, "/sessions/10000000000000000/messages", {
      prompt: " 宿までの道のり ",
      source: "cron:ニュース 朝刊.md",
    });

    assert.deepStrictEqual(res.status, 202);
    assert.deepStrictEqual(calls[0]?.[1], " 宿までの道のり ");
    assert.deepStrictEqual(calls[0]?.[2], "cron:ニュース 朝刊.md");
  });
});
