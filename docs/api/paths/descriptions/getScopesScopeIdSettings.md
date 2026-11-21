指定スコープの設定を返す。session、model、effort は本体がスコープごとに持つ。model と effort は自身、親、デフォルトの順に継承を解決し、値の出所を source で返す。
