// 生成型 (openapi.gen.d.ts) と bundle 済みの定義 (openapi.gen.json) を hono につなぐ薄い層。
import { readFileSync } from "node:fs";
import { Validator } from "@cfworker/json-schema";
import type { ValidationResult, Schema } from "@cfworker/json-schema";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";
import type { components, operations } from "./openapi.gen.d.ts";

type OperationId = keyof operations;

/** operation の JSON リクエストボディの型。 */
export type RequestBody<K extends OperationId> = operations[K] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;

/** operation の、指定ステータスの JSON レスポンスの型。 */
export type ResponseBody<
  K extends OperationId,
  S extends keyof operations[K]["responses"],
> = operations[K]["responses"][S] extends {
  content: { "application/json": infer B };
}
  ? B
  : never;

type Doc = {
  paths: Record<string, unknown>;
  components: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSchema(value: unknown): value is Schema {
  return isRecord(value);
}

function isDoc(value: unknown): value is Doc {
  return isRecord(value) && isRecord(value.paths) && isRecord(value.components);
}

function loadDoc(): Doc {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL("./openapi.gen.json", import.meta.url), "utf8"),
  );
  if (!isDoc(parsed)) {
    throw new Error("openapi.gen.json: paths と components が無い");
  }
  return parsed;
}

const doc = loadDoc();

function findBodySchema(operationId: string): Schema {
  for (const item of Object.values(doc.paths)) {
    if (!isRecord(item)) {
      continue;
    }
    for (const op of Object.values(item)) {
      if (!isRecord(op) || op.operationId !== operationId) {
        continue;
      }
      const { requestBody } = op;
      const content = isRecord(requestBody) ? requestBody.content : undefined;
      const json = isRecord(content) ? content["application/json"] : undefined;
      const schema = isRecord(json) ? json.schema : undefined;
      if (!isSchema(schema)) {
        throw new Error(`${operationId}: JSON の requestBody が無い`);
      }
      return schema;
    }
  }
  throw new Error(`${operationId}: operation が無い`);
}

/**
 * hono の onError に渡す関数。hono 自身が投げる HTTPException (JSON として読めない body 等) も
 * 定義のエラー形式 `{ error: string }` で返す。
 */
export function handleError(err: Error, c: Context): Response {
  if (err instanceof HTTPException) {
    const body: components["schemas"]["ResponseError"] = {
      error: err.message,
    };
    return c.json(body, err.status);
  }
  console.error(err);
  const body: components["schemas"]["ResponseError"] = {
    error: "Internal Server Error",
  };
  return c.json(body, 500);
}

/** operationId の requestBody を定義どおりに検証し、型を付ける hono の validator。 */
export function jsonBody<K extends OperationId>(operationId: K) {
  const root = {
    $id: "urn:loms-claw:api",
    ...findBodySchema(operationId),
    components: doc.components,
  };
  const schemaValidator = new Validator(root, "2020-12", false);
  const isBody = (
    value: unknown,
    result: ValidationResult,
  ): value is RequestBody<K> => result.valid;
  return validator("json", (value, c) => {
    const result = schemaValidator.validate(value);
    if (!isBody(value, result)) {
      const body: components["schemas"]["ResponseError"] = {
        error: result.errors.map((e) => e.error).join("; "),
      };
      return c.json(body, 400);
    }
    return value;
  });
}
