import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import { Hono } from "hono";
import { errorWith } from "../test-helpers.ts";
import { handleError, jsonBody } from "./openapi.ts";

function createTestApp(): Hono {
  const app = new Hono();
  app.onError(handleError);
  app.get("/boom", () => {
    throw new Error("boom");
  });
  app.post("/turns", jsonBody("postThreadsThreadIdTurns"), (c) =>
    c.json(c.req.valid("json"), 200),
  );
  return app;
}

async function post(body: unknown): Promise<Response> {
  return await createTestApp().request("/turns", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("jsonBody", () => {
  test("定義どおりの body は 200 になること", async () => {
    const res = await post({ prompt: "hi" });
    assert.deepStrictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { prompt: "hi" });
  });

  test("必須のキーが無い body は 400 になること", async () => {
    const res = await post({});
    assert.deepStrictEqual(res.status, 400);
  });

  test("定義に無いキーは 400 になること", async () => {
    const res = await post({ prompt: "hi", unknown: 1 });
    assert.deepStrictEqual(res.status, 400);
  });

  test("空白だけの prompt は 400 になること", async () => {
    const res = await post({ prompt: "   " });
    assert.deepStrictEqual(res.status, 400);
  });

  test("effort に語彙外の値を渡すと 400 になること", async () => {
    const res = await post({ prompt: "hi", effort: "invalid" });
    assert.deepStrictEqual(res.status, 400);
  });

  test("400 の応答が { error: string } の形であること", async () => {
    const res = await post({});
    const body: unknown = await res.json();
    assert.ok(typeof body === "object" && body !== null);
    assert.deepStrictEqual(Object.keys(body), ["error"]);
    assert.ok("error" in body && typeof body.error === "string");
  });

  test("JSON として読めない body は { error: string } の 400 になること", async () => {
    const res = await createTestApp().request("/turns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad",
    });
    assert.deepStrictEqual(res.status, 400);
    const body: unknown = await res.json();
    assert.ok(typeof body === "object" && body !== null);
    assert.deepStrictEqual(Object.keys(body), ["error"]);
    assert.ok("error" in body && typeof body.error === "string");
  });

  test('HTTPException 以外の例外は { error: "Internal Server Error" } の 500 になること', async () => {
    const spy = mock.method(console, "error", () => {});
    try {
      const res = await createTestApp().request("/boom");
      assert.deepStrictEqual(res.status, 500);
      assert.deepStrictEqual(await res.json(), {
        error: "Internal Server Error",
      });
    } finally {
      spy.mock.restore();
    }
  });

  test("存在しない operationId は例外を投げること", () => {
    assert.throws(
      () => jsonBody("noSuchOperation" as never),
      errorWith(Error, "operation が無い"),
    );
  });

  test("requestBody の無い operationId は例外を投げること", () => {
    assert.throws(
      () => jsonBody("getApprovals"),
      errorWith(Error, "JSON の requestBody が無い"),
    );
  });
});
