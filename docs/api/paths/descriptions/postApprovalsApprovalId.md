保留中のツール承認に答える。allowAlways は今回を許可したうえで、そのツールを常時許可に加える。成功すると 204 を返す。解決の結果は `approval.resolved` で配られる。`user` の token だけが呼べ、`agent` の token で呼ぶと 403 を返す。
