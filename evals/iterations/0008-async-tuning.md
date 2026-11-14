# 非同期履歴と再利用・探索の評価

[0008 の計画](../plans/0008-async-tuning.md) に従い、未確定の操作を含む履歴、障害境界、モデル再利用、trace 蓄積、縮小、feedback 探索を検査した。開発 seed231〜235と確認 seed241〜260は同じ実装 snapshot を使った。

## 履歴と障害パターン

invoke / return / fail / unknown / cancel を記録する wire format と recorder を追加した。unknown / cancel は未確定の marker で、後から確定応答を記録できる。確定失敗は作用なし、未確定操作は線形化または省略する。予算切れは inconclusive とし、成功に数えない。

Node の実際の非同期 counter を6 schedule × 正常・lost-update で動かした12履歴、応答喪失・cancel・確定失敗・遅い応答・予算境界の20対照、保存境界の10履歴を比較した。合計42履歴で、TS 独立 checker と Rust native / Wasm / Go の全結果が一致した。TS に対する比較は126件。Rust native / Wasm / Go は同じ Rust checker を使うため、4つの独立した実装ではない。

障害パターンは以下を保存した。

- 永続値と dedup 情報の before / value-only / seen-only / committed、および ack-before-persist。crash を epoch の変更として記録し、旧 process の未完了操作を復旧後へ移せないようにする。10対照中、壊れた保存方式の3対照を拒否した。
- 遅延配送された古い fencing token と、期限5の直前4・同時5・直後6の lease。古い token の受理と、期限ちょうどでの誤った受理を検出した。
- 障害後3 tick の recovery。配送して回復した場合と、配送を止めて inconclusive となる場合を区別した。有限の観測窓であり、fairness や無限の liveness の証明ではない。
- 合成モデルの共有容量違反と、それを防ぐ guard の対照。queue + storage の合成では、再配送で二重加算する実装を拒否した。
- id の対称な置換と独立操作の交換。別途、仕様を緩めると同じ誤実装を受理する対照も保存した。checker 間の一致だけでは、モデルの妥当性を保証できない。

不正な id・未知フィールド・不正 Unicode・確定応答の二重記録は各輸送経路で拒否する。保存 JSON を Go へ渡す場合は原文を検証する API を使い、通常の JSON decode が落とす情報も検査する。

## 探索の結果

既存の alternating と counter 固有の操作関係 feedback を、各 seed512 reset/step、最大深さ16で比較した。feedback は操作種別間の関係、配送位置、retry 回数などを使う実験で、汎用の happens-before coverage ではない。確認 run の結果は以下。

| 故障          | alternating / 20 | feedback / 20 | feedback のみ検出 | alternating のみ検出 |
| ------------- | ---------------- | ------------- | ----------------- | -------------------- |
| persistence   | 20               | 20            | 0                 | 0                    |
| deduplication | 20               | 20            | 0                 | 0                    |
| late-retry    | 20               | 20            | 0                 | 0                    |
| fifo-only     | 15               | 14            | 3                 | 4                    |
| drop-ignored  | 14               | 19            | 6                 | 1                    |

正常版は各方式800 case、誤検出・無効入力は0。生成時間の合計は13.90msから49.44msへ増えた。全故障・正常版の SUT/checker 実行時間は68.17msと68.08ms、実際の reset/step は55,995回と56,644回だった。要求予算は同じでも、故障検出時に停止する prefix が異なる。生成込みの費用は約82.07msと117.51msで、検出の増加を無償とは扱わない。

開発 run は42 witness、確認 run は182 witness を保存し、TS の故障版で失敗・正常版で通過することを再現した。5故障の代表反例は保存 oracle を使い、TS / Rust / Go の実 SUT と2つの照合経路でも再生した。非同期 SUT の schedule 制御は Node の counter であり、Rust thread / Go goroutine の scheduler を制御した実験ではない。

feedback は実験用に保留する。drop の検出は増えたが、fifo の後退と生成費用があり、既定方式の置き換えを支持する結果ではない。20 seed・既知の人工故障の範囲で、未知バグの検出率は未評価。

## 再利用と trace 蓄積

有限モデルを load 時に索引化し、同じ instance の handle で再利用する API を追加した。解放済み handle、使用中の解放、別 instance への binding の混同を検査した。以下は5操作の同じ正常 trace を batch1 / 64で照合する API 全体の中央値、単位は ms。warmup3・測定9、順序を交互にし、全結果の一致を前提にした。

| model   | batch | TS prepared | Wasm wire reload | Wasm loaded | Go/Wasm wire | Go/Wasm loaded |
| ------- | ----- | ----------- | ---------------- | ----------- | ------------ | -------------- |
| mutex49 | 1     | 0.0556      | 0.4762           | 0.0666      | 2.4640       | 0.2261         |
| mutex49 | 64    | 2.4298      | 3.4249           | 3.0363      | 13.5039      | 11.4626        |
| ring512 | 1     | 0.0093      | 0.5783           | 0.0164      | 3.9335       | 0.0641         |
| ring512 | 64    | 0.4346      | 1.2321           | 0.6841      | 6.7529       | 2.8775         |

Wasm load 自体の中央値は mutex49で0.575ms、ring512で0.742ms。Go では2.121ms、3.752msだった。Wasm startup は Node で1.97ms、Go で77〜103ms、Go child process 全体は362〜910ms。startup / load / 定常照合を混ぜず、言語の計算性能の比率には使わない。

wire reload と loaded は同じ indexed checker を使うため、この比較が測るのは主に model の転送・検証・索引化の再利用である。索引化そのものの改善量を分離した比較ではない。反復利用する caller 向けに handle を採用し、TS を既定のまま維持する。batch が大きい場合には再利用の差が小さくなり、TS prepared が最速だった。

trace は各 step の prefix コピーを内部 buffer へ変更した。変更前の `b197ffd:src/conformance.ts` を原文・digest 付き fixture に固定し、同じモデル・SUT・equality helper・返却結果で比較した。

| 操作数 | prefix copy 中央値 ms | buffer 中央値 ms |
| ------ | --------------------- | ---------------- |
| 64     | 0.0293                | 0.0232           |
| 4096   | 6.6148                | 0.9488           |

4,096操作で約7倍の短縮を確認した。失敗 prefix と返却 snapshot の独立性をテストし、buffer を採用した。full result は保持しており、summary-only API やメモリ使用量の測定は含まない。

## 縮小

producer / consumer の依存閉包削除とモデルの preflight を optional に追加した。元の単一削除候補、failure signature、最終の実 SUT 再現は維持する。

固定した fifo-only 反例では両方式とも同じ4操作へ縮小した。通常削除は19検査・無効候補7件、causal + preflight は16検査・無効候補0件・preflight24回だった。SUT 操作数は両方58回で、今回の結果から SUT 費用の削減は主張しない。elapsed は0.457msと0.260msだが、単一反例の小さい測定であり採用の根拠にしない。

無効な操作を副作用のある SUT へ送らずに済む点を採用理由とし、依存 callback を書く費用もあるため opt-in にする。全体最短や、すべてのモデルでの高速化は保証しない。

## 証拠と判断

[development](../runs/0008-async-development/result.json) と [confirmation](../runs/0008-async-confirmation/result.json) に入力、全 trial、未検出、反例、障害履歴、性能の生サンプル、digest を保存した。source snapshot は `193deab1df98e45f5bbef1549183b2977a385f75`、source version は `20de57252d473544011e9fc17ebf87be2c4bfcfd624f7e65f865518c913ca4df`。両 run の138ソースの digest はその commit と一致する。Node24.22.2 / Rust1.98.0 / Go1.26.2、macOS arm64 の1台で測った。

保存した非同期履歴・障害境界・反例を再生し、性能値は再測定して元の証拠へ上書きしない。別の一時ディレクトリへコピーした history 証拠の改変は digest guard が拒否した。元の run は変更していない。厳密な再生では上の source commit を使う。

```sh
just async-test
just async-replay evals/runs/0008-async-confirmation
```

採用するのは履歴の意味論、反復利用向け handle、trace buffer、optional な preflight / 依存縮小。feedback は実験のまま残す。次は別の実プロジェクトでモデル・Driver の作成費用を測り、追加検出と診断時間を確かめる。新しい探索仮説には確認用 seed261以降を予約し、今回の確認 seed を再利用しない。
