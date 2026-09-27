/**
 * create/update サブコマンドの `--body` (JSON 文字列) の検証と、create の応答 (Operation) の `done` 検査。
 * ネットワークに出る前に JSON として不正な入力を弾くために分離してある。
 */

/** `--body` の値を読む。`-` のときは標準入力を全部読む (ネットワーク非依存だが Deno.stdin に依存するためテスト対象外)。 */
export async function readBodyArg(value: string): Promise<string> {
  if (value === "-") {
    return await new Response(Deno.stdin.readable).text();
  }
  return value;
}

/** `--body` の文字列を JSON オブジェクトとしてパースする。パース不能・オブジェクトでない場合は例外。 */
export function parseBodyArg(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("--body が JSON として解釈できない");
  }
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
  ) {
    throw new Error("--body は JSON オブジェクトで指定する");
  }
  return parsed as Record<string, unknown>;
}

/**
 * create/update/batch-delete の応答 (Operation) のテキストを検査する。
 * `error` フィールドがあれば (google.longrunning の失敗形) 例外を投げて失敗として扱う。
 * `error` が無く `done` が `false` なら警告メッセージを返す (処理未完了の可能性)。
 * 応答が JSON として解釈できない、`error`・`done` のいずれも無い、または `done` が `true` の場合は undefined (警告なし)。
 * `error` 時は例外を投げるため、呼び出し側は応答本文を stdout へ出力してからこの関数を呼ぶこと
 * (先に呼ぶと `error` 時に応答が一切出力されない)。
 */
export function checkOperationDone(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const rec = typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)
    : undefined;
  if (rec === undefined) {
    return undefined;
  }
  if (typeof rec.error === "object" && rec.error !== null) {
    const err = rec.error as Record<string, unknown>;
    throw new Error(`応答の error: code=${err.code} message=${err.message}`);
  }
  if (rec.done === false) {
    return "応答の done が false (処理が未完了の可能性がある)";
  }
  return undefined;
}
