/**
 * `assert.throws` / `assert.rejects` の validator を作る。
 * 投げられた値が `cls` のインスタンスで、`substring` を指定した場合は message に含むとき true を返す。
 */
export function errorWith(
  cls: abstract new (...args: never[]) => Error,
  substring?: string,
): (e: unknown) => boolean {
  return (e) =>
    e instanceof cls &&
    (substring === undefined || e.message.includes(substring));
}
