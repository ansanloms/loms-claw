import { createLogger } from "../../logger.ts";

const log = createLogger("ready");

/**
 * `emitter.once(event, ...)` で handler を実行し、その完了を Promise にする。
 *
 * handler が成功すれば resolve、throw (または reject) すれば reject する。
 * async リスナーの reject が unhandledRejection に流れて `start()` が
 * 決着しなくなるのを防ぐ。
 */
export function onceReady<Args extends unknown[]>(
  emitter: {
    once(event: string, listener: (...args: Args) => void): unknown;
  },
  event: string,
  handler: (...args: Args) => Promise<void> | void,
): Promise<void> {
  const ready = new Promise<void>((resolve, reject) => {
    emitter.once(event, (...args: Args) => {
      // handler の同期 throw も reject に回すため、async 経由で呼ぶ。
      (async () => await handler(...args))().then(resolve, reject);
    });
  });
  // ClientReady は login() の完了前に発火しうる。呼び出し側が await する前に
  // reject しても unhandledRejection にならないよう、受け手を先に付けておく。
  // login() が失敗して誰も await しない経路でも失敗が残るよう、受け手で
  // log.warn する (返すのは元の Promise なので、await した側には従来どおり
  // reject が届く)。
  ready.catch((e) => log.warn(`${String(event)} handler failed:`, e));
  return ready;
}
