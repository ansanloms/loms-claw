# loms-claw API

loms-claw を「常駐する本体と、その周辺 (Discord・CLI・スマホ等)」の構成にするための、次期 I/F の設計。client から本体へは REST、本体から client へは SSE (Server-Sent Events) で渡す。

## 位置付け

この定義は `next` ブランチの I/F の定義である。実装は `packages/server/` で進めている。この定義の operation が全部実装済みとは限らない。main の実装と、main の `docs/api/` (0.1.0) は、この定義に対応しない。`info.version` は 0.2.0 で、`next` が main に入るまで release とタグを切らない。それまでは、壊す変更を入れても版を上げない。

## 決定事項

issue #278 の「決めること」と、そこから派生した論点の結論を次に示す。

| #   | 論点                 | 決定                                                                                                                                                                                                                                                                                            |
| --- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 出力の届け先         | スレッドの購読者全員に配る。中核がイベントを発行し、Discord も SSE の client も購読者になる。                                                                                                                                                                                                   |
| 2   | スレッド ID          | client が決める不透明な文字列とする。`PUT /threads/{threadId}` で登録してから使う。親は持たない。未登録のスレッドへの要求は 404 を返す。Discord の client はチャンネル ID をそのまま使い、応答するチャンネルとスレッドを最初の依頼の前に登録する。単一ギルドの検査は Discord の client が持つ。 |
| 3   | 承認待ちの台帳       | 中核へ移す。保留中の承認と質問を、SSE と `GET /approvals`・`GET /questions` で全 client に配るため。                                                                                                                                                                                            |
| 4   | パス空間             | 内部 API と client 向け API を同じパス空間に置く。OpenAPI は 1 本とする。                                                                                                                                                                                                                       |
| 5   | Discord への直接投稿 | 整理の対象外とする。Discord 専用の機能として扱う (下記「範囲外」)。                                                                                                                                                                                                                             |
| 6   | 版の表し方           | パスに版を入れない。`info.version` が正本である (#277 の方針を引き継ぐ)。SSE は追加のみで進化させ、client は未知のイベント種別とフィールドを無視する。                                                                                                                                          |
| 7   | 認証                 | Bearer token。ロールは `user` と `agent`。                                                                                                                                                                                                                                                      |
| 8   | 状態の取り直し       | 含める。SSE は切断中のイベントを再送しない。代わりに、実行中と待機中のターン (`GET /threads/{threadId}/turns`) と保留中の承認・質問を `GET` で取り直す。                                                                                                                                        |
| 9   | 設定の持ち場         | 設定は I/F に含めない。`model` と `effort` はターンを作る時に渡し、省いたら本体の既定値を使う。スレッドごとの設定は、`showThinking`・`active` (`activeChannelIds` を含む) と同じく client が持つ。                                                                                              |

## 接続

- ホスト: `127.0.0.1`。ポートは `config.json` の `claude.apiPort` で、既定値は `3000`。
- 認証: Bearer token (`Authorization: Bearer <token>`)。この定義の operation は全部、認証を要求する。

### ロール

ロールは `user` と `agent` の 2 つで、本体が token から引く。ロールはリクエストに乗らない。OAS の `security` はロール名を `bearerAuth: [user]` の形で書けるが、ロール名を宣言する場所は仕様に無い。そのため、ロール名の意味はこの README が定義する。

| token の種類   | ロール  | 誰が持つか                                                                     | 作り方と寿命                                                                                           |
| -------------- | ------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 利用者の token | `user`  | 利用者が使う client (CLI・Discord・スマホ等)。client ごとに別の token にする。 | 利用者が作る。本体はハッシュだけを持つ。                                                               |
| 一時 token     | `agent` | ワークスペースの Claude。ターンごと、定期実行タスクの実行ごとに渡される。      | 本体が乱数で作る。ターンの開始時に発行し、終了時 (完了・失敗・中止) に失効させる。メモリ上だけに持つ。 |

ロールで変わることを次に示す。

| 操作                                                                                | `user`                   | `agent`                                                              |
| ----------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------- |
| 承認・質問に答える (`POST /approvals/{approvalId}`・`POST /questions/{questionId}`) | できる                   | できない (403)                                                       |
| 定期実行タスクの再読み込み (`POST /scheduled-tasks/reload`)                         | できる                   | できない (403)                                                       |
| 常時許可の置き換え (`PUT /permissions/allow`)                                       | できる                   | できない (403)                                                       |
| ターンの中止 (`DELETE /turns/{turnId}`)                                             | できる                   | できない (403)                                                       |
| ターンを作る (`POST /threads/{threadId}/turns`)                                     | 注記なし、レート制限なし | 「本人の発話ではない」旨の注記 (出所は本体が書く) とレート制限が付く |
| それ以外                                                                            | できる                   | できる                                                               |

定期実行タスクの定義ファイルは `agent` が書けるので、定期実行タスクが作るターンも `agent` として扱う。

### 利用者の token

- 利用者が長い乱数で token を作る。平文は client 側だけに置く。例: `openssl rand -hex 32`。
- 本体は token の SHA-256 (hex 64 桁) だけを持つ。
  - 環境変数 `LOMS_CLAW_USER_TOKENS` に、`名前=ハッシュ` をカンマで区切って渡す。例: `cli=<hex>,discord=<hex>`。
  - 名前は `Turn` の `source` (`client:<名前>`) に入る。
  - 名前の重複・ハッシュの重複・空の名前・桁数の違うハッシュは書式不正で、本体は起動時にエラーで止まる。未設定と空も同じである。
- ハッシュは `agent` が書き換えられない経路 (compose の環境変数等) で渡す。`data/config.json` のように `agent` が書ける場所に置かない。理由: 置くと、`agent` がそれを自分の token のハッシュに書き換えることができる。
- client ごとに別の token にする。理由: token ごとに失効できる。

### エラー

- 401: token が無い、または無効。token が無い場合は `WWW-Authenticate: Bearer realm="loms-claw"`、無効な場合は `WWW-Authenticate: Bearer error="invalid_token"` を返す。
- 400: `Authorization` ヘッダの形式が不正。`WWW-Authenticate: Bearer error="invalid_request"` を返す。
- 403: ロールが足りない。`WWW-Authenticate: Bearer error="insufficient_scope"` を返す。

`WWW-Authenticate` は各 operation の応答定義には書かない。同じ定義が各 operation に並ぶためである。エラーの body はどれも `{ "error": string }` である。

### 承認・質問と依頼の出所

承認・質問に答える operation を置けるのは、認証があるからである。認証が無いと、ワークスペースの Claude が `curl` で叩いて、自分のツール実行を自分で承認できてしまう。

- 解決の結果は SSE の `approval.resolved`・`question.resolved` で流れる。`agent` は承認・質問の要求を SSE と `GET` で読めるが、答えられない。読むのは許し、答えるのだけを禁じる。
- `POST /threads/{threadId}/turns` の依頼の出所は、本体が token から引く。依頼の本文では名乗れない。
  - 注記とレート制限は `agent` の依頼にだけ掛ける。
  - レート制限の目的は暴走 (ループ・連鎖) を止めることで、攻撃を防ぐことではない。
- 常時許可 (`permissions.allow`) は `GET /permissions/allow` で読み、`PUT /permissions/allow` で置き換える。置き換えは `user` だけができる。決定事項 9 の「設定」には含めず、全体の設定とは別の資源として置く。

### 既知の限界

`agent` と本体が同じ OS ユーザで動くことから来る限界が 4 つある。この設計では防げない。4 つとも、この環境で試してはいない。先の 3 つは一般的な理解から挙げたものである。

- 通信の盗み見: `agent` が本体のコンテナの中で通信を傍受できれば、届いた利用者の token を読める。対策は `agent` の子プロセスを別の OS ユーザで動かすこと。
- 本体の改変: `agent` が本体のコードや起動設定を書き換えられれば、検査を外せる。対策は実行ファイルを `agent` から書けない場所に置くこと。
- client 側の token: client のコンテナが本体と分かれていることが前提になる。同じコンテナに置くと、`agent` が client の token を読める。
- 常時許可の保存先: 常時許可はワークスペースの `.claude/settings.json` の `permissions.allow` にある。main の `data/workspace/.claude/settings.json` が `Write`・`Edit`・`Bash` を常時許可していることは、ファイルで確かめた。`agent` が実際にこのファイルを書き換えられるかは試していない。`agent` がこのファイルを直接書き換えられる場合、`PUT /permissions/allow` の 403 では防げない。対策は、このファイルを `agent` から書けない場所に置くこと。

## スレッド

スレッドは続いていく会話の単位で、Claude のセッションとターンのキューを持つ。Discord の client では、チャンネル 1 つ、または Discord のスレッド 1 つが、この API のスレッド 1 つに当たる。

## 資源の ID

保存先を持たない資源は自然キーを ID にする。スレッドは client が決める文字列、定期実行タスクはファイル名を ID にする。これらに数値の連番は振らない。保存先が無いと、再読み込みのたびに連番が変わりうるためである。

ターン・承認・質問の ID は本体が採番する。どれもスレッドをまたいで一意である。形式は定めず、client は不透明な文字列として扱う。

## エラー応答

エラー時は HTTP ステータスコードと `application/json` の `{ "error": string }` を返す。RFC 9457 Problem Details 形式ではない。

## SSE の規約

`GET /events` が 1 本の接続で全イベントを配る。query の `threadId` で絞れる。スレッドごとのパスにしない理由は、承認と定期実行タスクのイベントを 1 接続で受けられるからである。

- イベントは追加のみで進化させる。既存のフィールドの意味や型は変えない。
- client は未知の `event`・未知のフィールド・列挙の未知の値を受け取っても落ちない。未知の `event` とフィールドは無視する。
- 切断中のイベントは再送しない。そのため `id` と `retry` は定義しない。
- 再接続したら、`GET /approvals`・`GET /questions`・`GET /threads/{threadId}/turns` で状態を取り直す。
- `threadId` で絞った購読には、`threadId` を持たないイベントは流れない。
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
