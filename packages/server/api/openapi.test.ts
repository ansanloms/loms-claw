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
  app.patch("/settings", jsonBody("patchScopesScopeIdSettings"), (c) =>
    c.json(c.req.valid("json"), 200),
  );
  return app;
}

async function patch(body: unknown): Promise<Response> {
  return await createTestApp().request("/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("jsonBody", () => {
  test("定義どおりの body は 200 になること", async () => {
    const res = await patch({ effort: "high" });
    assert.deepStrictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { effort: "high" });
  });

  test("null を指定した body は 200 になること", async () => {
    for (const body of [{ effort: null }, { model: "x", effort: null }]) {
      const res = await patch(body);
      assert.deepStrictEqual(res.status, 200);
    }
  });

  test("空の body は 400 になること", async () => {
    const res = await patch({});
    assert.deepStrictEqual(res.status, 400);
  });

  test("定義に無いキーは 400 になること", async () => {
    const res = await patch({ effort: "high", unknown: 1 });
    assert.deepStrictEqual(res.status, 400);
  });

  test("session に文字列を渡すと 400 になること", async () => {
    const res = await patch({ session: "abc" });
    assert.deepStrictEqual(res.status, 400);
  });

  test("effort に語彙外の値を渡すと 400 になること", async () => {
    const res = await patch({ effort: "invalid" });
    assert.deepStrictEqual(res.status, 400);
  });

  test("400 の応答が { error: string } の形であること", async () => {
    const res = await patch({});
    const body: unknown = await res.json();
    assert.ok(typeof body === "object" && body !== null);
    assert.deepStrictEqual(Object.keys(body), ["error"]);
    assert.ok("error" in body && typeof body.error === "string");
  });

  test("JSON として読めない body は { error: string } の 400 になること", async () => {
    const res = await createTestApp().request("/settings", {
      method: "PATCH",
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
      () => jsonBody("getHealth"),
      errorWith(Error, "JSON の requestBody が無い"),
    );
  });
});
