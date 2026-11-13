# 共通オラクルと実 SUT の3言語比較

[0007 の計画](../plans/0007-shared-oracle.md) に従い、同じ finite model と保存 oracle で TS / Rust / Go の mutable counter を実行した。0006 の記録済み観測を返す互換性テストから、実装に操作を渡して新しい観測を得る比較へ進めた。

## 入力と実装

仕様は既存の `examples/counter-model.ts`。oracle は deterministic initial / step のみから生成し、SUT の出力を使わない。id a / b、amount1、pending 最大2の領域で、有限表は56状態・432辺で閉じた。

TS は既存の実装・fault wrapper、Rust と Go は独立した mutable 実装を使う。Rust / Go の SUT module は期待観測やモデル表を受け取らない。各言語で新しい SUT を作り、有限モデル照合と保存 oracle 再生の2経路を実行する。Rust native と Go/Wasm は同じ checker のため、独立した3種類の checker を確認したわけではない。TS は既存 checker を使い、元の executable model に対する結果とも突き合わせた。

## 結果

| phase        | seed     | case | 正常版の検査 | 言語間比較 | 差異 |
| ------------ | -------- | ---- | ------------ | ---------- | ---- |
| development  | 201〜205 | 71   | 426          | 1,704      | 0    |
| confirmation | 211〜220 | 136  | 816          | 3,264      | 0    |

case は各 seed の13列に、固定対照6列を加えた数。正常版の検査は case × 3言語 × 2経路、言語間比較は case × 6 variants × 2経路 × TS に対する他2言語。status / actual / expected / checkedSteps / 全 trace と reset / step 数が一致した。正規化した全実行結果の digest も3言語で同じだった。

確認 run の故障対照は persistence が step3、deduplication が step2、late-retry が step3、fifo-only と drop-ignored が step5で mismatch。5つの witness の保存 oracle を読み直し、同じ3言語・2経路の故障版で失敗し、正常版で通ることを再現した。故障版の実観測は oracle とは別の `result` として保存する。

ランダム列だけの検出は以下。固定対照を混ぜて各 seed の検出率を上げて見せない。

| 故障          | 検出 seed / 10 | 検出列 / 130 |
| ------------- | -------------- | ------------ |
| persistence   | 8              | 19           |
| deduplication | 10             | 57           |
| late-retry    | 10             | 19           |
| fifo-only     | 3              | 3            |
| drop-ignored  | 4              | 4            |

有限表が閉じても、実装の隠れた queue / retry 状態を全履歴で検査したことにはならない。今回の budget のランダム列だけでは、配送・drop の故障を多くの seed で見逃した。固定の障害履歴を回帰対照として併用する。

## 証拠と再現

run は [development](../runs/0007-shared-development/result.json) と [confirmation](../runs/0007-shared-confirmation/result.json)。実装 snapshot は `42e875a205d3c92997d31032ce8a83b08d1f4dc9`、source version は `9877f526a4bd0eb8f221974e7f19bb34eb416b9a05bb92f1fe06831dea0e80a3`。70ソースの digest、suite、matrix、witness、バイナリ digest と toolchain を保存した。confirmation の dirty paths は development の証拠と台帳だけで、比較用ソースは同一だった。

Node24.22.2、Go1.26.2、Rust1.98.0、macOS arm64。自動評価の全体 wall time は development 約4.9秒、confirmation 約8.9秒。TS の追加参照検査、process / Wasm startup、JSON と SUT / checker の費用を含み、言語の速度比較には使わない。

期待観測を改変した suite は、TS と Rust / Go の各 runner がモデルとの不一致として拒否した。保存 witness を別ディレクトリへコピーして改変した場合も、再生の digest guard が拒否した。元の保存データは変更していない。

```sh
just cross-test
just cross-replay evals/runs/0007-shared-confirmation
```

過去 run の厳密な再生では記録したソースを checkout する。CI は同じ確認 seed を regression として再実行し、新しい独立実験へ加算しない。[利用手順](../../docs/shared-oracle.md) を参照。

## 判断

finite model と portable trace を共有し、言語固有の Driver / 実装を接続する形を採用する。3言語で期待観測を作り直す必要がなく、故障時の実観測・prefix・再現手順も共有できた。

今回の故障は既知の人工故障で、未知バグ発見や実プロジェクトの検出率は未評価。amount1・2 ids・queue2の範囲外、OS の実障害、並行 thread / goroutine の制御、liveness、性能優位は主張しない。次は別の実プロジェクトと、配送・再試行の履歴 coverage を選ぶ生成戦略で追加の有効性を確認する。
