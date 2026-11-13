# テスト手法の調査

調査日: 2026-11-14。現在の一次資料と近年の研究から、この試作に採用できるものを整理した。ここで挙げる手法すべてが新規研究という意味ではない。

以下の「採用済み」は試作に実装したという意味。[初回の比較結果](../evals/iterations/0000-pilot.md) を採用判断の材料とする。統合テストが通ったことと、既存テストへの追加価値が確認できたことを区別する。

## 優先する拡張

| 手法                                | この試作での判断                         | 次に実装するもの                                               |
| ----------------------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| Model-based PBT + shrinking         | 採用済み                                 | 無効操作の棄却率が高い場合は stateful commands に切り替える    |
| Deterministic simulation testing    | 操作としての配信・破棄・クラッシュを採用 | 仮想時計、乱数、ストレージ、通信を注入するホスト契約           |
| Metamorphic testing                 | ID の全単射置換をテスト済み              | ノード名置換、独立操作の順序交換を、成立条件付きで追加         |
| Source mutation testing             | mutator を実行済み                       | surviving mutant と kill matrix から観測・生成器の弱さを調べる |
| SMT による入力生成                  | 実際の Wasm で採用                       | 境界値、到達条件、合成モデル間の制約から具体例を作る           |
| Feedback-guided schedule generation | 次の探索エンジンの有力候補               | 分岐率に加えてモデル遷移とイベント因果順序を記録する           |
| Concurrent history checking         | 次の独立モジュール候補                   | invocation/response、区間の実時間順序、保留操作を扱う          |
| Coverage-guided native fuzzing      | Node 向け任意アダプター候補              | まず codec / trace parser の corpus を共有する                 |

## Fest: 振る舞いの feedback を探索に使う

NSDI 2026 の [Fest](https://www.usenix.org/conference/nsdi26/presentation/li) は、P の分散モデルを対象に、記録した選択を変更してスケジュールを生成する。イベント間の happens-before を抽象化した timeline coverage と、指定シナリオへの近さを探索に使う。[論文](https://www.usenix.org/system/files/conference/nsdi26/nsdi26spring_li_prepub.pdf) と [artifact](https://github.com/aoli-al/Fest-artifact) が公開されている。

modelt への提案は、単純な seed の反復から、選択列と因果イベントを保存する corpus へ進めること。コードの分岐が増えなくても、異なるメッセージ順序を探索する価値がある。ただし現時点ではこの探索器を実装していない。論文の性能値を modelt の性能として扱わない。

## 実装とモデルの接続

[Quint Connect の紹介](https://quint.sh/posts/quint_connect) と [公式 MBT ドキュメント](https://quint.sh/docs/model-based-testing) は、モデルで得た期待動作を実装へ渡す流れを示す。modelt は同じ接続面を TS の Driver として持つ。Quint CLI / Rust を必須依存にせず、TLA+ と TS モデルの witness を使う。ITF 連携は未実装で、将来は [Apalache の ITF](https://apalache-mc.org/docs/adr/015adr-trace.html) に対応する。整数・集合・写像・loop の表現を保った専用アダプターにする。

2025年の preprint [Model-based Testing of Practical Distributed Systems in Actor Model](https://arxiv.org/abs/2512.08698) も、検証済みモデルと実装の間の隔たりを扱う。有限状態機械から状態・遷移を覆うテストを生成する方向を参考にできる。ただし modelt の visited による代表 witness だけでは、実装の全隠れ状態を区別するテスト集合にならない。リセットの信頼性、状態識別列、実装側の有限性などの追加前提を別途定義する必要がある。

## 再現可能な並行実行

[fast-check の scheduler](https://fast-check.dev/docs/advanced/race-conditions/) は、ラップした Promise の解決順序を制御し、非同期実装の順序依存を調べるために使える。[stateful commands](https://fast-check.dev/docs/advanced/model-based-testing/) は前提条件付き操作を生成・縮小する。modelt の現在の Driver は逐次 await するので、これだけで重なり合う呼び出しを検査したことにはならない。次は begin / complete / deliver のように実行境界を操作へ分ける。

[Turmoil](https://github.com/tokio-rs/turmoil) は制御したホスト・ネットワーク・ファイルシステムを実行する Rust の枠組み。[Antithesis の DST の説明](https://antithesis.com/docs/resources/deterministic_simulation_testing/) も時計、乱数、スケジューリング等の制御を重要な条件とする。modelt ではこの設計をホスト契約へ取り込む。seed があるだけでは、実 OS の未制御な I/O の再現性を保証できない。

[Coyote](https://microsoft.github.io/coyote/overview/how/) は .NET の Task 等を instrument して実行順を制御する。TS でも変換によるフックは考えられるが、Promise 全体の意味論を透過的に置き換える段階には進めず、明示的な注入境界を先に定義する。

## 線形化可能性、mutation、fuzzing

[Porcupine](https://github.com/anishathalye/porcupine) は、実行可能な逐次モデルと呼び出し・応答の履歴から、実時間順序に反しない線形化を探す。現在のステップ単位の観測一致とは別の検査であり、分散ストレージを対象にするなら優先度が高い。保留操作の扱いを含む履歴契約を先に決め、探索予算が尽きた場合は inconclusive にする。

[mizchi/mutator](https://github.com/mizchi/mutator) の役割はソースを変異させてテストの検出力を測ること。入力 corpus の変更とは区別する。モデルと SUT の遷移ロジックを共有せず、別々の mutation 実験で仕様の弱さも検査する。生存した変異を消すこと自体を目標にせず、観測が足りないのか、前提内で同等な変異なのかを確認する。

[Jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js) は Node 向け coverage-guided fuzzing。純粋なブラウザコアに組み込む依存としては採用せず、ホスト側で trace parser や codec を fuzz し、得た入力を共通 corpus に戻す選択肢とする。

## 採用順序

最初に実装の I/O を注入可能にし、全選択をトレースへ残す。次に stateful commands とスケジュールの縮小を追加する。その上で concurrent history checker と、Fest を参考にした feedback-guided corpus を独立に実装する。

指標は検出した既知故障、再現成功率、縮小後の操作数、無効入力の棄却率、モデルの状態・遷移到達、因果順序の多様性、mutation の内訳に分ける。単一のコードカバレッジや mutation score から形式的な正しさを結論しない。
