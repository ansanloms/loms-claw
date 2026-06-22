/**
 * scope 単位の直列実行キュー。
 *
 * 同じ key に対して投入されたタスクを「投入順」に 1 件ずつ直列実行する。
 * 別 key のタスクは互いに干渉せず並行に走る。
 *
 * 用途: bot が応答中の scope (channel / thread) に届いた次のメッセージを、
 * 現在のターンが終わるまで待たせてから処理する (Claude Code が応答生成中の
 * 入力をキューに積み、ターン終了後に処理するのと同じ挙動)。これにより同一
 * セッションへの並行 query を防ぎ、session_id の競合を構造的に無くす。
 */

export class ScopeQueue {
  /**
   * key ごとの「チェーン末尾」。新しいタスクはこの末尾に連結され、直前の
   * タスクが settle してから実行される。値は内部用に reject を握り潰した
   * promise (チェーンが途中で切れないようにするため)。
   */
  private tails = new Map<string, Promise<void>>();

  /**
   * key に対してタスクを直列実行する。
   *
   * 直前のタスクの成否に関わらず後続タスクは必ず実行される (エラー隔離)。
   * 返り値は task 自身の結果を伝播する promise なので、呼び出し側は通常どおり
   * await / catch できる。
   *
   * @param key 直列化の単位 (例: channel / thread の ID)。
   * @param task 実行するタスク。
   * @returns task の解決値 / 例外をそのまま伝播する promise。
   */
  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();

    // prev は reject を握り潰してあるので、前段が失敗しても then は必ず走る。
    const run = prev.then(() => task());

    // チェーン末尾は reject を握り潰した版を保持する。これにより次に enqueue
    // されたタスクが「前段の失敗」で巻き込まれて未実行になるのを防ぐ。
    const guarded = run.then(() => {}, () => {});
    this.tails.set(key, guarded);

    // チェーン末尾が settle した時点で、まだ自分が末尾なら Map から消す。
    // 後続が積まれていれば tails は別の promise に差し替わっているので消さない
    // (identity 比較)。これで idle な key がメモリに残り続けるのを防ぐ。
    guarded.then(() => {
      if (this.tails.get(key) === guarded) {
        this.tails.delete(key);
      }
    });

    return run;
  }

  /**
   * key に実行中 / 待機中のタスクがあるか。
   *
   * enqueue 直前に呼べば「今このメッセージはキュー待ちに入るか (= bot が応答中
   * か)」を判定できる。tails に key が在ること自体が「未完了のチェーンがある」
   * ことを意味する (チェーン末尾が settle すると上の then で削除されるため)。
   */
  isBusy(key: string): boolean {
    return this.tails.has(key);
  }
}
