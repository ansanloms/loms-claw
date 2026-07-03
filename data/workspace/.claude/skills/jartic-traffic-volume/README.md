# jartic-traffic-volume

指定の道路・エリアの現在の交通量を JARTIC 交通量 API (国土交通省) から取得する skill。地名・道路名を国土地理院ジオコーディングで緯度経度へ変換し、WFS 2.0.0 GetFeature を BBOX と時間コードで叩く。

## できること

- 「国道◯号の今の交通量」「◯◯付近の混雑」など、特定の道路や地点の最新交通量の取得

## 対象外

- 県道・市道 (対象は高速自動車国道と一般国道のみ)
- 将来の渋滞予測 (予測は [jartic-traffic-jam-forecast](../jartic-traffic-jam-forecast/) を使う)

## 発動する場面

特定の道路や地点の最新交通量を聞かれたとき。

## 導入

```sh
apm install ansanloms/skills/jartic-traffic-volume --target claude
```

詳細は [SKILL.md](./SKILL.md) を参照。
