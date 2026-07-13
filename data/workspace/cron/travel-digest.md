---
schedule: "0 7 * * 1"
maxTurns: 50
timeout: 600000
---

`travel/` 配下の旅行ノートの定期メンテナンス。`travel-note` skill (`.claude/skills/travel-note/SKILL.md`) の規約を前提に、以下を順に行え。

## 1. ノートの読み取り

`travel/` 配下の `.md` のうち `PLANS.md` と `index.md` を除く全ファイルの frontmatter (status / title / description / start_at / end_at / tags) を読み取る。

## 2. travel/index.md の全面再生成

`travel/index.md` を毎回ゼロから書き直す (前回内容の維持は不要)。構成:

- 冒頭に「このファイルは cron ジョブ travel-digest が自動生成する。手で編集しない。」の注意書きと、生成日時 (`date --iso-8601="seconds"` の値) を書く
- status 別 (planning / scheduled / ongoing / completed / cancelled) の一覧。各行は `- [<title>](<ファイル名>) — <description>` の形式。completed は start_at 降順に並べ、行頭に日付 (YYYY-MM-DD) を付ける。該当 0 件の status は見出しごと省略してよい
- 最後に「## 直近の旅行サマリ」: completed の直近 5 件について、各ノートの事後振り返りから実績 (ペース等) と申し送りの要点を 2〜3 行で要約する

## 3. PLANS.md の突合

- 「行きたい場所の種」の各項目を全ノートと突合し、既にノート化されている種は PLANS.md から除去する
- 直近 completed の「次回への申し送り」のうち、個別の旅行を越えて繰り返し効く知見があれば「よく使う旅行情報」へ昇格する。既存内容と重複する追記はしない。迷ったら昇格しない

## 4. frontmatter の規約チェック

各ノートの frontmatter に規約違反 (status が 5 値以外・日時が ISO 8601 `+09:00` 形式でない・`thread` / 日時の引用符欠落) があれば修正する。

## ルール

- 値の捏造は禁止。ノートに無い情報は書かない
- ノート本文 (計画・当日メモ・振り返り) の内容には手を入れない。触ってよいのは frontmatter の形式修正・index.md・PLANS.md だけ
- 変更が無い項目は何もしなくてよい。最終報告は変更点の列挙だけで簡潔に
