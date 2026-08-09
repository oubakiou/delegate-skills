# テストスクラッチの後片付け 設計・実装計画

[![MKDN](https://img.shields.io/badge/MKDN-review-red?style=for-the-badge)](https://mkdn.review/?url=https%3A%2F%2Fraw.githubusercontent.com%2Foubakiou%2Fdelegate-skills%2Frefs%2Fheads%2Fmain%2Fdocs%2Farchive%2Ftest-scratch-cleanup.archive.md)

[issue #30](https://github.com/oubakiou/delegate-skills/issues/30)（テストが `.temp/` にスクラッチを残し続け、蓄積すると無関係な `clean-devcontainer-disk` のテストが落ちる）に対応するための設計判断と実装手順をまとめる。完了後は [development.md](../design/development.md) に永続情報を移し、本ファイルは archive する。

issue の症状は 2 つの独立した原因の合成である。両方を潰す。

- **原因 A（テスト側の非 hermetic）**: `scripts/clean-devcontainer-disk.test.ts` の grouping テストが、実リポジトリの `.temp/` を実 `du` で走査する。fake `du`（`:176-192`）は最終的に `exec "$REAL_DU"` へ委譲し、`--test-root` は `repo_root`（`scripts/clean-devcontainer-disk.sh:363`）を差し替えないため、テストの実行時間が**リポジトリの外部状態**に依存する
- **原因 B（scratch の蓄積）**: テスト fixture の 21 箇所が `.temp/` 配下を削除せず、フルスイート 1 回あたり約 240 entries が積み上がる

A だけを直せば当該テストは実行回数に依存しなくなり、B だけを直せば蓄積は止まる。B を直しても、scope 外の `.temp/delegate/` や手動作業が増えれば A の経路で再発するため、A を MUST に含める。

## 1. 対応スコープ

| 要件                                                             | 開始時の状態                                                                         | 完了条件                                                                                               | 最終状態                                                                            | 状態 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ---- |
| [MUST] grouping テストを hermetic 化する                         | fake `du` が実 `du` へ委譲し、実リポジトリの `.temp/` を走査する                     | 当該テストが `.temp/` の状態に依存せず、リポジトリを肥大させても実行時間が変わらない                   | fake `du` に完全一致の固定値モードを追加。`$repo_root/.temp` は実 `du` へ委譲しない | 完了 |
| [MUST] test scratch を専用 namespace 配下の共通ヘルパへ集約する  | 共通ヘルパなし。21 箇所が `.temp/` 直下を個別 helper で直接掘っている                | test fixture が `.temp/test-scratch/` 配下にのみ作られ、`.temp/` 直下を掘る test helper が残っていない | `shared/src/test-scratch.ts` を新設し 21 箇所すべて移行                             | 完了 |
| [MUST] `shared/src` の in-source test が scratch を残さない      | 19 箇所が cleanup なし（§2 表）                                                      | 対象 19 箇所が共通ヘルパ経由になり、フルスイート前後で `.temp/test-scratch/` の entry 数が増えない     | フルスイート後の `.temp/` 直下 `*-test-*` は 0                                      | 完了 |
| [MUST] `scripts/*.test.ts` が scratch を残さない                 | `delegate-wrapper-session.test.ts` / `delegate-run.test.ts` の 2 箇所が cleanup なし | 同上。フルスイート 1 回あたりの残存 entry 増分が 0                                                     | 既存 `afterEach` 方式の 2 ファイルも共通ヘルパへ寄せて重複を削除                    | 完了 |
| [MUST] 失敗時の調査用に残す opt-out がある                       | なし                                                                                 | `KEEP_TEST_SCRATCH=1` で削除が抑止され、抑止時はパスが stderr に出る                                   | per-test cleanup と sweep の両方に効く                                              | 完了 |
| [MUST] 配布物に test 専用モジュールが混入しない                  | `build:check` は `delegate-cli.mjs` 1 ファイルしか比較しない                         | build 出力が `delegate-cli.mjs` のみであることを検証し、`git diff --exit-code shared/dist` が clean    | 出力は `delegate-cli.mjs` のみ、dist に差分なし。`shared/src/` は配布対象外         | 完了 |
| [SHOULD] 異常終了・追加漏れに対する安全網                        | 手動 `find`（issue の回避策）のみ                                                    | globalSetup が `.temp/test-scratch/` 配下の古い owned entry を回収する                                 | setup 側で sweep（teardown は worker pool が閉じる前に走るため不採用。§3.2）        | 完了 |
| [SHOULD] 既存残骸（`.temp/` 直下の legacy prefix）を一度だけ回収 | 1938 entries / 287MB が滞留                                                          | 既知 prefix の明示 allowlist による one-shot 回収経路がある                                            | `recoverLegacyTestScratch` で 1933 entries を回収（`.temp/` 直下は 6 entries に）   | 完了 |
| [SHOULD] `clean-devcontainer-disk.sh` の `.temp` 計測を頑健化    | `du -sb` の全走査に無制限で依存                                                      | 実運用で `.temp/` が肥大していても計測が stall せず、計測不能時は「計測不能」と明示表示する            | `timeout 10` を掛け、超過・失敗時は `計測不能` を表示                               | 完了 |

> archive 前には `最終状態` と `状態` を必ず更新する。未完了項目が残る場合は、`状態` を `一部未完` / `不採用` などにして、理由と後続 issue / plan の有無を `最終状態` に書く。

スコープ外:

- `.temp/delegate/` 配下（実 delegate 実行の work dir）の retention: `DELEGATE_RUN_RETENTION_DAYS` が既に責務を持つ。テスト由来 scratch とは寿命の決め方が違うため混ぜない
- `shared/src/dispatch.ts:71` の production scratch: `os.tmpdir()` 配下かつ `try-finally`（`:125-128`）で回収済み。テスト所有物ではない
- `scripts/check-cli-build.sh:9` の `.temp/build-check.*`: build scratch であり `trap ... EXIT` で回収済み。共通ヘルパの対象にしない
- `scripts/delegate-cli-bundle.test.ts:61,124`: `os.tmpdir()` 配下かつ `try-finally` で回収済みで `.temp/` を汚さない
- `clean-devcontainer-disk.sh` の自動削除対象に `.temp/` を加えること: 「手動 emergency 候補。自動削除は retention 機構の責務」という現行の設計判断（`scripts/clean-devcontainer-disk.sh:506`）を本プランでは変更しない
- `gh skill publish --dry-run` の `.temp/` 走査ハング: 本対応で `.temp/` が痩せれば緩和されるが、publish 側の対策は別件

## 2. ベースライン / リファレンス

母集団を「**test fixture が作る scratch**」に限定して数える。該当は 28 箇所で、cleanup を持つのは 7。`.temp/` を汚しかつ cleanup が無いのは 21 箇所（`os.tmpdir()` を使う 2 箇所は cleanup 済み）。production scratch（`dispatch.ts:71`）と build scratch（`check-cli-build.sh:9`）は母集団に含めない（どちらも回収済み）。

実測: フルスイート 1 回あたり約 240 entries、レビュー時点で `.temp/` 直下 1938 entries / 287MB。

| 参照元 / 現行実装                                                                                           | 本実装での扱い                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/codex-devcontainer.test.ts:24-26` + `afterEach:171-176`                                            | **採用（参考実装）**。「root を集合に登録 → `afterEach` で一括 `rmSync`」を共通ヘルパの内部実装として一般化する                       |
| `scripts/clean-devcontainer-disk.test.ts:280-289` の `fixtureRoots` + `afterEach`                           | 同上。既に同じ形なので共通ヘルパへ寄せて重複を消す                                                                                    |
| `shared/src/observe-effort.ts:613-643` / `wrapper-cursor.ts:472-565` の `try-finally`                       | **置換**。ケースごとに書く形は追随漏れが起きやすい。共通ヘルパの自動登録へ寄せる                                                      |
| `shared/src/observe-store.ts:826` の `await import('./read-json.ts')`                                       | **採用**。in-source test ブロック内 dynamic import は既存パターン。共通ヘルパの取り込み方をこれに揃える                               |
| `shared/src/prepare.ts:561` のコメント「in-source test 専用 helper (bundle からは treeshake で除去される)」 | 前提として維持。ただし除去は `vite.cli.config.ts:23` の `define` による dead-code 除去に依存するため、§5-c の検証で担保する           |
| `scripts/test-execution-capability.ts:167`（`default export` = globalSetup 実体）                           | **wrapper で拡張**。`assertTestExecutionCapability` 自体は変更せず、default export を「preflight → sweep」の薄い wrapper に差し替える |
| `scripts/clean-devcontainer-disk.test.ts:176-192` の fake `du`                                              | **拡張**。`DU_FAIL_MATCH` と同じ形で「特定 path に固定値を返す」モードを足し、実 `du` 委譲から外す                                    |

cleanup がない 21 箇所（Step 4 / Step 5 の移行対象）:

| ファイル                                   | 行      | prefix                           |
| ------------------------------------------ | ------- | -------------------------------- |
| `scripts/delegate-wrapper-session.test.ts` | 94-96   | `delegate-wrapper-session-test-` |
| `scripts/delegate-run.test.ts`             | 118-120 | `delegate-run-test-`             |
| `shared/src/prepare.ts`                    | 563-565 | `prepare-test-`                  |
| `shared/src/observe-store.ts`              | 829-831 | `observe-store-test-`            |
| `shared/src/wrapper-report.ts`             | 417-419 | `wrapper-report-test-`           |
| `shared/src/wrapper-dedicated.ts`          | 193-195 | `wrapper-dedicated-test-`        |
| `shared/src/wrapper-common.ts`             | 624-626 | `wrapper-common-test-`           |
| `shared/src/wrapper-common.ts`             | 649-652 | `read-tail-test-`                |
| `shared/src/wrapper-wait.ts`               | 384-386 | `wrapper-wait-test-`             |
| `shared/src/prepare-imagegen.ts`           | 183-185 | `prepare-imagegen-test-`         |
| `shared/src/observe-lock.ts`               | 170-172 | `observe-lock-test-`             |
| `shared/src/observe-followup.ts`           | 271-273 | `observe-followup-test-`         |
| `shared/src/delegate-mcp.ts`               | 197-206 | `delegate-mcp-test-`（2 箇所）   |
| `shared/src/build-request.ts`              | 314-317 | `build-request-test-`            |
| `shared/src/build-response.ts`             | 126-127 | `build-response-test-`           |
| `shared/src/read-request.ts`               | 192-193 | `read-request-test-`             |
| `shared/src/read-response.ts`              | 270-271 | `read-response-test-`            |
| `shared/src/read-json.ts`                  | 149-150 | `read-json-test-`                |
| `shared/src/dispatch.ts`                   | 290-292 | `dispatch-test-`                 |
| `shared/src/run-oneshot.ts`                | 364-366 | `run-oneshot-test-`              |

これら 21 箇所は helper 定義がモジュールスコープにあるだけで、**生成呼び出しはすべて `it` の中**にある（`wrapper-common.ts:623` / `delegate-mcp.ts:196` を含む）。したがって §3.1 の test 文脈限定 API で全件を移行できる。

## 3. 設計の中核

### 3.1 共通 scratch ヘルパ（専用 namespace + test 文脈限定）

| 構成要素                                               | 内容                                                                                                            | 配置 / 寿命                                                                                                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/src/test-scratch.ts`                           | scratch root の決定・生成・削除登録・sweep を持つ唯一のモジュール                                               | `shared/src/` 配下だがテスト専用。`sync-shared.ts` は `readdirSync(...).filter(isFile)` で `shared/` 直下と `dist/` のみ配布するため skill には同梱されない |
| root: `.temp/test-scratch/`                            | test 所有物だけを入れる専用 namespace。配下に run 単位のディレクトリを作る                                      | 所有権の境界を**パスの包含関係**で決める（名前マッチに頼らない）                                                                                            |
| `createTestScratchDir(prefix): string`                 | `.temp/test-scratch/<run-id>/<prefix>-<random>/` を作り、`onTestFinished` で削除を予約して返す                  | 呼び出したテストの終了時に削除                                                                                                                              |
| `createTestScratchFile(prefix, suffix): string`        | 単一ファイル用。実体を scratch dir 内に置き、dir ごと削除する                                                   | 同上。`read-json-test-*.json` 等を dir 経由に統一する                                                                                                       |
| test 文脈外での呼び出し                                | **fail-fast**（例外）。`onTestFinished` を張れない文脈で黙って sweep に委ねない                                 | 将来 describe / module スコープから呼ばれた際に「増分 0」を静かに破らないため                                                                               |
| `sweepTestScratch({ root, now, olderThanMs }): number` | 指定 root 配下の owned entry を条件付きで削除し、削除数を返す。root / 時刻を注入できる seam をテスト用に持つ    | globalSetup から呼ぶ安全網                                                                                                                                  |
| `recoverLegacyTestScratch({ root, prefixes }): number` | `.temp/` 直下の**既知 prefix 明示 allowlist**（§2 表の prefix 群）にだけ一致する entry を回収する one-shot 経路 | 移行前の残骸回収。allowlist 外は触らない                                                                                                                    |
| `KEEP_TEST_SCRATCH`                                    | `1` / `true` で削除を全面抑止し、保持したパスを stderr へ 1 行出す                                              | 失敗調査時の opt-out                                                                                                                                        |

専用 namespace を切るのは、`.temp/` 直下を「名前に `-test-` を含むか」で判定すると [AGENTS.md](../../AGENTS.md) の「一時ファイルは `.temp/` 配下に作る」規約に従った**手動作業ディレクトリ**を巻き込み得るため。削除は `.temp/test-scratch/` への包含を検証してから行う。

### 3.2 二層防御（per-test cleanup + 安全網 sweep）

per-test cleanup だけでは、テストプロセスが SIGKILL / ENOSPC で落ちたときに残骸が出る。sweep だけでは 1 回のフルスイート中に 240 entries が生き続ける。両方を置く。

- **一次**: `createTestScratchDir` が張る `onTestFinished`（テスト単位）
- **二次**: `scripts/test-execution-capability.ts` の default export を wrapper 化し、`await assertTestExecutionCapability()` の**完了後にだけ** `sweepTestScratch` を呼ぶ

sweep の削除境界は次の 2 段で決める。

1. **所有権（構造）**: root 自身が symlink でないこと、entry が symlink でないこと、entry の realpath が root 配下に留まることを検証する。削除は realpath ではなく lexical path に対して行い、symlink の参照先を消さない
2. **stale 判定**: run ディレクトリ直下の **ownership marker**（pid / 開始時刻）を読み、正の整数 pid が読めれば**その pid の生存だけ**で判定する。marker が読めない run は最終更新から一定時間（既定 1 時間）経過しているかで判定する

mtime を主判定にしないのは、「ディレクトリ mtime は配下の深いファイル更新では変わらない」ため生存中 session を判別しきれないから。逆に marker が読める run に age 条件を課さないのは、所有 process が消えた run は age を待つ理由がなく、次回実行時に確実に回収したいため。

sweep を teardown ではなく setup 側に置くのは、異常終了時に teardown が走らないことに加え、実測で **teardown は worker pool が閉じる前に走る**ため。teardown 時点では自 run の worker pid が生存しており、pid 判定によって自分の scratch が保護されてしまい回収できない。setup 側なら自 run の worker はまだ存在せず、前回までの run は所有 pid が消えているので確実に回収できる。

各 worker process は run ディレクトリ（marker のみを含む container）を残すため、フルスイート実行中は worker 数ぶんの空 run ディレクトリが存在する。これは次回実行の setup sweep で回収されるので蓄積しない。

sweep 失敗は警告に留め、preflight の fail-closed 契約（`TEST_ENVIRONMENT_UNSUPPORTED` を 1 件返して停止）は変えない。`catch` は sweep 呼び出しだけを狭く囲む。

### 3.3 grouping テストの hermetic 化と production の計測頑健化

`scripts/clean-devcontainer-disk.sh:501-506` は workspace が `/` と同一 filesystem のとき `entry_bytes "$repo_root/.temp"`（= `du -sb`）を無制限に実行する。`--test-root`（`:319,379-397`）は `/vscode` 側の差し替えにしか効かず `repo_root`（`:363`）は実リポジトリのままなので、テスト中もこの `du` は**実際の `.temp/`** を走査する。テストが自分で積んだ残骸を自分で計測して遅くなる自己参照になっている。

なお `df -PhT` の実測ではリポジトリは host mount、`/` は overlay で**別 filesystem**であり、実運用ではこの分岐に入らない。分岐に入るのは fake `df` profile を `fs: overlay, mount: /` に固定するテスト（`:800-816`）だけである。したがって:

- **テスト側（MUST）**: fake `du` に「特定 path へ固定値を返す」モードを足し、`$repo_root/.temp` に対して実 `du` へ委譲しないようにする。これで実行時間がリポジトリ状態から切り離される
- **production 側（SHOULD）**: `entry_bytes` の `.temp` 呼び出しに時間上限を付け、超過時は「計測不能」と明示する。この報告行は情報提供であり掃除の可否判定には使われないため、fallback しても機能は落ちない。上限値は test timeout（`vite.config.ts` の 30 秒）を十分下回る値にし、fake `du` から即座に超過相当を返すテストで経路を検証する

## 4. 実装ステップ

Step 2 は Step 3-6 と独立しており、pre-commit のブロックを最短で解除するため先に置く。

### Step 1: (完了済み) ベースライン計測

- **掃除する前に**記録する: `.temp/` 直下の entry 数、§2 の legacy prefix に一致する entry 数、`du -sh .temp` の秒数、`npm test` の所要時間と pass/fail
- `.temp/` を掃除した直後にフルスイートを 1 回回し、増分 entry 数を prefix 別に取り直す（issue の実測は 2 回ぶんの合算のため）
- 掃除は §2 の legacy prefix にだけ一致させる。`.temp/delegate/` を巻き込まない

成果物: 移行対象リストの確定と、効果判定に使う before 値

### Step 2: (完了済み) grouping テストの hermetic 化

- `scripts/clean-devcontainer-disk.test.ts:176-192` の fake `du` に固定値モードを追加する
- grouping テスト（`:800-816`）で `$repo_root/.temp` に固定値を割り当て、実 `du` へ委譲させない
- 期待文字列の前方一致 `'workspace は / と同一 filesystem: repository の .temp/ ('` は維持する
- `.temp/` に大量の entry を残したまま当該テストが速く通ることを確認する

成果物: リポジトリ状態に依存しない grouping テスト

### Step 3: (完了済み) 共通ヘルパの実装

- `shared/src/test-scratch.ts` に §3.1 の API を実装する。root / 現在時刻を注入できる seam を持たせる
- 同ファイルの `if (import.meta.vitest)` ブロックにテストを追加する（§6）
- `npm run build` → build 出力が `delegate-cli.mjs` のみであることと `git diff --exit-code shared/dist` が clean であることを確認する

成果物: `shared/src/test-scratch.ts` + in-source test

### Step 4: (完了済み) `shared/src` の in-source test を移行

- §2 の表のうち `shared/src/*` 19 箇所の個別 helper を、`await import('./test-scratch.ts')` 経由の共通ヘルパ呼び出しへ置き換える
- `observe-effort.ts` / `wrapper-cursor.ts` の `try-finally` も共通ヘルパへ寄せ、削除の重複記述を消す
- ファイル単位で `npm test -- <file>` を通してから次へ進む

成果物: `.temp/` 直下に残骸を出さない in-source test 群

### Step 5: (完了済み) `scripts/*.test.ts` を移行

- `delegate-wrapper-session.test.ts:92-96`（最大の発生源）と `delegate-run.test.ts:118-120` を共通ヘルパへ移行する
- `codex-devcontainer.test.ts` / `clean-devcontainer-disk.test.ts` の既存 `afterEach` + 集合パターンも共通ヘルパへ寄せる
- フルスイート前後で `.temp/test-scratch/` の entry 増分が 0 であることを確認する

成果物: フルスイート実行後に scratch が増えない状態

### Step 6: (完了済み) 安全網（sweep）と legacy 回収と opt-out

- `scripts/test-execution-capability.ts` の default export を wrapper に差し替える。`assertTestExecutionCapability` 本体は変更しない
  - `await assertTestExecutionCapability()` の完了後にだけ sweep を呼ぶ（probe 失敗時は sweep 未実行）
  - sweep 呼び出しだけを狭く `try/catch` し、失敗は警告で継続する
  - `package.json` の `test` script が呼ぶ直接実行経路は preflight のみのままにし、sweep の二重実行を避ける
- `recoverLegacyTestScratch` を one-shot 経路として用意する（Step 1 で掃除済みなら no-op になる想定）
- `KEEP_TEST_SCRATCH=1` の opt-out を per-test cleanup と sweep の両方に効かせる

成果物: 異常終了・追加漏れがあっても蓄積しない状態

### Step 7: (完了済み) production 側の計測頑健化（SHOULD）

- `.temp` 計測の `entry_bytes` 呼び出しに時間上限を付け、超過時は「計測不能」と明示する
- fake `du` から即座に超過相当を返すテストで fallback 経路を検証する

成果物: 実運用で `.temp/` が肥大しても stall しない計測

### Step 8: (完了済み) development.md 反映と archive 化

- [development.md](../design/development.md) の「テスト」節に、scratch は共通ヘルパ経由で `.temp/test-scratch/` に作る規約、`KEEP_TEST_SCRATCH`、legacy 回収の手動コマンドを追記した
- 本ドキュメントを `docs/archive/test-scratch-cleanup.archive.md` へリネームした

成果物: development.md 更新 + archive（archive 化はユーザー確認後）

## 5. 設計判断

### a. cleanup の駆動方法

| 候補                                                   | 採用 | 理由                                                                                                                              |
| ------------------------------------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| **共通ヘルパ + `onTestFinished`（test 文脈限定）**     | ✓    | 生成と削除が 1 箇所で対になり追随漏れが起きにくい。移行対象 21 箇所はすべて `it` 内で生成しているため全件が対象になる             |
| ケースごとの `try-finally`                             | ✗    | 既存の `observe-effort.ts` / `wrapper-cursor.ts` がこの形だが、ケースを増やすたびに書き足す必要があり 21 箇所への展開で漏れが出る |
| ファイルごとの `afterEach` + 集合（現行の 2 ファイル） | △    | 動いてはいるが 21 箇所へコピペすることになる。共通ヘルパの**内部実装**として採る                                                  |
| test 文脈外を許容し sweep へ委ねる                     | ✗    | 「フルスイート後の増分 0」が静かに破れる。文脈外は fail-fast にして設計意図を強制する                                             |
| globalSetup の teardown で一括削除                     | ✗    | run 中は残り続けるため `du` の劣化が当該 run 内で解消しない。異常終了時は teardown 自体が走らない                                 |

### b. 共通ヘルパの置き場所

| 候補                             | 採用 | 理由                                                                                                                                                            |
| -------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`shared/src/test-scratch.ts`** | ✓    | in-source test（19 箇所）と `scripts/*.test.ts`（4 ファイル）の両方から参照できる。`sync-shared.ts:47-51` は `isFile()` で絞るため `shared/src/` は配布されない |
| `scripts/test-scratch.ts`        | ✗    | `shared/src/` からの参照が `../scripts/` を跨ぐ。実装の正本が `shared/src/` に閉じる現行構成を崩す                                                              |
| 各ファイルに個別実装             | ✗    | 現状そのもの。21 箇所の重複を残す                                                                                                                               |

### c. 共通ヘルパの import 形態と配布物の検証

| 候補                                                      | 採用 | 理由                                                                                                                     |
| --------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------ |
| **`import.meta.vitest` ブロック内の `await import(...)`** | ✓    | `observe-store.ts:826` の既存パターン。production の import graph に静的な module edge を作らない                        |
| top-level の static import                                | ✗    | treeshake で消える見込みではあるが、production import graph にテスト専用モジュールが載る。混入時の切り分けコストも増える |

いずれの形でも除去は `vite.cli.config.ts:23` の `define: { 'import.meta.vitest': 'undefined' }` による dead-code 除去に依存する。「DCE に依存しない」とは言えないため、検証で担保する。`scripts/check-cli-build.sh:14` は `delegate-cli.mjs` 1 ファイルしか `cmp` しない一方、`scripts/sync-shared.ts:53-62` は `shared/dist/` 内の**全ファイル**を配布するため、dynamic import が chunk として残ると byte 比較を通り抜けたまま各 skill へ同期され得る。受け入れ基準に「build 出力集合が `delegate-cli.mjs` のみ」と `git diff --exit-code shared/dist` を加える。

### d. 安全網 sweep の削除境界

| 候補                                                      | 採用 | 理由                                                                                                                                     |
| --------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **専用 namespace への包含 + ownership marker + age 条件** | ✓    | 所有権をパスで決めるため、AGENTS.md 規約に従った手動作業ディレクトリを巻き込まない。生存 pid を marker で判定し、age は補助条件にする    |
| `.temp/` 直下の `-test-` 名前マッチ + mtime               | ✗    | 手動作業ディレクトリが同じ文字列を含めば削除対象になる。ディレクトリ mtime は配下の深い更新で変わらないため、生存 session を判別できない |
| 対象未限定の「`.temp/` を掃除」                           | ✗    | scope 外と明示した `.temp/delegate/` まで消し得る                                                                                        |
| sweep を入れない                                          | ✗    | per-test cleanup の追随漏れと異常終了で蓄積が再発する                                                                                    |

legacy の `.temp/` 直下残骸は sweep の対象にせず、§2 表の prefix を明示 allowlist にした one-shot 回収（`recoverLegacyTestScratch`）で扱う。恒常経路に名前マッチを持ち込まないための分離。

### e. sweep のタイミング

| 候補                            | 採用 | 理由                                                                                                |
| ------------------------------- | ---- | --------------------------------------------------------------------------------------------------- |
| **globalSetup の setup 時**     | ✓    | 異常終了で残った分を次回実行で回収できる。preflight の完了後に置けば fail-closed 契約を保てる       |
| teardown 時                     | ✗    | 異常終了時に走らないため、肝心のケースを取りこぼす                                                  |
| `package.json` の `test` script | ✗    | 直接実行経路と globalSetup の両方で走り、二重実行になる。`vp test` 直接実行時に効かない経路差も生む |

### f. scratch root

| 候補                                                 | 採用 | 理由                                                                                                                               |
| ---------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **`.temp/test-scratch/`（`.temp/` 配下の専用 dir）** | ✓    | AGENTS.md の規約に従いつつ、所有権の境界を作れる。リポジトリは host mount 側にあり（`df -PhT` 実測）、コンテナディスクを圧迫しない |
| `.temp/` 直下を維持                                  | ✗    | 手動作業と混在し、安全な削除境界を引けない（§5-d）                                                                                 |
| `os.tmpdir()` へ移す                                 | ✗    | 規約から外れる。`/tmp` はコンテナディスク（overlay）側で、そちらを圧迫する方が悪化する                                             |
| 環境変数で root を切り替え可能にする                 | △    | 利用者向けの切り替えは足さない。ただし単体テスト用の**注入 seam**（引数）はヘルパ API に持たせる                                   |

### g. grouping テストの扱い

| 候補                                           | 採用 | 理由                                                                                                                              |
| ---------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| **fake `du` で `$repo_root/.temp` を固定値化** | ✓    | テストがリポジトリの外部状態に依存しなくなる。scope 外の `.temp/delegate/` や手動作業が増えても再発しない                         |
| production 側の時間上限だけで対応              | ✗    | 上限に達するまでの時間はテストに乗るため、依存自体は消えない。production の頑健化としては別途価値があるので SHOULD で併用（§3.3） |
| 当該テストの timeout を延ばす                  | ✗    | 症状の緩和にすぎず、蓄積が進めばまた越える。issue でも「蓄積自体は止まらない」と指摘されている                                    |
| scratch 蓄積の解消（Step 3-6）だけで済ませる   | ✗    | テストが外部状態に依存する構造が残るため、scope 外の要因で再発する                                                                |

## 6. テスト方針

live な `.temp/` の件数を assert しない。検証は注入した隔離 root 配下の synthetic fixture で決定論的に行う。

### 自動テスト

- `shared/src/test-scratch.ts` の in-source test
  - 正常系: `createTestScratchDir` が `.temp/test-scratch/` 配下に一意な dir を作り、テスト終了後に消えている
  - 正常系: `createTestScratchFile` が返すパスに書き込め、親 dir ごと回収される
  - 境界条件: `sweepTestScratch` が注入 root と注入時刻のもとで、age 条件を満たす owned entry だけを消す
  - 境界条件: 生存 pid の ownership marker を持つ entry は age 条件を満たしても消さない
  - 境界条件: 正の整数でない pid の marker は無視され、age 判定へ落ちる
  - 境界条件: 注入 root の外を指す path（symlink 経由を含む）を削除しない
  - 境界条件: root 配下を指す symlink でも、参照先ではなく symlink 自身しか対象にしない
  - 異常系: root 自身が symlink の場合は削除せず例外を投げる
  - 異常系: ENOENT 以外の readdir 失敗を成功（0 件）として報告しない
  - 境界条件: `recoverLegacyTestScratch` が allowlist prefix にだけ一致し、`delegate` などの非対象 entry を残す
  - 境界条件: allowlist prefix の名前を持つ symlink があっても、参照先を削除しない
  - 異常系: test 文脈外の `createTestScratchDir` 呼び出しが fail-fast し、run ディレクトリを残さない（元例外を `cause` に保持する）
  - 異常系: `KEEP_TEST_SCRATCH=1` で削除が抑止され、パスが報告される
  - 異常系: 削除対象が既に存在しない場合に例外を投げない（冪等）
- `scripts/test-execution-capability.test.ts`
  - probe 失敗時に sweep が呼ばれず、`TEST_ENVIRONMENT_UNSUPPORTED` が 1 件だけ返る
  - sweep 失敗が警告に落ち、preflight 成功を覆さない
- `scripts/clean-devcontainer-disk.test.ts`
  - grouping テスト（`:800-816`）が fake `du` の固定値で通り、実 `du` を `$repo_root/.temp` に対して呼ばない
  - `.temp` 計測が時間上限を超えた場合に「計測不能」表示へ fallback し、exit 0 を保つ（Step 7）

### 手動確認

- [x] `.temp/test-scratch/` を掃除 → `npm test` → 同ディレクトリの entry 増分が 0
- [ ] `npm test` を 2 回連続実行しても増分 0、かつ 2 回目も全 pass
- [ ] `.temp/` に synthetic な entry を 2000 件置いた状態で `npm test -- clean-devcontainer-disk` が速く通る（hermetic 化の確認）
- [ ] `KEEP_TEST_SCRATCH=1 npm test -- delegate-wrapper-session` で scratch が残り、パスが報告される
- [ ] `npm run build` 後、`shared/dist/` の出力が `delegate-cli.mjs` のみで `git diff --exit-code shared/dist` が clean
- [ ] `npm run build:check`
- [ ] `npm run sync-shared:check`
- [ ] `vp check`
- [ ] `bash scripts/check-no-jq-md2idx.sh`
- [ ] `npm run metrics:baseline:check`
- [ ] `bash scripts/clean-devcontainer-disk.sh --dry-run` が従来どおり動く

## 7. 受け入れ基準

- §1 の MUST 要件をすべて満たす
- grouping テストの実行時間が `.temp/` の entry 数に依存しない
- フルスイートを連続実行しても `.temp/` 直下に新しい `*-test-*` entry が増えない
- `.temp/test-scratch/` に残るのは実行中の run ディレクトリのみで、次回実行の setup sweep で回収される
- `shared/dist/` の出力集合が `delegate-cli.mjs` のみで、その byte が変わらない（テスト専用コードが配布物へ混入していない）
- `scripts/sync-shared.manifest.json` に新規 dist entry が増えていない
- 新規挙動（ヘルパ / sweep / legacy 回収 / opt-out / hermetic fake `du`）に対応するテストがある
- preflight の fail-closed 契約が保たれている（probe 失敗時に sweep 未実行、`TEST_ENVIRONMENT_UNSUPPORTED` は 1 件）
- pre-commit hook の全ゲート（`sync-shared:check` / `vp check` / `check-no-jq-md2idx` / `metrics:baseline:check` / `npm test`）が通る
- development.md が実装と一致している

Step 7（production の `du` 時間上限）は SHOULD のため、未実施でも上記は満たせる。実施した場合は fallback 経路のテストが追加されていることを確認する。

## 8. 想定リスクと回避策

| リスク                                                               | 回避策                                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| sweep が手動作業や並行 session の scratch を消し、データ消失を起こす | 専用 namespace への包含を realpath で検証し、ownership marker の生存 pid を主判定にする（§5-d）。age は補助条件           |
| legacy 回収が `.temp/delegate/` など scope 外を巻き込む              | 明示 allowlist（§2 表の prefix）に限定し、恒常経路とは別 API に分ける                                                     |
| テスト専用ヘルパが bundle に混入し配布される                         | dynamic import に限定したうえで、build 出力集合の検証と `git diff --exit-code shared/dist` を受け入れ基準に入れる（§5-c） |
| sweep の `catch` が preflight の fail-closed を格下げする            | default export を wrapper 化し、sweep 呼び出しだけを狭く囲む。probe 失敗時は sweep を呼ばない（§3.2）                     |
| cleanup 導入で失敗時の調査材料が消える                               | `KEEP_TEST_SCRATCH=1` の opt-out を用意し、保持時はパスを stderr に出す                                                   |
| 21 箇所の一括移行で既存テストが壊れる                                | Step 4 / Step 5 をファイル単位で進め、各ファイルで `npm test -- <file>` を通してから次へ進む                              |
| `du` の時間上限 fallback が、本来必要な警告を握りつぶす              | fallback 時は「計測不能」と明示し、無言で `0` を表示しない                                                                |
| 実測値（1938 entries 等）を受け入れ基準に使い、再現不能になる        | live 件数は Step 1 の before 値としてのみ記録し、判定は隔離 root の synthetic fixture で行う（§6）                        |

## 9. 参考

- [issue #30](https://github.com/oubakiou/delegate-skills/issues/30)
- [development.md](../design/development.md)（テスト / shared 同期 / git hooks の各節）
- [spec.md](../design/spec.md)
- [devcontainer-disk-cleanup.archive.md](../archive/devcontainer-disk-cleanup.archive.md)（`clean-devcontainer-disk.sh` の設計経緯）
- Vitest 4 の `onTestFinished` / `globalSetup`
