# TLC を直接基準にした差分検査

TLC と同じ source / config を Rust native / Wasm に渡す差分ハーネスを追加した。既存の78ケースに加え、境界値83ケースと seed 固定の有限遷移モデルを検査する。[計画](../plans/0015-tlc-differential.md) は実装前に登録した。

## 見つかった意味の差

TLC の基準は v1.7.4、revision `5a47802b5c391f59ecdd44117981f4ff8c0656ba`。jar の SHA-256 は `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`。ソースもこの tag と照合した。TLC master は文字列の Head / Append / toTuple の扱いが違うため、master のソースだけから旧 jar の動作を推測しない。

| 入力                                                | TLC v1.7.4 | 修正前の Rust      | 原因と修正                                                             |
| --------------------------------------------------- | ---------- | ------------------ | ---------------------------------------------------------------------- |
| `TRUE \in 1..0`                                     | FALSE      | 型エラー           | 空区間なら、要素の整数型検査より先に FALSE を返す。                    |
| `{{}, {TRUE}} \subseteq {{0}}`                      | FALSE      | 後続要素で型エラー | 最初の非所属で部分集合判定を打ち切る。                                 |
| `<<>> \in [{} -> Head(<<>>)]`                       | 評価エラー | TRUE               | 型集合の domain / range を先に評価し、空 domain でもエラーを捨てない。 |
| `[a \|-> 1] \in [b: Head(<<>>)]`                    | 評価エラー | FALSE              | record の各 field の型集合も、所属判定より先に評価する。               |
| 文字列の Len / Head / Tail / Append / 連結 / SubSeq | 値を返す   | 型エラー           | pinned TLC の文字列演算を実装する。                                    |

関数・record の所属を forall と論理積へ展開すると、domain の不一致や空 domain で range の評価が消えていた。Rust 内で型集合を先に評価する descriptor を作り、その後に所属を判定する形へ変更した。Seq を含む型集合も列挙せずに扱う。部分集合と空区間の修正も含め、モデルの性質を弱めて一致させていない。

`Head("abc")` と `Append("abc","d")` は、この TLC ではそれぞれ `"a"` と `"abcd"`。tla-ts0.0.10 は `version: "1.7.4"` でもエラーを返した。この2件の CI 回帰は、tla-ts の結果ではなく [TLC の記録](../fixtures/tlc-strings/expected.json) とその入力・ログの digest を正解にする。

非BMP文字を含む2つの原入力は、TLC の字句解析が拒否した。原入力は削除せず、frontend も拒否する対照にした。これらをモデルの一致件数には含めない。generic portable value の Unicode scalar string と、TLA+ source の字句制限を分ける。UTF-16 の slice が surrogate pair を分割する場合も、置換文字で結果を捏造せずエラーにする。

## 比較器と実行基盤

期待判定を Rust から生成しない。TLC の判定と、API 名の違いだけを正規化した Rust の判定を比較する。出力された状態数・生成数と有限反例の長さも照合する。TLC が初期 invariant violation で集計数を出さない場合は欠測として保ち、0を補わない。

値の演算では、違反を意図した `Prop == x # x` で初期値を取得する。Rust が返した値で Init を制限した別の仕様を TLC に実行させ、同じ初期状態が到達することを確認する。単に両方が invariant violation を返すだけでは一致にしない。liveness の lasso と deadlock の有限反例も、元の遷移・fairness・ENABLED を使って再生する。

最初の [Red](../runs/0015-development-red/result.json) は61件を非一致として保存した。これには集計数の欠測を誤分類した比較器側の問題も含む。境界値の回帰テストで意味の差を再現し、TLC ソースと実行結果から修正した。

保存用 JSON で未実行の `native: undefined` が消え、replay の厳密比較だけが失敗する問題も2件の抜粋で再現した。未実行の欄を返さない形に修正した。モデル検査器の binary は変更していない。

並列起動した JVM が共通の一時ディレクトリへ標準モジュールを書き、片方の終了時削除が他方の解析と競合する問題も確認した。[該当 run](../runs/0015-development-final/result.json) は保持した。`SimpleFilenameToStream.read` と `FilenameToStream.TMPDIR` に従い、全 TLC 呼び出しに固有の `java.io.tmpdir` を指定する。JVM の解析例外は input error / model error と区別する。並列対照では、読み込んだ Naturals.tla の実パスが異なることも検査する。

## 再実行

```sh
just tlc-diff /path/to/java /path/to/tla2tools.jar development .artifacts/tlc-development
just tlc-diff /path/to/java /path/to/tla2tools.jar confirmation .artifacts/tlc-confirmation
just tlc-diff-replay /path/to/java /path/to/tla2tools.jar .artifacts/tlc-development .artifacts/tlc-replay
just safety-test
```

run は source / Wasm / native binary / jar の digest、revision、seed、入力、全結果と生ログを保存する。replay は保存した入力を使い、判定・値・反例・work を含む report を完全比較する。再実行は新しい出力先へ保存し、旧 run を上書きしない。既存32件の seed を再利用した結果を、新しい独立した確認へ加算しない。

開発 seed は0x15A1、最初の確認 seed は0x15B2。検査器を直した後の確認32件は一致した。JSON replay の修正後は追加 seed 0x15C3 を予約した。最終 run は次の通り。

| 記録                                                               | 結果                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| [開発](../runs/0015-development-isolated/result.json)              | 115入力中113一致、構文拒否の対照2件、model error一致25件、反例77件 |
| [追加確認](../runs/0015-confirmation-isolated/result.json)         | seed 0x15C3 の32モデル一致、反例19件                               |
| [既存複合値・temporal](../runs/0015-isolated-existing/result.json) | 46入力一致、反例14件                                               |
| [既存scalar](../runs/0015-isolated-scalar/result.json)             | 32入力一致                                                         |

最終147入力では145件が一致し、2件は構文拒否の対照。96件の反例をTLCで再生し、開発・追加確認の保存 report 全体も再実行して一致した。初回の seed 0x15B2 の [32件](../runs/0015-confirmation/result.json) は別に残す。再試行や同一入力の replay を独立ケース数へ加算していない。

元の Red ログを修正後の欠測処理で分類し直すと、[意味の差は17入力](../runs/0015-verification/red-analysis.json)。これは4系統の修正に対応する。最初の61件すべてを検査器のバグとして数えていない。修正後の138件に解析例外の分類テストを追加し、[backend回帰139件](../runs/0015-verification/safety.log) が通過した。

最終検証 sourceVersion は `15aaba23e4cb706285dd6a884aba0175ea617ac1d3cde1e7241eaa51bf023214`。検査器の修正は `c9df2e8`、一時ファイルの隔離を含む評価器は `7411855`。全 report の比較と入力・binaryのdigestを検査した。[検証記録](../runs/0015-verification/result.json) に実ブラウザ・Go・配布consumer・Rust・mutation・replayのログも保存した。

[性能の回帰測定](../runs/0015-regression-performance/result.json) は、従来0014と同じ10入力・warmup2・測定7で実行し、保存入力も再実行した。scalar ring10万状態はtla-ts34.30 ms / native14.01 ms / Wasm17.14 ms。これは正しさの修正後の観測で、hash最適化だけの効果や一般的な改善率とは解釈しない。

この評価は、対応 fragment の小さい有限モデルに対する差分検査。全 TLA+ の互換性や、無限モデルの証明、実分散システムの未知バグ検出を表す結果ではない。
