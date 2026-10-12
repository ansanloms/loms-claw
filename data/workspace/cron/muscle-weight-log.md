---
schedule: "0 9 * * *"
channelId: "1552474919693062184"
resumeSession: false
maxTurns: 15
model: sonnet
effort: low
---

体重・体脂肪率の推移記録を更新しろ。チャンネルには基本的に何も投稿しない (新規計測が無ければ完全に無言で終了する)。

1. `.claude/skills/google-health/SKILL.md` の手順で `token-status` を確認する。トークンが失効していて取得できない場合は何もせず終了する (再認可の案内は別 cron `google-health-token-check.yaml` が担当するので、ここでは触れない)。
2. 取得できるなら `datapoints weight` ・ `datapoints body-fat` を直近4日分 (`--from` を3日前、`--to` を明日) で取得する。
3. `memory/knowledge/muscle.md` の「体重・体脂肪推移」の既存の行 (日付) と比較し、まだ記載されていない日付の計測があれば `- YYYY-MM-DD: X.Xkg / Y.Y%` の形式で追記する (weightGrams は kg に換算する)。体重・体脂肪率のどちらか片方しか無い日はある方だけ書く。
4. 新規に追記した日付があった場合のみ、チャンネルに一言で追記内容を通知する (例: 「体重記録更新: 2026-09-28 89.8kg / 25.5%」)。メッセージの先頭に `<@474599131969617931>` を付けてメンションする。新規データが無ければ通知は出さない。
