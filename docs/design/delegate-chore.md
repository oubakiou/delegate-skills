# delegate-chore 設計

雑務のフォールバック先として、explore / implement / review のどれにも明確に当てはまらない作業を最安モデルの subagent に委譲する skill の設計。

delegate skill 共通の仕組み（アーキテクチャ・モデル解決・実行系分岐・ファイルプロトコル・多段委譲・脅威モデル）は [spec.md](spec.md) を参照。本書は delegate-chore 固有の設計判断のみを扱う。

## 1. 位置づけ

- `task_type=chore` / 既定モデル `haiku`（最安）/ Claude パスは `delegate-claude.sh`（`claude -p` 子プロセス）
- 専用 skill（explore / implement / review）でカバーされない雑務を引き受ける**フォールバック**。軽微な整形・リネーム・一括置換・定型コマンド実行など
- 専用 skill が当てはまる作業は必ずそちらを優先する。chore はあくまで受け皿

## 2. 他 skill との境界

| 作業の性質                   | 振り先               |
| ---------------------------- | -------------------- |
| read-only の調査・読解       | `delegate-explore`   |
| ファイル編集を伴う実装・修正 | `delegate-implement` |
| 差分の指摘出し               | `delegate-review`    |
| 上記いずれにも該当しない雑務 | `delegate-chore`     |

implement との差は「実装判断の有無」。機能追加・バグ修正・リファクタなど編集の設計判断を要するものは implement、判断をほぼ要さない機械的・定型的な雑用が chore。境界が曖昧なときは、繰り返し現れるなら専用 skill 化を提案する（§4）。

## 3. 既定モデルとツール権限

- **既定モデル `haiku`**: chore は read 中心・低リスクで判断比重が小さいため最安モデルを既定にする（spec.md [§3 既定モデルの根拠](spec.md#既定モデルの根拠) と同方針）。`DELEGATE_CHORE_MODEL` で上書き可
- **Claude パス**: 軽微な編集（Edit/Write）や定型コマンド実行（Bash）を伴いうるため、`delegate-claude.sh`（`claude -p` 子プロセス）で worker を起動する
- **制約**: 編集は可、ただし **push はしない**（push・PR は親エージェントが直接扱う）。実行系の sandbox 設定はプロトコル共通（spec.md [§5](spec.md#5-実行系の二分岐)）

## 4. フィードバックループ（chore 固有の中核責務）

chore に流れたタスクは「専用 skill が無い作業」のシグナルである、という点が delegate-chore 固有の設計上の役割。親エージェントはレスポンス消費後に次の 2 つの昇格を評価する。

- **skill 昇格提案**: その雑務が繰り返し現れる / 明確にスコープされた再利用可能なカテゴリなら、専用 `delegate-<name>` skill の新規作成を `AskUserQuestion` で提案する
- **決定論的プロセスの自動化提案**: LLM の判断を要さず決定論的に自動化できる手順（固定パイプライン・機械的な一括置換など）に気づいたら、スクリプト化 / git hook / npm script / CI 等の自動化を提案する

いずれも一度きりの些末な作業では提案しない。判定基準・提案内容・生成手順（skill-creator 雛形化、本プロトコルへの追従）の詳細は spec.md [§8](spec.md#8-delegate-chore-からの-skill-昇格提案) に集約する。この feedback により chore の受け皿は時間とともに専用 skill / 自動化へ昇格し、フォールバックに残るのは真にアドホックな作業のみになる。

## 5. コスト特性（token 削減が効く / 効かない境界）

delegate 系の token コスト削減は「高価な main の context に**初めて**載る嵩（B）を、安い worker（既定 haiku）へ単価ごと逃がす」ことで生じる。ここで効くのは課金対象のトークン＝**出力（Opus で入力の約 5 倍・キャッシュ対象外）と初出入力**であり、毎ターンの再送プレフィックスはキャッシュリード（約 0.1×）でコスト上ほぼ無視できる。これは委譲オーバーヘッド δ（主に main が生成する orchestration 出力＝worker 起動プロンプト・スクリプト呼び出し・最終要約、および初出入力）を上回る B があって初めて黒字化する。単価差（main を Opus、worker を haiku とすると約 5 倍）を織り込んでも、概ね **B が δ を上回る規模で初めて削減** に転じる。

chore が受ける雑務の多く（行末整形・一括置換・リネーム・定型コマンド実行）は **1 コマンドでスクリプト化でき、対象ファイルの内容がどのモデルの context にも載らない**（bash が処理し、モデルはコマンドを吐くだけ）。この場合 B ≒ 0 で、委譲は δ を丸ごと上乗せするだけになり **token コストはむしろ増える**。delegate-chore を「一度きりの些末な雑務」に使うのが割に合わないのはこのため（§4 の昇格提案で繰り返しを自動化／専用 skill 化へ逃がす動機の一つでもある）。

したがって delegate-chore の主たる価値は token コスト削減ではなく、(a) main の context を汚さない衛生と、(b) §4 のフィードバックループ（昇格 / 自動化提案）にある。**token コスト削減が本質的に効くのは、大量の content が必ずモデル context を通る作業** — 多数ファイルの読解（delegate-explore）、大きな差分のレビュー（delegate-review）、読解を伴う複数ファイル編集（delegate-implement）— であり、そこでは B が大きく haiku へ逃がせ、かつ main の context も汚さない。chore へ流れた作業が「内容を読み込んで判断する」性質を帯びてきたら、それは専用 skill（§2 の振り分け）へ移すサインである。

なお本節は削減の **向き**（効く / 効かない）を論じるモデルであり、コストの絶対値・倍率は主張しない。実コストは `usage` 内訳（input / output / cache_read / cache_write）で決まるが、現状その内訳は計測できておらず（§6）、**magnitude は未確立**である。

## 6. オーケストレーション削減の改善と計測知見

§5 を踏まえ、委譲オーバーヘッド δ を下げる方向で実行フローを見直した。実装した設計判断と、その効果計測から得た知見を記す。

### 実装した改善

- **委譲前のコストゲート（A）**: 単一コマンドでスクリプト化でき内容を context に載せずに済む chore は、委譲せず main が直接実行するか §4 の自動化提案へ回す（§5 の損益分岐の運用化）。
- **準備の集約 `prepare.sh`（D）**: 前提チェック → モデル解決 → チェーン確認 → リクエスト生成を 1 呼び出しに畳み、main 側の bash 往復と context への出力を削減する。
- **サイズゲート丸読み `read-response.sh auto`（E）**: 小さい response（既定 10KB 未満、`DELEGATE_RESPONSE_INLINE_MAX` で可変）は status と全 section を 1 回で丸読みし、段階読みの jq 複数往復を避ける。
- **報告見出しの固定（C）**: worker の報告 Markdown を canonical 英語 section 名（Summary / Verification 等）に固定し、main が section 名・順序に依存して読めるようにする。
- **worker 起動の固定テンプレ化（J1）**: worker への指示文を固定ボイラープレート（request_file を読ませる 4 行）にし、`<REQUEST_FILE>` / `<RESPONSE_FILE>` だけ差し替えて渡す。タスク本体は request_file にあるので **main が起動プロンプトを作文し直さない** ＝ main の出力トークンを削る。テンプレ末尾で worker の最終メッセージを「status 一語＋1 行」に固定し、main へ返る text も縮める。
- **echo 禁止・最終要約 1 行（J3）**: main は worker 出力を要約し直さず、ユーザー向けは Summary を指す 1 行に留める（spec.md §6）。

J1/J3 は **driver（main）の出力トークン**を削る狙い。コストに効くのは出力（Opus で入力の約 5 倍・キャッシュ対象外）と初出入力で、再送はキャッシュリードでほぼ無関係（→ 計測知見の訂正に同じ）。効果は向きとしては出力減だが、magnitude は usage 内訳が無く未計測。

TODO: J1/J3 は chore で先行適用している。delegate-explore / delegate-implement / delegate-review へ横展開する場合は、各 skill 固有の read-only / no-push / verification / findings 制約を落とさない固定テンプレとして設計する。

### 計測から得た知見（count と方向性に限定。コスト magnitude は未確立）

> **訂正**: 当初ここには raw トークン数に平均単価を掛けた「`$` 倍率」（委譲 ~1.3–1.4 倍コスト等）を記したが、誤りのため撤回する。`subagent_tokens` は内訳（input / output / cache_read / cache_write）を持たない単一集計で、その大半は毎ターン再送されるプレフィックス＝**キャッシュリード（約 0.1×）でコスト上ほぼ無視できる**。したがって raw count × 単価は実コストを表さない。正しいコストは `usage` 内訳が要るが、main 自身の usage は session 内から自己観測できないため、**コストの絶対値・倍率は現状『未確立』**とする。

- **count として確かなこと**:
  - D+E は main の orchestration 往復（＝モデルのターン数）を約半分にした（計測例: 7 → 2）。フロー構造由来で再現性が高い。
  - 小さな chore を委譲すると worker 層が純増し、**raw トークン _数_ は委譲しない場合の概ね 2 倍**（計測例: 委譲合計 ≒ driver + worker）。ただしこれは _数_ であって _コスト_ ではない。
  - driver の raw トークン総数は新旧でほぼ横ばい（計測例で約 2% 差・単発ノイズ内）だが、総数の大半がキャッシュリードのため、この比較もコストの指標にならない。
- **コスト観点で言える _向き_（magnitude は未確立）**: 課金に効くのは出力（Opus で入力の約 5 倍・キャッシュ対象外）と初出入力で、再送（キャッシュリード）はほぼ無関係。よって driver のコスト削減は「**driver に何を生成させないか**（ターン数・worker 起動プロンプト・最終要約）」が要点。scriptable chore は B≒0 で arbitrage 対象が無く、委譲は orchestration 出力と不要な worker 実行を上乗せする＝**向きとしてコスト増**。
- **計測方法の限界**: ①「main 役の subagent（driver）」で測ると、現実の 2 層（main → worker）に無い driver 層が増え、cold subagent の SKILL.md 全文読込・親への報告生成で実 main を過大評価する。②`subagent_tokens` は内訳の無い単一集計でコスト換算に使えない。③main は自分の usage を自己観測できない。よって本節は count と方向性に限定し、`$` 倍率は出さない。

### 今後の計測方針（実コストではなく proxy metric を測る）

現段階では `usage` 内訳を自己観測できず、token コストの絶対値・倍率を効果的に計測できていない。したがって当面は「実コストそのもの」ではなく、損益分岐の判断に使える proxy metric を分解して測る。

測る対象は次の 4 系統に分ける。

- **main の出力相当**: worker 起動プロンプト、bash 呼び出し、最終要約など、main が生成した orchestration の文字数 / 推定 token。J1/J3 の効果を見る主指標。
- **main の初出入力相当**: main context に初めて載せた request / response / ログの文字数 / 推定 token。`read-response.sh auto` の丸読みが閾値内に収まっているかを見る。
- **worker に逃がした content 量**: worker が読んだファイル・差分・section の文字数 / 推定 token。§5 の B に相当し、delegate が黒字化しうる嵩を表す。
- **orchestration 回数**: main 側の tool / jq / read 回数、モデルターン数。D/E のような往復削減の再現性を見る。

これらを使い、損益分岐は次の形で扱う。

```text
benefit ~= B_main_avoided * (main_input_unit - worker_input_unit)
overhead ~= O_main_output + O_main_input + O_worker_fixed
delegate が得になる条件: benefit > overhead
```

ここで単価・倍率は固定値として断言しない。`B_main_avoided` と `O_*` を上記 proxy metric で測り、「scriptable chore は B≒0 なので不利」「read-heavy chore は B が大きく有利化しうる」といった適用境界を経験的に更新する。

計測ケースは固定 fixture として少なくとも 3 種類を持つ。

- **scriptable chore**: 一括置換、権限変更、リネームなど。期待値は delegate 不利。
- **read-heavy chore**: 複数ファイルを読んで分類・要約する作業。delegate 有利の可能性を見る。
- **mixed chore**: 少量読解と小変更を伴う境界ケース。委譲前コストゲートの調整材料にする。

実装は任意の telemetry として始める。たとえば `DELEGATE_METRICS_FILE` が設定されたときだけ、`prepare.sh` / `build-request.sh` / `read-request.sh` / `build-response.sh` / `read-response.sh` が指定された JSONL に `kind`、対象サイズ、section 数、inline 判定、selector、timestamp を追記する。通常運用では記録せず、計測時だけ有効化する。metrics 書き込みは best-effort であり、書き込み先の作成や追記に失敗しても本処理は継続する。特に `read-request.sh` は worker が実際に読んだ `selector` と出力量を記録し、B（worker に逃がした content 量）の proxy として使う。`read-response.sh` も main が実際に受け取った stdout の `selected` 量を記録し、response JSON 全体サイズと分けて扱う。

集計は `npm run metrics:summarize -- <metrics.jsonl>` で行う。人間向けの table では `worker_read_request_estimated_tokens`（worker に逃がした content 量 proxy）、`main_read_response_estimated_tokens`（main が読んだ response 量 proxy）、`inline_true/false`、`kind` 別 token 近似を確認する。機械処理する場合は `npm run metrics:summarize -- --json <metrics.jsonl>` を使う。

固定シナリオの比較は `npm run metrics:fixtures` で行う。`fixtures/metrics/{scriptable-chore,read-heavy-chore,mixed-chore}/` の request / response を実行ごとの一時ディレクトリで protocol scripts に通し、各 fixture の `metrics.jsonl` と `summary.json` を生成する。機械処理する場合は npm の実行ログを混ぜないため `npm run --silent metrics:fixtures -- --json` を使う。

baseline の drift 検出は `npm run metrics:baseline:check` で行う。現在値を `fixtures/metrics/baseline.json` と完全一致で比較するため、proxy metric の増減が意図したものなら fixture を再実行して妥当性を確認し、baseline と下表を同時に更新する。

`npm run metrics:cost-check` は fixture telemetry から、worker に逃がした request 量、main が読んだ response 量、差し引きの main input 削減量、最低限必要な main/worker 入力単価比を出す。この `min_input_ratio` は orchestration 出力、cache、worker 固定費を無視した下限であり、実コスト倍率ではない。したがって `min_input_ratio` を満たしていても、実際に得になるとは限らない。

現時点の fixture では `read-heavy-chore` / `mixed-chore` は main context 削減候補として見える。一方 `scriptable-chore` は fixture 上の `worker_read_request` があっても、実運用で shell-only に落とせるなら avoided main content はほぼ 0 なので、コスト削減候補とは扱わない。

### 初期 fixture baseline（proxy metric）

`npm run metrics:fixtures` による初期 baseline は次のとおり。数値は token 課金額ではなく、`chars / 4` または `bytes / 4` 近似による proxy metric である。

| fixture          | records | worker_read_request | main_read_response | inline | 読み方                                                                                                                                     |
| ---------------- | ------: | ------------------: | -----------------: | :----: | ------------------------------------------------------------------------------------------------------------------------------------------ |
| scriptable-chore |       5 |                 182 |                 67 |  true  | fixture では説明文を worker が読むため B が出ているが、実運用で 1 コマンドに落ちる chore は対象内容を読まないので B≒0。委譲は原則不利。    |
| read-heavy-chore |       5 |                 407 |                 89 |  true  | B が大きいケース。main が同量の content を読む必要があるなら delegate の候補。                                                             |
| mixed-chore      |       5 |                 207 |                 62 |  true  | 境界ケース。内容読解が必要なら候補になりうるが、決定論的コマンドへ落とせるなら委譲前コストゲートで main 直接実行または自動化提案へ寄せる。 |

この baseline の主目的は、絶対コストの主張ではなく、fixture 間の相対的な `B` と orchestration 量を継続観測することにある。特に `scriptable-chore` の `worker_read_request` を「削減できた量」と読んではならない。これは fixture の説明文量であり、実作業が shell だけで完結するなら main / worker のどちらの context にも対象 content は載らない。

token 推定は厳密な tokenizer に依存しすぎない。まずは `bytes`、`chars`、`lines`、`estimated_tokens = chars / 4` 程度の安定した近似で比較し、必要になれば tokenizer を差し替える。目的は請求額の再現ではなく、delegate-chore を使う / 使わない境界を安全に判断できる材料を得ることに置く。

## 7. 共通事項への参照

- 実行フロー（前提条件チェック → モデル解決 → チェーン確認 → ファイル事前確保 → リクエスト作成 → 実行系分岐 → レスポンス読み取り）: [SKILL.md](../../skills/delegate-chore/SKILL.md)
- ファイルプロトコル v1: [protocol-v1.md](protocol-v1.md)
- 多段委譲ポリシー（`chore` がチェーンに二度登場するのを禁止）: spec.md [§7](spec.md#7-多段委譲ポリシー再帰防止)
- exit code / 環境変数 / 脅威モデル: spec.md [§9](spec.md#9-スクリプトと-exit-code) / [§11](spec.md#11-環境変数) / [§12](spec.md#12-脅威モデル割り切り)
