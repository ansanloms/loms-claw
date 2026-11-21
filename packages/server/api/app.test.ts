import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createApp } from "./app.ts";

describe("createApp", () => {
  test("GET /health が 200 と { status: ok } を返すこと", async () => {
    const res = await createApp().request("/health");
    assert.deepStrictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { status: "ok" });
  });

  test("定義に無いパスへの GET が 404 と { error: Not Found } を返すこと", async () => {
    const res = await createApp().request("/nope");
    assert.deepStrictEqual(res.status, 404);
    assert.deepStrictEqual(await res.json(), { error: "Not Found" });
  });
});
