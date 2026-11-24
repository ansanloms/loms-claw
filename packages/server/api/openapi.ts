// 生成型 (openapi.gen.d.ts) と bundle 済みの定義 (openapi.gen.json) を hono につなぐ薄い層。
import { readFileSync } from "node:fs";
import { Validator } from "@cfworker/json-schema";
import type { ValidationResult, Schema } from "@cfworker/json-schema";
import type { Context, MiddlewareHandler } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";
import type { Principal, TokenRegistry } from "../auth/tokens.ts";
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

/** 認証を通った route の hono の Env。`secured` が `principal` を入れる。 */
export type AuthEnv = { Variables: { principal: Principal } };

type Doc = {
  paths: Record<string, unknown>;
  components: Record<string, unknown>;
  security?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSchema(value: unknown): value is Schema {
  return isRecord(value);
}

function isDoc(value: unknown): value is Doc {
  return (
    isRecord(value) &&
    isRecord(value.paths) &&
    isRecord(value.components) &&
    (value.security === undefined || Array.isArray(value.security))
  );
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

function findOperation(operationId: string): Record<string, unknown> {
  for (const item of Object.values(doc.paths)) {
    if (!isRecord(item)) {
      continue;
    }
    for (const op of Object.values(item)) {
      if (isRecord(op) && op.operationId === operationId) {
        return op;
      }
    }
  }
  throw new Error(`${operationId}: operation が無い`);
}

function findBodySchema(operationId: string): Schema {
  const { requestBody } = findOperation(operationId);
  const content = isRecord(requestBody) ? requestBody.content : undefined;
  const json = isRecord(content) ? content["application/json"] : undefined;
  const schema = isRecord(json) ? json.schema : undefined;
  if (!isSchema(schema)) {
    throw new Error(`${operationId}: JSON の requestBody が無い`);
  }
  return schema;
}

const ROLES: readonly string[] = ["user", "agent"];

/**
 * 有効な `security` の値から、呼べるロールの集合を引く。認証なし (空配列) は `undefined`。
 * `security` の要素は OR で、1 つの要素は `bearerAuth` のロールをちょうど 1 つ持つ。
 * 複数のロールを許すときは要素を分ける (`- bearerAuth: [user]` と `- bearerAuth: [agent]`)。
 * 空の要素・複数のロールを持つ要素・未知のロール・`bearerAuth` 以外のスキームは例外を投げる。
 */
export function parseAllowedRoles(
  operationId: string,
  security: unknown,
): Set<string> | undefined {
  if (!Array.isArray(security)) {
    throw new Error(`${operationId}: security が無い`);
  }
  if (security.length === 0) {
    return undefined;
  }
  const roles = new Set<string>();
  for (const requirement of security) {
    if (!isRecord(requirement)) {
      throw new Error(`${operationId}: security の要素がオブジェクトでない`);
    }
    const entries = Object.entries(requirement);
    if (entries.length === 0) {
      throw new Error(`${operationId}: security の要素が空`);
    }
    for (const [scheme, names] of entries) {
      if (scheme !== "bearerAuth") {
        throw new Error(`${operationId}: 未対応の security scheme: ${scheme}`);
      }
      if (!Array.isArray(names) || names.length === 0) {
        throw new Error(`${operationId}: bearerAuth のロールが空`);
      }
      if (names.length > 1) {
        throw new Error(
          `${operationId}: 1 つの security の要素に複数のロールがある`,
        );
      }
      const [name] = names;
      if (typeof name !== "string" || !ROLES.includes(name)) {
        throw new Error(`${operationId}: 未知のロール: ${String(name)}`);
      }
      roles.add(name);
    }
  }
  return roles;
}

/** operation の有効な `security` (operation のもの、無ければトップレベルのもの) から、呼べるロールの集合を引く。 */
function findAllowedRoles(operationId: string): Set<string> | undefined {
  const op = findOperation(operationId);
  return parseAllowedRoles(operationId, op.security ?? doc.security);
}

/**
 * hono の onError に渡す関数。hono 自身が投げる HTTPException (JSON として読めない body 等) も
 * 定義のエラー形式 `{ error: string }` で返す。
 */
export function handleError(err: Error, c: Context): Response {
  if (err instanceof HTTPException) {
    // bearerAuth のように、応答 (WWW-Authenticate を含む) を持たせて投げるものはそのまま返す。
    if (err.res !== undefined) {
      return err.getResponse();
    }
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

const REALM = "loms-claw";

function errorBody(error: string): components["schemas"]["ResponseError"] {
  return { error };
}

/**
 * operationId の `security` を定義どおりに検査する hono のミドルウェア。
 * 認証なし (`security: []`) なら何もしない。
 * それ以外は Bearer token を `registry` で引き、ロールが `security` に無ければ 403 を返す。
 * 通ったら `c.get("principal")` で呼び出し元を読める。
 */
export function secured(
  registry: TokenRegistry,
  operationId: OperationId,
): MiddlewareHandler<AuthEnv> {
  const roles = findAllowedRoles(operationId);
  if (roles === undefined) {
    return async (_c, next) => {
      await next();
    };
  }
  const auth = bearerAuth({
    realm: REALM,
    verifyToken: (token, c: Context<AuthEnv>) => {
      const principal = registry.resolve(token);
      if (principal === undefined) {
        return false;
      }
      c.set("principal", principal);
      return true;
    },
    noAuthenticationHeader: {
      wwwAuthenticateHeader: `Bearer realm="${REALM}"`,
      message: errorBody("Unauthorized"),
    },
    invalidAuthenticationHeader: {
      wwwAuthenticateHeader: 'Bearer error="invalid_request"',
      message: errorBody("Bad Request"),
    },
    invalidToken: {
      wwwAuthenticateHeader: 'Bearer error="invalid_token"',
      message: errorBody("Unauthorized"),
    },
  });
  return async (c, next) => {
    // 失敗したら bearerAuth が HTTPException を投げる。
    await auth(c, async () => {});
    if (!roles.has(c.get("principal").role)) {
      return c.json(errorBody("Forbidden"), 403, {
        "WWW-Authenticate": 'Bearer error="insufficient_scope"',
      });
    }
    await next();
  };
}
