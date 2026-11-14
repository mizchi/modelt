# Rust による TLA+ safety 探索

## 仮説と範囲

既存の Rust コアは有限表の照合・再生であり、TLA+ の状態生成を高速化していない。tla-ts の parser を使い、限定した TLA+ の Init / Next / INVARIANT を version 付き中間表現へ変換する。Rust で式評価・successor 生成・重複排除・BFS・最短反例復元を行い、探索中の JS callback と全グラフの事前構築を避ける。

最初は signed 32 bit 整数・真偽値、算術・比較・論理・IF、定数と非再帰 operator、有限の集合・区間への所属による代入、UNCHANGED、分岐を扱う。未対応の構文・設定を暗黙に無視しない。liveness / fairness / symmetry / arbitrary collections / 全 TLA+ 互換とは区別する。整数範囲と deadlock は TLC のソースを確認し、曖昧な場合は TLC で対照する。

状態集合は hash のみで同一視せず、型付き値の完全一致で重複排除する。探索中は状態と親 index を保持し、反例のときだけ trace を復元する。ノード・深さ・work の予算を明示し、打ち切りを complete にしない。空の初期状態は empty。不完全な変数代入・型違い・overflow は error。

## 固定する確認

小さい状態系の成功、不変条件違反、初期違反、deadlock、stuttering、空初期集合、複数初期状態、重複代入、未代入変数、予算境界を含む。tla-ts と Rust native / Wasm の判定を比較し、反例の各遷移を検査する。公開されている TLA+ example を使える範囲で追加し、原文・license・revision を保存する。browser と配布 consumer でも実行する。

性能は実装を固定してから測る。counter ring と2変数 grid の3サイズ、同じ TLA+ / config を使う。tla-ts end-to-end、frontend compile、Rust native process の全費用、Wasm compile/instantiate、Wasm request（JSON と探索を含む）を分ける。warmup2・測定7、順序を交互にし、速度の合否閾値は置かない。判定・到達状態数・生成状態数を照合してから解釈する。counter の1万・5万・10万状態、grid の辺長20・50・100を予定する。サイズを実行前に変更した場合は理由を記録する。

保存 run は上書きせず source / toolchain / 入力 / 結果 / 生サンプル / digest を記録する。小さなモデルの速度比を全 TLA+ へ一般化しない。未対応構文を許可するために仕様を弱めない。
