# loms-claw API

loms-claw を「常駐する本体と、その周辺 (Discord・CLI・スマホ等)」の構成にするための、次期 I/F の設計。client から本体へは REST、本体から client へは SSE (Server-Sent Events) で渡す。

## 位置付け

この定義は未実装の設計である。現行の API の正本は `docs/api/` (OpenAPI 3.1) であり、`api/internal-schemas.ts` はそこから生成される。この定義は生成パイプラインにつながっておらず、実装が追いつくまで `docs/api/` と並走する。

実装は含まない。`api/`・`core/`・`client/` のコードはこの定義を前提にまだ変わっていない。

## 決定事項

issue #278 の「決めること」と、そこから派生した論点の結論を次に示す。

| #   | 論点                 | 決定                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 出力の届け先         | スコープの購読者全員に配る。中核がイベントを発行し、Discord も SSE の client も購読者になる。                                                                                                                                                                                                                                                                                                                                         |
| 2   | スコープ ID          | 不透明な文字列とする。Discord の client はチャンネル ID をそのまま使う。親はスコープの属性として本体が保存する (`PUT /scopes/{scopeId}` の `parentId`)。スコープは `PUT /scopes/{scopeId}` で登録してから使う。未登録のスコープへの要求は 404 を返す。Discord の client は、応答するチャンネルとスレッドを最初の依頼の前に登録する。単一ギルドの検査は Discord の client が持つ。親を持つスコープを登録するときは、親を先に登録する。 |
| 3   | 承認待ちの台帳       | 中核へ移す。移さないと REST から承認に答えられず、他の決定と両立しない。                                                                                                                                                                                                                                                                                                                                                              |
| 4   | パス空間             | 内部 API と client 向け API を同じパス空間に置く。OpenAPI は 1 本とする。                                                                                                                                                                                                                                                                                                                                                             |
| 5   | Discord への直接投稿 | 整理の対象外とする。Discord 専用の機能として扱う (下記「範囲外」)。                                                                                                                                                                                                                                                                                                                                                                   |
| 6   | 版の表し方           | パスに版を入れない。`info.version` が正本である (#277 の方針を引き継ぐ)。SSE は追加のみで進化させ、client は未知のイベント種別とフィールドを無視する。                                                                                                                                                                                                                                                                                |
| 7   | 認証                 | 含める。Bearer token を使い、全 operation で必須とする。token は利用者用と agent 用の 2 種類で、agent の token は承認系を呼べない。                                                                                                                                                                                                                                                                                                   |
| 8   | 状態の取り直し       | 含める。SSE は切断中のイベントを再送しない。代わりに、実行中と待機中のターン (`GET /scopes/{scopeId}/turns`) と保留中の承認・質問を `GET` で取り直す。                                                                                                                                                                                                                                                                                |
| 9   | 設定の持ち場         | `session`・`model`・`effort` は本体がスコープごとに持ち、継承を解決して出所を `scope` / `parent` / `default` で返す。`showThinking` と `active` (`activeChannelIds` を含む) は client が持つ。                                                                                                                                                                                                                                        |

## 接続と認証

- ホスト: `127.0.0.1`。ポートは `config.json` の `claude.apiPort` で、既定値は `3000`。
- 認証: 全 operation で Bearer token (`Authorization: Bearer <token>`) を必須とする。

同じパス空間に置いたため、ワークスペースの Claude が `curl` で `POST /approvals/{approvalId}` を叩き、自分のツール実行を自分で承認できてしまう。現行の API は承認に答える operation を持たず、127.0.0.1 は認証なしで足りたので、この穴は今回の設計で初めて生じる。塞ぐために、token を 2 種類に分け、agent の token では承認系を呼べなくする。

- 利用者の token: 全 operation を呼べる。
- agent の token: ワークスペースの Claude に渡すもの。承認系 (`/approvals`・`/approvals/{approvalId}`・`/questions`・`/questions/{questionId}`・`/permissions/allow` の全メソッド) を呼ぶと 403 を返す。
- `POST /scopes/{scopeId}/messages` の「本人の発話ではない旨の注記」と依頼のレート制限は、agent の token による依頼にだけ適用する。利用者の token による依頼には付かない。

本体は 127.0.0.1 で待ち受けるため、別ホストの client を通す proxy やトンネル経由の要求も loopback に見える。そこで loopback の免除はやめた。

token が無い、または誤っている要求は 401 を返す。token は正しいが権限が足りない要求 (agent の token による承認系の呼び出し) は 403 を返す。

## エラー応答

エラー時は HTTP ステータスコードと `application/json` の `{ "error": string }` を返す。RFC 9457 Problem Details 形式ではない。`GET /health` の 503 だけは例外で、`{ "status": "unavailable" }` を返す。

## SSE の規約

`GET /events` が 1 本の接続で全イベントを配る。query の `scopeId` で絞れる。スコープごとのパスにしない理由は、承認と cron のイベントを 1 接続で受けられるからである。

- イベントは追加のみで進化させる。既存のフィールドの意味や型は変えない。
- client は未知の `event` と未知のフィールドを無視する。
- 切断中のイベントは再送しない。そのため `id` と `retry` は定義しない。
- 再接続したら、`GET /approvals`・`GET /questions`・`GET /scopes/{scopeId}/turns` で状態を取り直す。
- `thinking` イベントは、本体が常に流す。見せるかどうかは client が決める。
- 各イベントは `event` と、JSON 文字列の `data` からなる。

イベントの一覧は `GET /events` の `itemSchema` (`ResponseGetEvents`) に定義している。

## schema の additionalProperties 方針

`components/schemas/*.yaml` の `additionalProperties: false` は、リクエストボディの schema と、それが `$ref` で参照する schema にのみ付ける。レスポンス専用の schema には、将来のフィールド追加を許容するために付けない。

## 範囲外

- 画像の添付。
- webhook・位置通知・heartbeat。
- 音声。
- Discord アダプタの別プロセス化。
- Discord への直接投稿の経路。Discord 専用の機能であり、この I/F では整理しない。

## 未決事項

この定義では決めていない。

- 利用者の token の置き場所と、ワークスペースの Claude から読めなくする方法。`data/config.json` は `data/workspace/` の親にあり、読める可能性がある。
- agent の token の渡し方 (`query()` の環境変数)。
- cron の擬似スコープ (`cron:<ジョブ名>`) を誰が登録するか。
- `GET /health` の判定が Discord の gateway に結び付いていること (#278 の 1 章)。
- cron の送信先 `channelId` をスコープ ID に寄せるか (#278 の 4.3)。
- 回答 800 文字・thinking 1500 文字の区切りを SSE でも保つか (#278 の 4.7)。
- Discord アダプタが `showThinking` と `active` をどこに保存するか。
- 壊す変更の手順 (#276)。
