---
schedule: "0 7 * * 1"
maxTurns: 50
timeout: 600000
---

`travel/` 配下の旅行ノートの定期メンテナンス。`travel-note` skill (`.claude/skills/travel-note/SKILL.md`) の規約を前提に、以下を順に行え。後の手順は前の手順の修正結果を前提とする。

## 1. ノートの読み取り

`travel/` 配下の `.md` のうち `PLANS.md` と `index.md` を除く全ファイルの frontmatter (status / title / description / start_at / end_at / tags) を読み取る。

## 2. frontmatter の規約チェック

各ノートの frontmatter に規約違反 (status が 5 値以外・日時が ISO 8601 `+09:00` 形式でない・`thread` / 日時の引用符欠落) があれば修正する。以降の手順 (index 再生成・突合) は修正後の値で行う。

- 修正対象はこの列挙した形式違反のみ。値の妥当性への疑義は修正せず、最終報告に残す。疑義とみなす例: 実時刻どうしで `end_at` が `start_at` より前、日付がノート本文と明らかに矛盾。`T00:00:00+09:00` は「時刻未記録」の暫定値の慣習なので、それ自体は疑義に数えない
- frontmatter を修正したノートは、travel-note skill の規約どおり `timestamp` も現在時刻へ更新する

## 3. travel/index.md の全面再生成

`travel/index.md` を毎回ゼロから書き直す (前回内容の維持は不要)。構成:

- 冒頭に「このファイルは cron ジョブ travel-digest が自動生成する。手で編集しない。」の注意書きと、生成日時 (`date --iso-8601="seconds"` の値) を書く
- status 別 (planning / scheduled / ongoing / completed / cancelled) の一覧。各行は `- [<title>](<ファイル名>) — <description>` の形式。completed / cancelled は start_at 降順に並べ、行頭に日付 (YYYY-MM-DD) を付ける。start_at を持たないもの (planning 等) はファイル名昇順。該当 0 件の status は見出しごと省略してよい
- 最後に「## 直近の旅行サマリ」: completed の直近 5 件について、各ノートの事後振り返りから実績 (ペース等) と申し送りの要点を 2〜3 行で要約する

## 4. PLANS.md の突合

- 「行きたい場所の種」の各項目を全ノートと突合し、既にノート化されている種は PLANS.md から除去する。「ノート化されている」とは、行き先と目的の両方が同じ旅行を指すノートが存在すること (例: 「奥多摩湖 月見」ノートがあっても「奥多摩〜柳沢峠 新緑ツーリング」の種は別物として残す)。迷ったら消さない
- 直近 completed 5 件 (index.md のサマリと同じ範囲) の「次回への申し送り」のうち、個別の旅行を越えて繰り返し効く知見があれば「よく使う旅行情報」へ昇格する。昇格対象の例: ペース倍率の一般則・装備の定番化・施設や道路の恒常的な情報。非対象の例: 単発の TODO、特定の旅行にしか効かない注意。既存内容と重複する追記はしない。迷ったら昇格しない

## ルール

- 値の捏造は禁止。ノートに無い情報は書かない
- ノート本文 (計画・当日メモ・振り返り) の内容には手を入れない。触ってよいのは frontmatter の形式修正・index.md・PLANS.md だけ
- 変更が無い項目は何もしなくてよい。最終報告は変更点の列挙だけで簡潔に
