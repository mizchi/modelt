# Rust safety の状態確保を減らす

0010 で literal を decode 時に検証した。ring10万状態は native29.45→18.22ms、Wasm29.88→21.10ms。grid100は native4.71ms、Wasm4.23msで、tla-ts4.23msに対する改善が残らなかった。

次は状態を連続格納し、visited の hash bucket から state index をたどる。同じ hash でも型付き state 全体を比較する。hash が衝突する対照を private store のテストへ追加する。node は親・action index・深さを保持し、文字列と trace は反例時に復元する。current / next の作業配列を探索中に再利用し、successor ごとの vector を作らない。

公開 IR、判定、state / generated / depth / work、反例の順序を維持する。同じ差分 corpus・TLC 対照・browser・consumer を確認する。baseline 0009 と literal 改善0010を編集せず保存した上で、同じ6入力・warmup2・測定7・交互順を使う。入力や測定数は結果を見て変更しない。

この変更は格納表現の最適化で、Rust と TypeScript の言語差を単独で測る実験ではない。全状態を展開できないモデル、liveness、並列 BFS の性能は今回も範囲外。
