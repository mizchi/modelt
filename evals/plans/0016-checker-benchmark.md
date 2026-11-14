# tla-ts・TLC・modelt の同条件測定

既存の10入力（集合・関数・sequence・fairness 各1、ring 10k/50k/100k、grid 20/50/100）に、同じ ring の定数 N=1,000,000 を加える。入力の選別や検査器の最適化は行わない。全11入力で同じ source / config と1 workerを使い、正常終了・完全探索・状態数・生成数が一致してから速度を解釈する。modelt の上限は depth/states=2,000,000、work=20,000,000 とし、bounded / empty / violation / error は成功扱いしない。

起動込みは各回別プロセスで、tla-ts の Node、TLC の JVM、modelt の Node+Wasm、modelt の Node frontend+native子プロセスを測る。入力ファイルの用意・ログ保存・一時ディレクトリ作成は計測外、入力の読み込み・ライブラリ読み込み・source解析・全探索・結果の返却・プロセス終了は計測内。modelt に事前コンパイルした IR を渡さない。TLC の標準モジュール展開先は毎回隔離する。

再利用時は別表とし、tla-ts の check API、modelt の常駐 native と再利用 Wasm を測る。各回 source からコンパイルし、結果の decode まで含める。TLC の常駐 JVM は測定しない。事前コンパイル済み IR と TLC CLI を直接比較しない。

各入力・経路で2回ウォームアップ後7回を保存する。入力順は固定、経路順は反復ごとの巡回で偏りを減らす。ウォームアップも生データを保存し、中央値・最小・最大を報告する。全経路は直列に実行し、測定中にビルドやテストを並走させない。OSキャッシュを消さず、起動込みを cold disk / 初回インストールの費用と解釈しない。CPU単独の言語性能や検査範囲全体への一般化を主張しない。

tla-ts 0.0.10 は version=1.7.4、workers=1、livenessCheck=final。TLC は既存の v1.7.4 jar と Temurin 21.0.13+9 の macOS arm64 JREを使い、Node/RustとCPUアーキテクチャを揃える。TLCは ParallelGC、各ツールのheapは既定値。時間の制限は追加しない。TLCの探索途中のliveness検査など既定の内部方針の差は残る。

計測前に実装・入力・planをコミットし、sourceのfingerprint、commit、dirty paths、Node/Rust/Java/OS/CPU、jar/native/Wasm/java実行ファイルとJRE配布物のSHA-256を保存する。サンプル・TLC生ログ・入力を新規runに書き、例外も保存する。replayでは証拠のdigestとsource/binaryを検証し、保存入力を全4経路で再実行して計数を確認する。replayは独立した性能測定に数えない。既存runは編集しない。
