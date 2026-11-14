# TLA safety の Rust backend と高速化

TLA+ の限定した safety fragment を IR に変換し、式評価・状態生成・BFS・不変条件と deadlock の検査・最短反例復元を Rust native / Wasm で実行する。全グラフの TS での事前列挙や、探索中の JS callback は使わない。採用する入口は `compileTlaSafety` と `checkSafety`。[対応範囲と利用方法](../../docs/rust-safety.md) を参照。

これは tla-ts 全体の移植ではない。signed 32 bit 整数・真偽値、有限 domain、非再帰 operator、算術・比較・論理・IF・代入・UNCHANGED に対応する。state の集合・関数・record・sequence、量化、liveness / fairness / symmetry、state/action constraint は未対応。未対応機能を使う入力は拒否し、既存の full tla-ts 経路を維持する。

## 判定と反例

TLC ソースの [Worker](https://github.com/tlaplus/tlaplus/blob/d8fb231de4e4b5d02c1b2ed1ac759c086f694021/tlatools/org.lamport.tlatools/src/tlc2/tool/Worker.java)、[ModelChecker](https://github.com/tlaplus/tlaplus/blob/d8fb231de4e4b5d02c1b2ed1ac759c086f694021/tlatools/org.lamport.tlatools/src/tlc2/tool/ModelChecker.java)、[Naturals](https://github.com/tlaplus/tlaplus/blob/d8fb231de4e4b5d02c1b2ed1ac759c086f694021/tlatools/org.lamport.tlatools/src/tlc2/module/Naturals.java) と値比較を確認した。実行対照は TLA+ Tools v1.7.4 の TLC（Version2.19、rev5a47802）を使用した。

成功、不変条件違反、初期違反、deadlock、stuttering、複数初期状態、重複代入、primed variable の読み取り、未代入、型違い、overflow、ASSUME、定数、予算境界などを検査した。TLC と比較できる30入力で判定・比較可能な状態数と生成数・違反 trace が一致した。深さ・状態数・work の予算対照は Rust native / Wasm で同じ結果となる。TLC にない独自の予算を TLC の完全探索と同一視しない。

空の初期集合は tla-ts が success を返す場合でも `empty` として区別する。予算切れは `bounded`、型エラーや未代入は例外であり、complete に置き換えない。初期試作では異なる型への所属を false と扱った箇所が差分検査で見つかった。TLC に合わせて型エラーに修正し、集合要素の評価・重複代入の型比較も回帰対照にした。定数だけの Next と global symbol を隠す parameter も拒否する。

TLA+ Examples の [DieHard 原文](../fixtures/die-hard/DieHard.tla) を revision・digest・MIT license 付きで保存した。型不変条件のみの探索は16状態・97生成。NotSolved を加えた場合は14状態・73生成で、4ガロンへ到達する6操作の最短反例が TLC / tla-ts / Rust で一致した。仕様を弱めたり、primed read を消すために原文を書き直していない。

最終版と変更前の native binary に同じ35入力を渡し、成功した結果の status / reason / states / generated / depth / work / 全 trace が一致した。error は kind / code の一致を確認し、診断文は両方を保存する。型付き状態を同じ hash bucket に強制する private test では、値や型が異なる状態を区別し、不完全な追加でも store を壊さないことを確認した。

## 測定と改善ループ

計画は [0009](../plans/0009-rust-safety.md)、[0010](../plans/0010-rust-safety-storage.md)、[0011](../plans/0011-rust-safety-arena.md)。各変更前に条件をコミットし、各段階の実装を固定して別 run に測定した。同じ6入力、warmup2・測定7、route の順序を交互にし、全反復で判定・状態数・生成数の一致を確認した。

初回は ring10万状態で tla-ts28.67ms、Rust native29.45ms、Wasm29.88msだった。Rust で書き直しただけでは改善を確認できなかった。native の sampling profile では `Scalar::parse` からの文字列確保・解放が hot path に現れた。literal の整数範囲・canonical な表現の検証を decode 時の一度に移した。次に、state の連続格納、親・action index、current / next scratch の再利用で、successor ごとの vector と action string の確保を除いた。

| case         | 初回 native ms | literal native ms | 最終 native ms | 初回 Wasm ms | literal Wasm ms | 最終 Wasm ms |
| ------------ | -------------- | ----------------- | -------------- | ------------ | --------------- | ------------ |
| ring 100,000 | 29.448         | 18.223            | 10.628         | 29.879       | 21.104          | 13.292       |
| grid 10,000  | 6.716          | 4.707             | 3.640          | 5.934        | 4.235           | 2.789        |

最終版の全入力は以下。時間は中央値、単位ms。native は process 起動・JSON 入出力込み。Wasm は instance を再利用し、request の JSON・検証・探索・結果 decode を含む。frontend は別測定。

| case         | 状態数  | tla-ts 全検査 | Rust native process | Rust/Wasm request | frontend |
| ------------ | ------- | ------------- | ------------------- | ----------------- | -------- |
| ring 10,000  | 10,000  | 3.956         | 2.959               | 1.452             | 0.085    |
| ring 50,000  | 50,000  | 14.545        | 6.391               | 6.610             | 0.063    |
| ring 100,000 | 100,000 | 29.515        | 10.628              | 13.292            | 0.060    |
| grid 20×20   | 400     | 0.871         | 1.725               | 0.172             | 0.075    |
| grid 50×50   | 2,500   | 1.615         | 2.370               | 0.797             | 0.057    |
| grid 100×100 | 10,000  | 4.282         | 3.640               | 2.789             | 0.054    |

ring10万状態で同時測定した tla-ts に対し native 約2.8倍、Wasm 約2.2倍。grid1万状態で Wasm 約1.5倍だった。小さい grid では native の process 起動込み費用が tla-ts を上回る。Wasm の compile/instantiate は別途0.862ms、module は655,383 bytes、host import は0。通常の JS module import やアプリ起動全体の費用は測っていない。

Rust の効果と、汎用 TLA evaluator から変数を添字で参照する限定した IR への変更の効果は分離していない。1台の macOS arm64、Node24.22.2 / Rust1.98.0、固定した scalar model での測定である。全 TLA+、collection を持つ分散仕様、実 SUT、並列 BFS、メモリ使用量の改善率には一般化しない。

## 証拠と採用

| run                                                           | 実装 snapshot                              | source files |
| ------------------------------------------------------------- | ------------------------------------------ | ------------ |
| [0009 baseline](../runs/0009-rust-safety/result.json)         | `23c81f71d96ede35594757a5a93814019d1df18b` | 90           |
| [0010 literal](../runs/0010-rust-safety-literals/result.json) | `56fa0e9eb50fd9be3b2c4b710ddb43191ba46ed2` | 91           |
| [0011 storage](../runs/0011-rust-safety-arena/result.json)    | `4b56d51ebaf8696e3f0d7f89f1a771a10efd1fee` | 92           |

全 run の source digest が記録した commit と一致した。入力・IR・全 sample・toolchain・Wasm digest を保存し、各段階を再生した。コピーした性能証拠を改変すると replay が digest 不一致で拒否することも確認し、元の run は変更していない。最終 source version は `059980d213156e5ad177e9b4092172a1a8d47f42bf6d6e6cfbe064cb4a6f2aac`。

[最終検証](../runs/0011-safety-verification/result.json) に変更前後の35入力・両結果、TLC30件の log と入力、baseline の sampling profile と実行条件を保存した。profile 用 binary は baseline と同じソースで symbol / frame pointer を残して build し、sampling 後に停止した。profile 用処理の完了件数を correctness 検査へ加算しない。

```sh
just safety-test
just safety-replay evals/runs/0011-rust-safety-arena
```

厳密な再生は対応する snapshot を checkout する。CI の同じ入力による反復は回帰確認であり、新しい独立実験には数えない。Vitest / node:test 各67、Rust tests・fmt/clippy、Node native/Wasm 差分、実 Chromium の compiler と IR 実行、solver を入れない npm consumer、Rust consumer、Go consumer を確認した。既存の TS mutation 検査は通過したが、Rust の mutation coverage を測ったものではない。

限定した safety backend と2つの最適化を採用する。公開 IR は変えず、hash collision は完全な値比較で処理する。次は function / record / sequence を含む IR の範囲を決め、TLC の既存仕様を変更せずに差分 corpus を広げる。全 TLA+ 移植の前提で性能値を外挿しない。
