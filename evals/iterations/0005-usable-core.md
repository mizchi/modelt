# 0005: 実バグと持ち運べるモデル

[事前計画](../plans/0005-usable-core.md) に従い、実バグの修正前後、有限モデルの共有、縮小、ホスト再生、配布 consumer を検査した。確認用 seed161〜180 はこの実験で使用済み。

## 実装で再現したバグ

DirtyHairy/async-mutex の [修正8331143](https://github.com/DirtyHairy/async-mutex/commit/8331143c133585ae41b35b69dab7404e2f66751e) と親 e7bc6a4 の原本を license / SHA256 付きで固定した。連続する unscoped release で、引き継いだ releaser が消される問題。FIFO の純粋モデルと、実際の acquire / release / isLocked を呼ぶ Driver を独立に記述した。

`acquire(a) → acquire(b) → release → release` で、モデルは未ロック、修正前はロックされたままになる。Driver は Node の event-loop turn で Promise の反応を観測する。外部 I/O のないこの原本に対する検査で、無制限の liveness 証明ではない。

[確認 run](../runs/0005-usable-confirmation/) の結果:

| 指標                             |             結果 |
| -------------------------------- | ---------------: |
| 修正前後の TS / Rust / Wasm 比較 | 1,200件、不一致0 |
| 修正後の正常対照                 |   600 / 600 通過 |
| 修正前の既知バグを検出した seed  |          20 / 20 |
| 保存反例の再現                   |          20 / 20 |
| 共通の有限表                     |   49状態・82遷移 |
| 縮小後の反例                     |    全20件で4操作 |

16件は5→4操作、4件は既に4操作だった。縮小は9〜19回の検査、33〜75回の追加 reset/step を使った。短い説明のために追加実行が必要になる。人手の Driver 作成時間は他の実装作業と分離していないため、数値を推測しなかった。

native / Wasm の大量比較は、実際の JS ライブラリで取得した観測列を同じ有限表と照合する。JS ライブラリを Rust 上で動かした結果ではない。既知の過去バグの再現であり、未知バグの発見や一般の検出確率の推定には使わない。確認 run のソースは `b4b9a36` に保存した。

## 値だけでなくモデルを共有する

観測を edge ごとに持つ versioned finite model を TS と Rust でロードできる。閉じていない探索は artifact にせず bounded とする。actions に列挙した領域だけが対象で、TLA+ 全体や任意の TS 関数の翻訳ではない。不変条件は式の移植ではなく、各状態で評価した違反ラベルを保持する。

縮小の削除候補は TS / Rust / Wasm で同じ順序。失敗 signature とモデル上の有効性を保持し、最終再現を検査する。minimal は1要素削除に関するもので、全体最短を保証しない。budget 切れは bounded。

HostTape は時計、選択、配送・破棄、volatile / durable storage の操作を持つ。同じ tape と永続化後の状態が TS / Rust native / Wasm で一致した。未消費・逸脱した tape、無効な値、失敗を無視した finish を拒否する。実 OS の I/O を透過的に捕捉する機能はない。

## 同じ履歴で性能を比較する

初回 benchmark は batch 内で同じ入力を比較したが、batch サイズ間で正常・故障・invalid の割合が異なった。その値は保持し、batch の改善率には使わない。

[追加の固定履歴測定](../runs/0005-fixed-history/) は、すべてのサイズで同じ正常5操作を繰り返した。記録なし、warmup3・測定9、実行順を交互にして全結果を照合。Node24.22.2 / Rust1.98.0 / macOS arm64での記述的な中央値である。ソースは `3f736e5`。

| 経路         |    1履歴 |  16履歴 |  64履歴 | 64 batch の1履歴あたり |
| ------------ | -------: | ------: | ------: | ---------------------: |
| TS prepared  | 0.0588ms | 0.882ms | 2.917ms |               0.0456ms |
| TS wire      |  0.650ms | 2.015ms | 5.693ms |               0.0889ms |
| Wasm wire    |  0.526ms | 1.275ms | 3.520ms |               0.0550ms |
| native JSONL |  0.430ms | 1.143ms | 3.316ms |               0.0518ms |

prepared はモデル読込済み、wire は JSON・モデル読込・検証・完全な結果返却を含む。native は常駐し、IPC を含めて測った。処理系全体の利用費用であり、言語の CPU 速度比として扱わない。

**判断:** 既定は TS のまま維持する。共通形式での入出力には batch API を採用し、モデル転送を履歴間で分散する。次はモデルを保持する handle / cache を測る。今回の小さい49状態から、大規模分散モデルの性能を一般化しない。

## 配布と CI

npm `.tgz` 約158KB、Cargo `.crate` 約13KB、standalone Wasm 約355KBを作成した。別 consumer の TS/Wasm、Cargo offline build/run、CLI の0/1/2終了コードを検証した。solver adapter は optional peer に分離した。registry への初回公開は実施していない。

PR 検査を1ジョブへ集約し、branch push / PR の二重起動を除いた。型・共有テスト57件×2 runner、Rust7検査、Node の portable 7検査と usable 4検査、3経路の実ブラウザ、既存 mutation・評価再生、単独 consumer を通した。重い独立評価と cloud sharding は手動実行として残す。runner 割当待ちの段数を減らした設計変更で、待ち時間そのものの短縮保証ではない。

次は別の実プロジェクトの過去バグと、Driver 作成・調査時間の独立計測を追加する。今回の結果を見て同じ確認用 seed へ探索法を再適合させない。
