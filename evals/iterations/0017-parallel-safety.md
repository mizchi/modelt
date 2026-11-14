# 常駐poolによるTLA検査の並列化

独立したTLA検査を常駐poolへ接続した。混合88件の全件完了時間は、nativeの1 worker・FIFOが1,373 ms、8 worker・費用順batchが286 msだった。Wasmは1,919 msから420 msとなった。全288サンプルで、逐次実行と判定・計数・反例を含むresultが一致した。

実装は[事前計画](../plans/0017-parallel-safety.md)に従い、`e0b1cd4aad5e9d095ff24a780bbf862717b33faa`へ固定して測定した。開始時のworking treeはclean。source fingerprintは`803bb50b961378b28e04820f642fdedebe82a897376d3d2a43eb27ab25b59769`。Rust checker本体とnative/Wasm binaryは0016から変更していない。

## worker数と配置方式を比較する

Apple M5、arm64、利用可能CPU数10、Node v24.22.2。0016の11モデルを8巡する混合88件と、grid-20を反復する小task256件を使った。各条件は2回ウォームアップ後7回測定した。各欄は全件完了時間の中央値 [最小, 最大]、単位はms。

| backend | workers |                   混合FIFO |            混合費用順batch |          小task FIFO |         小task batch |
| ------- | ------: | -------------------------: | -------------------------: | -------------------: | -------------------: |
| native  |       1 | 1373.06 [1347.15, 1714.03] | 1356.03 [1345.71, 2602.32] | 33.79 [33.44, 62.85] | 32.48 [32.31, 41.65] |
| native  |       2 |    757.72 [747.26, 988.81] |    712.30 [708.23, 817.78] | 18.60 [17.84, 21.12] | 17.31 [16.14, 17.89] |
| native  |       4 |    484.93 [477.98, 514.53] |    418.16 [413.76, 436.46] | 11.68 [11.08, 15.68] |   9.63 [9.22, 11.27] |
| native  |       8 |    378.38 [353.81, 411.46] |    285.71 [281.20, 300.61] |   9.18 [8.19, 10.32] |    7.25 [6.76, 8.83] |
| Wasm    |       1 | 1919.32 [1899.22, 2032.18] | 1931.49 [1899.73, 1980.85] | 46.70 [46.24, 51.43] | 41.64 [41.42, 44.12] |
| Wasm    |       2 | 1082.12 [1069.37, 1113.30] | 1034.77 [1023.73, 1132.96] | 24.71 [23.91, 26.80] | 22.72 [21.45, 23.15] |
| Wasm    |       4 |    699.38 [684.12, 710.20] |    584.17 [578.93, 670.53] | 13.63 [12.65, 14.48] | 12.19 [11.71, 14.25] |
| Wasm    |       8 |    531.43 [521.82, 597.16] |    420.48 [411.99, 470.19] |  10.10 [9.40, 10.89] |   9.77 [9.25, 10.16] |

FIFOのまま1 workerから8 workerへ増やすと、混合batchはnativeで約3.63倍、Wasmで約3.61倍速かった。さらに同じ8 workerで費用順batchを使うと、nativeの時間が約24.5%、Wasmが約20.9%減った。1 worker・FIFOからの総合的な速度比はnative約4.81倍、Wasm約4.56倍で、並列化と配置方式の両方の効果を含む。

小taskの通信batch数は256から16へ減った。8 workerのnativeは9.18 msから7.25 msへ短縮した。一方、Wasmの8 workerでは10.10 msと9.77 msで測定範囲が重なる。Wasmの1 worker・混合batchも費用順で改善していない。配置方式による改善を全条件へ一般化しない。

## 全件完了時間と待ち時間の違い

費用順配置は長いtaskを先に配るため、混合batchの小taskが後回しになる。8 workerの配布待ちp95の中央値は、nativeでFIFOの217.46 msに対し費用順が281.68 ms、Wasmで291.21 msに対し415.67 msだった。全件完了時間の短縮と、各taskの早期実行は同じ目的ではない。

配布待ちは、親の待ち行列からbatchとして配布するまでの時間。batch内で前のtaskを待つ時間やworkerへの転送時間は含めない。反例を早く見つける目的で費用順を採用する判断は、この正常モデル群の測定からは行わない。配置方式は呼び出し側が明示する。

## pool起動とメモリ予算

poolの起動・IR登録費用は、nativeが1/2/4/8 workerで17.45 / 19.03 / 24.00 / 35.69 ms、Wasmが17.60 / 18.19 / 20.98 / 32.46 msだった。上の表は起動後の再利用時を測る。親でのsourceコンパイル、親のNodeプロセス起動、計画作成、ログ保存、RSS採取は表の時間に含めない。0016のsource解析・起動込みの値と直接比較しない。

worker数別の費用倍率はウォームアップの校正値から求め、7回の測定結果から再選別していない。混合batchを時間予算30 s、メモリ予算512 MiBで計画すると、両backendとも1 workerを選んだ。8 GiBでは8 workerを選び、4つの選択結果で88件すべてのresultが再現した。時間予算0では`insufficient-budget`となり、実行結果は88件を未完了として保持した。

メモリ見積りは保守的な初期値で、OSの強制上限ではない。観測した8 workerの最大RSS snapshotはWasmがNode全体で約1,209 MiB、nativeがNode約276 MiBとRust子プロセス合計約112 MiBだった。これはbatch終了後の観測であり、探索中のpeakではない。親の校正用instanceや過去batchの確保領域も含み、backend固有のメモリ効率の比較には使わない。

## 実装と結果の契約

共通の`planSchedule` / `runSchedule`と型を`@mizchi/modelt/scheduling`へ追加した。計画には時間・メモリ・worker数、taskの費用見積り、FIFOまたは費用順batchを指定する。実行側は空いたworkerへ次のbatchを渡し、結果を入力task順に返す。source解析やsolverへ依存しない独立entryとして、配布consumerでも検査した。

Node adapterはworker_threadsごとに独立Wasm instance、または常駐Rust native子プロセスを持つ。nativeのworker数はRust thread数ではなく子プロセス数。browser adapterは独立Wasm instanceとmessage passingを使う。Chromiumでcross-origin isolationなしの2-worker実行と再利用を確認した。

IRは親で一度コンパイルしてworkerのTS層へ登録する。Rust ABIへprogram handleは追加していないため、各checkではIRのserialize / deserialize費用が残る。結果のキャッシュは行わず、毎回モデルを探索する。1モデル内部のBFS・temporal検査は逐次のまま。

`executionStatus: "complete"`は全taskの応答が揃ったという意味。各taskの`bounded`、`empty`、invariant / property / liveness violation、assumption violation、モデル評価エラーを保存し、安全性の合格へ変換しない。worker終了、応答の欠落・重複は未完了taskとdispatchエラーとして残す。明示的な時間予算はdispatch時のsoft budgetで、進行中batchを強制終了しない。

## 証拠と採用判断

[本測定](../runs/0017-parallel-safety/result.json)に288サンプル、うち集計対象224サンプルを保存した。各測定の結果digestと配布ログは[samples.jsonl](../runs/0017-parallel-safety/samples.jsonl)、逐次結果は[expected.json](../runs/0017-parallel-safety/expected.json)、予算による選択と実行は[adaptive.json](../runs/0017-parallel-safety/adaptive.json)にある。正常モデルの反復はthroughput測定であり、追加の状態coverageや未知バグの検出として数えない。

[replay](../runs/0017-parallel-replay/result.json)は保存サンプル288件のdigest・task ID・配布・結果を確認し、4-workerの両backendで1,376件のtaskを再実行して一致した。replayを独立した性能測定へ加えていない。[検証ログ](../runs/0017-verification/result.json)には通常検査、pool故障対照、既存TLC回帰139件、実ブラウザ、評価・replay、配布consumer、Rust実験、mutationを保存する。共有テストはVitest / node:test各71件。mutationは既存の対象で95.4%、survivorが5件残る。scheduler自体のmutation scoreではない。

独立した検査を常駐poolへ配る方式を採用する。全件完了時間を優先する用途には費用順batchを選べるようにし、FIFOも残す。Node / browser adapterは`evals/parallel-safety`の試作として維持する。次の評価では、探索中のpeakメモリ、反例の早期発見を目的とする優先順位、Rust側のprogram登録によるIR転送費用を分けて測る。利用方法とAPIの範囲は[実行ガイド](../../docs/scheduling.md)を参照。
