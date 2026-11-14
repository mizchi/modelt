# intern table の整数キーを直接 hash する

0013 は整数比較の割り当てを除き、集合配送の native を37.96 msから17.89 ms、functionを37.92 msから20.80 msへ短縮した。ただし同時測定の tla-ts は17.18 ms / 11.80 msで、function は遅い。Wasm も未達。結果は `0013-scalar-performance` に保存した。

次の候補は、intern table の派生 Hash が整数・discriminant・lengthを多数の小さい write として処理する費用。private な table に、整数を直接混ぜる64 bit hasherを使う。文字列の bytes も順に混ぜる。hash は同一性の証明に使わず、HashMap が Cell 全体の Eq で衝突を判別する。状態表の比較・wire・探索順・work は変えない。

0012 / 0013 と同じ10入力、warmup2・測定7・順序交互。全49入力・14反例・対照を直前の保存結果と完全比較し、native / Wasm / tla-ts / TLC とブラウザ・配布 consumer を確認する。scalar と文字列を含む既存ケースの後退も確認する。速度差と追加依存なしの保守費用で採用を判断し、別 run へ保存する。暗号的 hash の用途には使わない。
