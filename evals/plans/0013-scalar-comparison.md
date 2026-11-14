# intern 値の整数比較から割り当てを除く

0012 の固定入力では、集合配送が native 37.96 ms / Wasm 31.53 ms、function が37.92 ms / 32.92 msで、tla-ts の13.75 ms / 10.80 msより遅かった。scalar の ring10万状態では native13.23 ms / Wasm16.32 ms、tla-ts33.59 msだった。元の証拠は `0012-collections-performance` に残す。

`Arena::equal` / `comparable` は、異なる同型の整数にも `cell()` を呼ぶ。cell は Ref 以外をエラーにし、比較ごとにエラー文字列を確保して破棄する。型の一致を確認した後、整数・真偽値の比較を直接返す。異なる型を FALSE に読み替えない。比較の意味、モデル、探索順、work の数え方は変えない。

条件は0012の10入力、warmup2・測定7・経路順序交互をそのまま使う。frontend、native process、Wasm request、起動を分ける。期待状態数・生成数、全49入力、反例・対照・ブラウザを確認する。過去 run を編集せず、新しい source snapshot と run に保存する。比較器に限った変更と、汎用 TLA evaluator との差は分けて解釈する。改善がなければ記録して採用を保留する。
