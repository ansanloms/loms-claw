# jartic-traffic-jam-forecast

JARTIC (日本道路交通情報センター) が公開する渋滞「予測」データを取得する skill。`www.jartic.or.jp` の JSON を curl で取得し、路線名・年月・都道府県を `jq` で絞り込む。

## できること

- ゴールデンウィーク・お盆・年末年始・行楽期の高速道路の渋滞予測、ピーク日時の把握
- ◯◯祭りなどイベント周辺の一般道渋滞と迂回路の把握

## 対象外

- 現在の実況交通量・渋滞長 (返るのは将来の予測であって今この瞬間の実況ではない)

現在の交通量が必要な場合は [jartic-traffic-volume](../jartic-traffic-volume/) を使う。

## 発動する場面

行楽期の高速道路の渋滞予測やピーク日時、イベント周辺の一般道渋滞と迂回路を聞かれたとき。

## 導入

```sh
apm install ansanloms/skills/jartic-traffic-jam-forecast --target claude
```

詳細は [SKILL.md](./SKILL.md) を参照。
