# 共通オラクルで3言語の実装を動かす

## 仮説

同じ finite model と portable trace を TS / Rust / Go に渡し、各言語の mutable SUT を実行しても同じ判定・観測・反例を得られる。0006 の保存観測を返す Driver から進め、各 SUT は操作だけを受け取り、モデル表や期待観測を参照しない。

## 固定条件

- 仕様は既存 `examples/counter-model.ts`。id は a / b、amount は1、pending は最大2の有限領域。compile は depth20 / states1000で閉包を要求する。
- 正常版と既知の人工故障5種: persistence、deduplication、late-retry、fifo-only、drop-ignored。TS は既存実装を使用し、Rust / Go は独立した mutable 実装を書く。checker は既存 TS、Rust native、Go/Wasm。
- oracle は仕様の deterministic initial / step から生成する。SUT の出力を oracle にしない。全 backend が同一 bundle の finite model と trace を読み、有限モデル照合と保存オラクル再生の2経路で新しい SUT を実行する。
- 開発 seed201〜205、確認 seed211〜220。alternating corpus、各128 reset/step、最大深さ12。有限モデル領域外の操作は生成しない。各 seed の検出・未検出を保存し、未検出を除外しない。
- 固定対照: 空操作、add→crash→restart、同一 id への2回 add / 3回 add、send a→send b→deliver1→drop0→add a、send a→send b→drop0→deliver0→add b。5故障の固定対照でそれぞれ step3 / 2 / 3 / 5 / 5 の mismatch、正常版は全件 matched を必須にする。
- `status`、`checkedSteps`、`actual`、`expected`、`trace`、実 reset / step 数を比較する。例外、invalid、欠落、途中終了は成功へ変えない。oracle がモデルと一致しない bundle は SUT を実行する前に拒否する。
- 各故障の最初の witness を保存し、同じ仕様から作った oracle を3言語の故障版で再生し直し、正常版も通す。元の suite / witness を再生成せず、digest と source fingerprint を確認して保存データを使う。

## 記録と解釈

plan を結果を見る前にコミットする。run directory は排他的に作成し、manifest、入力 bundle、判定 matrix、witness、result、ソース digest と toolchain を残す。開発と確認を別 run にし、上書きせず台帳へ追記する。CI の同じ seed の再実行は回帰確認であり独立実験には数えない。

人工故障の移植・共有形式・実行再現性の評価であり、未知バグ発見、OS 障害注入、任意プログラムの refinement、checker の独立した3実装、性能比較を主張しない。Rust native と Go は同じ Rust checker を使い、TS checker が独立した比較対象になる。有限領域の graph 閉包と全履歴を検査したことは区別する。
