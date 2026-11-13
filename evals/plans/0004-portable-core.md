# 0004: TS / Rust の共通コア

実装前の計画。既存 TS の適合性検査・再生を参照し、Rust native と同じ Rust から生成した Wasm の判定を比較する。性能の優越ではなく、言語をまたぐ意味論と再現性を検査する。

- 共通値: null、bool、任意精度の十進整数、Unicode scalar string、bytes、list、record、set、map。浮動小数点は初版で拒否する。record / map の重複キーはエラー、set の重複は除去。順序は canonical JSON の UTF-8 bytes で定義する。
- モデルはホストに置く。コアが initial / reset / model-step / driver-step を要求する同期的な effect protocol を使い、非同期 I/O と cleanup は SDK が所有する。操作列全体と整合する非決定的候補を保持する。
- 既存 Trace v1 と区別した versioned portable trace を定義する。invalid、mismatch、matched と protocol error を区別し、未知 version と古い reply を拒否する。
- TDD: 共通 codec と protocol の失敗テストを先に追加する。Rust native の利用テスト、TS/Wasm の Node と Chromium による検査を追加する。
- 開発用 seed は1〜20。確認用 seed101〜120はこの比較用に予約する。各 seed512操作・最大深さ16の alternating corpus を使う。正常版と既知の5故障に対し、TS参照とWasmの完全な結果、Wasmとnativeのwire応答を比較する。
- 合格条件: 判定・反例・expected・checkedStepsの不一致0、正常版の誤検出0、既存 TS が検出した故障の欠落0、保存トレースの再現失敗0。Unicode、整数精度、集合・写像の等価性、malformed input を別 fixture で照合する。
- 実測は startup と検査時間を分ける。ソース digest、toolchain、実行条件、操作列または生成 seed、判定を保存し、run を上書きしない。
- 初版の対象は適合性と再生。汎用 IR、BFS の Rust 移植、縮小器の共有、Go SDK、実 OS の schedule 制御は後続とする。TS の custom comparator は portable 経路では使用せず、観測を codec で抽象化する。
