# devcontainer ディスククリーニング定型化 設計・実装計画

[![MKDN](https://img.shields.io/badge/MKDN-review-red?style=for-the-badge)](https://mkdn.review/?url=https%3A%2F%2Fraw.githubusercontent.com%2Foubakiou%2Fdelegate-skills%2Frefs%2Fheads%2Fmain%2Fdocs%2Ffeature%2Fdevcontainer-disk-cleanup.md)

[development.md のセットアップ節](../design/development.md#セットアップ)に対応し、devcontainer のコンテナディスクが再生成可能なキャッシュで満杯になり全ツールが停止する事象（ENOSPC）に対して、再蓄積を予防する定型スクリプトの設計判断と実装手順をまとめる。完了後は development.md に永続情報を移し、本ファイルは archive する。

2026-07-21 の障害時には約 11.6GB を回収できたが、これは当時のキャッシュ量である。2026-08-08 の現環境で列挙できた候補は最大でも約 1.78GB であり、全量を回収しても `/` は 90% 台に残る見込みである。本スクリプトは現在の逼迫を単独で解消する手段ではなく、安全に回収できるキャッシュの再蓄積を予防する手段と位置づける。

## 1. 対応スコープ

| 要件                                                                 | 開始時の状態                                                                                                     | 完了条件                                                                                                                                                                                                      | 最終状態 | 状態   |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| [MUST] 再生成可能キャッシュを冪等に回収するスクリプトを提供する      | 手動調査 + 個別 `rm` / `npm cache clean` の非定型作業（2026-07 の障害対応で実施）                                | `scripts/clean-devcontainer-disk.sh` が固定 allowlist 内で非使用を証明できる entry だけを列挙・削除し、before / after・候補量・回収量・未回収量を filesystem ごとに報告する。連続実行しても安全である         | 未実装   | 未着手 |
| [MUST] 使用中または判定不能なリソースを誤削除しない fail-safe を持つ | 使用中リソースの特定は手動（`ps` 目視）                                                                          | process listing の成功・該当なしと取得失敗を区別し、使用中または非使用を証明できない category / entry は skip する。共有 `/vscode` の server bin 世代は自動削除しない                                         | 未実装   | 未着手 |
| [MUST] 使用率と絶対空き容量を併用した毎起動時の自動実行経路を持つ    | 掃除は障害発生後の手動対応のみ。`.devcontainer/devcontainer.json` は `postCreateCommand`（初回のみ）しか持たない | `postStartCommand` と `local_setup.sh` が同じ non-blocking wrapper から `--threshold 90` で呼ぶ。`/`・`/vscode`・`$HOME`・workspace の filesystem identity と容量を実行時に測り、掃除後も条件超過なら警告する | 未実装   | 未着手 |
| [SHOULD] コンテナ内で解決できない場合の診断手順をユーザーに案内する  | コンテナ側とホスト側の使用量を混同しやすい                                                                       | スクリプト出力が現在の観測結果を示し、host では `docker system df` で内訳を確認してから対象を限定するよう案内する。削除操作は危険性と適用条件を併記する                                                       | 未実装   | 未着手 |
| [SHOULD] 削除せず対象だけ確認できる dry-run と手動確認情報を提供する | なし                                                                                                             | `--dry-run` が自動削除候補・skip・手動確認が必要な `/vscode/vscode-server/bin` 世代と各推定量を表示し、ファイルシステムを変更しない                                                                           | 未実装   | 未着手 |
| [SHOULD] 確立した運用を由来テンプレートへ還元する                    | 本リポジトリ固有の計画のみ                                                                                       | 本リポジトリの実装完了後、別 follow-up でテンプレート側の構成差を確認して移植可否を判断する。本計画の完了条件にはしない                                                                                       | 未実装   | 未着手 |

スコープ外:

- `/vscode/vscode-server/bin` の世代自動削除: `/vscode` は Dev Containers が自動付与する共有 named volume 上の独立マウントであり、devcontainer は private PID namespace を使う。他コンテナが使用中の世代を現在コンテナの `ps` では判定できず、fail-safe の MUST を証明できない。dry-run で世代・サイズを提示し、全利用コンテナの停止を利用者が確認した場合の手動削除だけを案内する
- ホスト Docker Desktop VM 側の掃除: コンテナ内から現在の使用量や内訳を観測できない。スクリプトは host での診断手順の案内までを責務とする
- `.temp/` / delegate run スクラッチの自動掃除: リポジトリ実体は fakeowner の host mount 上にあり、現環境ではコンテナディスクを圧迫しない。実行時の filesystem identity が異なる場合だけこの結論を適用し、同一の場合は手動 emergency 候補として提示する。delegate run retention は既存の `DELEGATE_RUN_RETENTION_DAYS` が所有する
- `~/.vscode-server/extensions`（拡張本体）の削除: 使用中の可能性があり、キャッシュではないため対象にしない
- cron / 常駐監視: devcontainer は再作成が頻繁で持続性が保証されず、起動時ワンショットで十分（§5.b）

## 2. ベースライン / リファレンス

### 2.1 参照元と扱い

| 参照元 / 現行実装                                                                                  | 本実装での扱い                                                                                   |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 2026-07-21 の ENOSPC 障害対応（手動）                                                              | 当時の回収対象と容量を履歴として保持し、現況とは分けて扱う（§2.2）                               |
| `local_setup.sh`                                                                                   | `set -euo pipefail` 下で冒頭が `npm ci` であるため、その前に non-blocking cleanup wrapper を置く |
| `.devcontainer/devcontainer.json`                                                                  | 現在は `postCreateCommand: ./local_setup.sh` のみ。`postStartCommand` を追加する                 |
| `scripts/*.test.ts`                                                                                | shell 契約テストを子プロセスで起動する既存パターンとして踏襲する                                 |
| `DELEGATE_RUN_RETENTION_DAYS`（既存の retention 機構）                                             | delegate run スクラッチの掃除は引き続きこちらが所有し、本スクリプトは重複して扱わない            |
| [typescript-agent-package-template](https://github.com/oubakiou/typescript-agent-package-template) | devcontainer 構成の由来元。移植は本リポジトリの完了を妨げない SHOULD / follow-up として扱う      |

### 2.2 実測

#### 2026-07-21 障害時

コンテナディスク `/dev/vda1` 71GB が使用率 100%（空き 2.4MB）となり、Bash ツール実行を含む全書き込みが停止した。当時の手動対応では約 11.6GB を回収し、使用率は 100% から 83% になった。この 11.6GB は当時値であり、継続的な回収保証値ではない。

| 対象                                              | 当時の実測サイズ | 分類                                     | 当時の対応                        |
| ------------------------------------------------- | ---------------- | ---------------------------------------- | --------------------------------- |
| `/vscode/vscode-server/extensionsCache`（126 件） | 6.7GB            | 再生成可能キャッシュ（root 所有）        | sudo で一括削除                   |
| `/vscode/vscode-server/bin/linux-arm64`（8 世代） | 3.8GB            | server bin 世代（root 所有）             | 現コンテナの使用中 1 世代を残した |
| `~/.npm/_cacache`                                 | 1.6GB            | 再生成可能キャッシュ                     | `npm cache clean --force`         |
| `~/.vscode-server/extensionsCache`                | 342MB            | 再生成可能キャッシュ                     | 一括削除                          |
| `~/.local/share/cursor-agent/versions`（3 世代）  | 592MB            | agent 世代                               | 未対応                            |
| `~/.codex/.tmp`                                   | 88MB             | 一時ファイル                             | 未対応                            |
| ホスト Docker Desktop VM 側                       | 当時の差分推定値 | コンテナ内から現在値を観測・操作できない | host 側診断が必要と判断           |

当時の `/vscode` 一括削除と server bin の自動世代判定は、安全な無人実行の前例とはみなさない。

#### 2026-08-08 再実測

`/` は 71G 中 64G 使用、使用率 95%、空き 3.7G だった。`/vscode` は `/dev/vda1` の独立マウントで、Dev Containers が devcontainer.json の `mounts` 記述なしに自動付与する共有 named volume に由来する。リポジトリ実体 `/workspaces/delegate-skills` は fakeowner の host mount である。

| 対象                                    | 実測サイズ | 自動処理方針                                                                                               |
| --------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| `/vscode/vscode-server/extensionsCache` | 261M       | 共有 volume 全体の非使用を証明できない entry は skip。entry 単位で dry-run / 手動確認情報を出す            |
| `~/.vscode-server/extensionsCache`      | 532M       | directory 一括ではなく、非使用を証明できた direct child entry だけを削除                                   |
| `~/.npm/_cacache`                       | 220M       | npm 経由または安全検証後の `_cacache` 直接削除候補                                                         |
| `~/.local/share/cursor-agent/versions`  | 681M       | process 状態と世代形式を検証し、非使用を証明できた旧世代だけを削除                                         |
| `~/.codex/.tmp`                         | 88M        | codex process が存在せず非使用を証明できる場合だけ削除。現環境では app-server 常駐により skip が見込まれる |
| `/vscode/vscode-server/bin` の旧世代    | 0          | 1 世代のみ。自動削除対象外                                                                                 |

列挙サイズの合計は約 1.78GB で、これは安全判定前の上限である。共有 volume、稼働 process、entry ごとの判定で skip される分があるため、実回収見込みは約 1.8GB 以下となる。全量を回収しても `/` は 90% 台に残る見込みであり、現在の逼迫は別途診断が必要である。

## 3. 設計の中核

### 3.1 スクリプト構成と観測契約

| 構成要素                                  | 内容                                                                                                                                    | 配置 / 寿命                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `scripts/clean-devcontainer-disk.sh`      | filesystem 観測 → entry 列挙 → fail-safe 判定 → category ごとの削除 → before / after と host 診断案内の報告。`--dry-run` / 閾値引数付き | リポジトリ常設。手動・起動時の両方から呼ぶ |
| devcontainer `postStartCommand`           | 毎起動時に `--threshold 90` を明示し、同時に絶対空き容量の既定下限を適用する。スクリプトの非 0 は警告に変換して lifecycle を継続する    | `.devcontainer/devcontainer.json` に追加   |
| `local_setup.sh` からの呼び出し           | `npm ci` / `npm install` より前に `--threshold 90` で呼び、`postStartCommand` と同じ non-blocking wrapper 契約を使う                    | 既存セットアップフローの冒頭に追加         |
| `scripts/clean-devcontainer-disk.test.ts` | `.temp/` fixture と PATH 先頭の fake command から shell script を子プロセス起動する Vitest 契約テスト                                   | `scripts/` 配下の test 成果物              |

CLI 引数なしは手動の無条件実行とする。startup は `--threshold 90` を必ず明示し、このモードでは root filesystem の使用率 90% 以上、または絶対空き容量が既定下限 5GiB 未満のどちらかで掃除を開始する。`--min-free-bytes` で絶対下限を明示変更できるようにし、percentage 単独では判定しない。これら 2 つの default を混同しない。

実行時は `/`・`/vscode`・`$HOME`・workspace root について、canonical path、device ID、`df -P` の filesystem / mount point / blocks / used / available / capacity、`df -Pi` の inode 使用状況を測る。存在しない path はその旨を報告し、他 category の処理は継続する。同じ device ID / filesystem に属する path を明示し、`/workspaces` という親 path の種別からリポジトリ実体を推測しない。

報告は filesystem と category ごとに before / after、削除候補量、回収量、skip 量、partial failure により未回収となった量を分ける。掃除後も使用率 90% 以上または絶対空き容量 5GiB 未満なら警告し、自動削除対象外を含む診断へ誘導する。dry-run も同じ観測と候補量を表示し、変更だけを行わない。

### 3.2 fail-safe 規則

- production の削除 root は固定 allowlist（`~/.vscode-server/extensionsCache`、`~/.npm/_cacache`、`~/.local/share/cursor-agent/versions`、`~/.codex/.tmp`、安全を証明できる場合のみ `/vscode/vscode-server/extensionsCache`）から構成し、引数や任意環境変数で置換できない
- `/vscode/vscode-server/bin` は世代数や `ps` 結果にかかわらず自動削除しない。dry-run は direct child の世代名・サイズを手動確認候補として表示するが、削除コマンドは実行しない
- extensionsCache は directory を一括削除しない。完成済み形式の direct child entry について、process listing が成功して該当 process / entry 参照がなく、lock / partial download がなく、削除直前の再検証でも同じ状態である場合だけ削除する。共有 `/vscode` では他コンテナの liveness を確認できないため、その証明が成立しない entry は skip する
- process listing は `clear`（取得成功かつ該当なし）、`active`（取得成功かつ該当あり）、`unknown`（取得失敗）の 3 状態とする。削除を許すのは `clear` のみで、`active` と `unknown` は理由を分けて skip 報告する
- cursor-agent 旧世代は process 状態が `clear` のときだけ、basename の version 形式と順序を検証して最新 1 世代を retained set に固定し、それ以外の direct child を候補にする。世代判別不能・未知形式・再検証失敗は skip する
- `~/.codex/.tmp` は codex process 状態が `clear` の場合だけ entry 単位で削除する。同梱 `openai.chatgpt` extension 由来の codex app-server が常駐する環境では `active` となり、この category が恒常的に skip され得ることを正常な観測として報告する
- `/vscode` 配下で削除可能な entry がある場合は非対話 `sudo -n` を使う。利用不能なら `/vscode` category だけを skip し、HOME 側の独立 category は継続する。`/vscode` 不在も同様に category 単位の no-op とする
- npm cache は通常の `npm cache clean --force` に加え、満杯時に npm 自身が log 等を書けず起動しない場合に備えて、固定 allowlist の `~/.npm/_cacache` を安全検証後に直接削除する実装も選択肢とする。どちらも HOME と canonical path を検証し、他の npm directory は対象にしない
- 列挙は NUL-safe（`find ... -print0` と `read -r -d ''` 相当）に行い、pathname を扱う command には `--` を付ける。symlink は走査・追跡・削除せず、削除直前に allowlist root の direct child、canonical parent、basename format、retained set、非 symlink を再検証する。候補消失は race による skip として扱う

### 3.3 終了コード・部分失敗・注入境界

起動フックから無人実行されるため、終了コードを契約として固定する。

| 終了コード | 意味                                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 0          | 回収成功・no-op（閾値未満 / 候補なし）・安全判定による category / entry skip を含む正常系。skip 理由と量は出力で報告                |
| 1          | operational failure。1 つ以上の category で観測・列挙・`du`・権限昇格・削除等が失敗した状態。独立 category の処理を継続してから返す |
| 2          | 引数エラー                                                                                                                          |

category 内の失敗は当該 category で捕捉し、削除済み / 未削除の entry と量を partial failure として報告する。安全判断による skip、path 不在による no-op、処理途中の partial failure を別状態にする。`sudo -n` preflight 後の失敗、権限変化、`du` failure、候補消失などで最初の category が失敗しても、独立する HOME 側 category は継続する。最後に operational failure が 1 件でもあれば exit 1 を返す。

test root の注入は明示的な test mode に限り、canonical path が repository root の `.temp/` 自身またはその配下である場合だけ許可する。空文字、`/`、repository root、`.temp-other`、traversal、canonical 化で `.temp/` 外へ出る path を拒否する。fake `df` / `ps` / `sudo` / `npm` は command 文字列を評価せず、テストプロセスの PATH 先頭に置く executable として注入する。production allowlist と削除直前の invariant は test mode でも緩めない。

`local_setup.sh` では `set -euo pipefail` の直後、`npm ci` / `npm install` より前に次の wrapper を置く。`postStartCommand` も同じ本体を `bash -lc` で実行し、script 不在・exit 1・exit 2 を含む非 0 を警告へ変換したうえで wrapper 自体は exit 0 とする。

```sh
cleanup_status=0
bash scripts/clean-devcontainer-disk.sh --threshold 90 || cleanup_status=$?
if [ "$cleanup_status" -ne 0 ]; then
  printf 'warning: devcontainer disk cleanup failed (exit %s); continuing startup\n' "$cleanup_status" >&2
fi
```

## 4. 実装ステップ

### Step 1: (未着手) スクリプト実装

- `scripts/clean-devcontainer-disk.sh` に §3 の観測 / entry 列挙 / fail-safe / category 単位の削除 / 報告を実装する
- CLI 引数なしの無条件実行、`--dry-run`、`--threshold <pct>`、`--min-free-bytes <bytes>` と固定終了コードを実装する
- host 側は `docker system df` を起点とする診断案内だけを出し、固定容量や一律の削除指示を出さない

成果物: 冪等な掃除スクリプト + dry-run

### Step 2: (未着手) 毎起動実行の統合

- `local_setup.sh` の `npm ci` / `npm install` より前に §3.3 の wrapper を追加する
- `.devcontainer/devcontainer.json` に同じ wrapper 契約の `postStartCommand` を追加する
- 両経路が `--threshold 90` と絶対空き容量の既定下限を使い、スクリプトの全非 0 と script 不在を警告後に継続することを確認する

成果物: 初回作成と毎起動の自動予防経路

### Step 3: (未着手) テストと実機検証

- `scripts/clean-devcontainer-disk.test.ts` に §6 の Vitest 契約テストを実装する
- 実 devcontainer で dry-run → 実実行 → 再実行（冪等性）を確認し、観測値と skip / partial failure の記録を残す
- `npx vp check` と `npm test -- scripts/clean-devcontainer-disk.test.ts` を通す

成果物: shell 契約テスト + 実機検証記録

### Step 4: (未着手) development.md 反映

- development.md のセットアップ節に手動コマンド、startup 契約、ENOSPC 時の filesystem identity / `df` 確認、本スクリプト、host 側診断の順を追記する
- host 側は `docker system df` で内訳を確認してから対象を限定し、prune / volume / Docker Desktop reclaim を別手順として説明する

成果物: development.md 更新

### Step 5: (未着手) archive 化

- §7 の受け入れ基準を満たし、development.md へ永続情報を移した後、本ドキュメントを `docs/archive/devcontainer-disk-cleanup.archive.md` に移す

成果物: archive（ユーザー確認後）

### Step 6: (未着手) テンプレートへの還元（SHOULD / follow-up）

- [typescript-agent-package-template](https://github.com/oubakiou/typescript-agent-package-template) 側の `local_setup.sh` / devcontainer hook / ドキュメント規約との差異を別 plan で確認する
- 安全 invariant と診断順を維持できる場合に移植し、外部 PR は本リポジトリの完了条件から独立させる

成果物: follow-up plan またはテンプレート側 PR

## 5. 設計判断

### a. 実現形態

| 候補                                  | 採用 | 理由                                                                                                            |
| ------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------- |
| **リポジトリ常設の shell スクリプト** | ✓    | 固定 allowlist と明示的な安全 invariant で決定論的に処理でき、`local_setup.sh` という運用スクリプトの前例に沿う |
| Claude Code skill（`/clean-disk`）    | ✗    | LLM を挟む必然性がなく、token を消費する。決定論的な処理は skill にしない方針と整合しない                       |
| エージェントへの都度依頼（非定型）    | ✗    | 障害のたびに調査からやり直しになり、filesystem の混同による誤診も再発し得る                                     |

### b. 実行トリガー

| 候補                                            | 採用 | 理由                                                                                                 |
| ----------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------- |
| **起動時ワンショット（使用率 + 絶対空き容量）** | ✓    | devcontainer の寿命と一致し、percentage が低くても絶対空き容量が危険な大容量 filesystem を見逃さない |
| percentage 単独の閾値                           | ✗    | filesystem 容量によって同じ percentage の意味が変わり、現状の回復余地も判定できない                  |
| cron / 常駐監視                                 | ✗    | コンテナ再作成で消え、持続性の保証に追加の仕組みが要る                                               |
| 手動実行のみ                                    | ✗    | 満杯になってからでは shell や npm 自体が失敗し、実行手段を失っている可能性がある                     |

### c. 削除対象の範囲

| 候補                                                 | 採用 | 理由                                                                                                                |
| ---------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------- |
| **固定 allowlist 内で非使用を証明できる entry のみ** | ✓    | directory 一括削除を避け、使用中・判定不能・未知形式を skip することで無人実行に耐える                              |
| `/vscode/vscode-server/bin` の自動世代削除           | ✗    | 共有 named volume と private PID namespace の組み合わせでは、他コンテナが使用中の世代を現在コンテナから判定できない |
| 拡張本体・判定不能な cache/tmp を含む積極削除        | ✗    | IDE 接続断、download 競合、agent の一時データ破損につながる                                                         |
| host Docker resource をスクリプトから削除            | ✗    | コンテナ内から現在の host 側内訳を観測できず、削除対象を安全に限定できない                                          |

### d. host 側診断

| 候補                                            | 採用 | 理由                                                                                                               |
| ----------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------ |
| **`docker system df` で内訳確認後に対象を限定** | ✓    | image / container / local volume の現在値を host で確認してから、その原因だけを扱える                              |
| `docker system prune` を一律に案内              | ✗    | stopped container や未使用 network / image を削除し得る一方、volume や仮想ディスク reclaim が原因なら解消しない    |
| volume 削除を一律に案内                         | ✗    | named volume には共有 VS Code server や永続データがあり、利用コンテナと backup の確認なしでは data loss になり得る |

案内では、まず host で `docker system df` と対象 resource の参照状況を確認する。`docker system prune` は削除対象一覧を確認し、不要な stopped resource に限定できる場合だけ別手順で実行する。volume は利用コンテナ停止・不要確認・必要な backup 後だけ個別削除する。Docker Desktop の仮想ディスク reclaim は Docker data の論理削除後も host disk が戻らない場合に、製品・version 対応手順を確認して実行する。

## 6. テスト方針

### 自動テスト

成果物は `scripts/clean-devcontainer-disk.test.ts` とする。`vite.config.ts` の `includeSource` は shell script を収集しないため、既存の `scripts/*.test.ts` と同様に TypeScript test から shell script を子プロセス起動する。fixture は repository `.temp/` 配下に作成し、HOME を明示し、PATH 先頭に fake `df` / `ps` / `sudo` / `npm` を置く。正規コマンドは `npm test -- scripts/clean-devcontainer-disk.test.ts` とし、npm script の子プロセス preflight と Vitest `globalSetup` の両方を適用する。

- filesystem 観測・閾値・報告
  - `/`・`/vscode`・HOME・workspace が同一 / 別 filesystem の場合を fake `df` と fixture で再現する
  - 使用率 89% / 90% / 91%、絶対空き容量の下限直前 / 一致 / 直後、inode 枯渇を検証する
  - before / after、候補量、skip 量、未回収量、掃除後も閾値超過する場合の警告を検証する
  - CLI 引数なしは無条件、startup の `--threshold 90` は使用率と絶対下限の OR 条件になることを検証する
- process と候補列挙
  - fake `ps` の `clear` / `active` / `unknown` を区別し、`unknown` を該当なしとして扱わない
  - extensionsCache は entry 単位で列挙し、lock / partial / process 参照 / 起動競合 / 共有 `/vscode` で証明不能な entry を skip する
  - codex app-server 常駐時に `~/.codex/.tmp` を正常 skip し、cursor-agent の retained set と未知 version を保持する
  - `/vscode/vscode-server/bin` は dry-run で手動候補を表示しても実行時に削除しない
- 削除 invariant
  - 空 root、`/`、traversal、leading dash、newline、空白、symlink、`.temp/` 外へ解決される test root を拒否する
  - allowlist root の direct child、basename format、retained set、非 symlink を削除直前に再検証する
  - NUL-safe な列挙で正しい entry だけを削除し、候補消失は race skip になる
  - 連続実行で候補が空になる（冪等性）
- 部分失敗・終了コード・hook
  - no-op / safety skip は exit 0、`du` / `sudo` / delete / npm failure と partial delete は独立 category を継続後に exit 1、引数エラーは exit 2 になる
  - `npm cache clean --force` が起動不能でも、安全検証済み `_cacache` 直接削除の経路を検証する
  - `local_setup.sh` / `postStartCommand` wrapper は script 不在と exit 1 / 2 を警告し、wrapper 自体は exit 0 になる

### 手動確認

- [ ] 実 devcontainer の dry-run で §2.2 の path と filesystem identity が一致し、server bin は手動候補にしかならない
- [ ] 実実行後に before / after、候補量、回収量、skip 量、未回収量が category / filesystem ごとに表示される
- [ ] 実行中の IDE・拡張・cursor-agent・codex app-server に影響がない
- [ ] 直後の再実行が安全な no-op になり、掃除後も閾値超過なら警告が残る
- [ ] `sudo -n` 不可を模擬しても HOME 側 category が継続する
- [ ] コンテナ再起動で `postStartCommand` が実行され、非 0 を模擬しても起動をブロックしない
- [ ] host 側案内が固定容量や一律 prune を示さず、`docker system df` から始まる
- [ ] `npx vp check` と `npm test -- scripts/clean-devcontainer-disk.test.ts` が通る

## 7. 受け入れ基準

- §1 の MUST 要件をすべて満たす
- production の削除対象が固定 allowlist に限定され、test root も canonical path が repository `.temp/` 配下の場合だけ受理される
- `/vscode/vscode-server/bin`、拡張本体、使用中・判定不能・未知形式・symlink の resource がいかなる分岐でも自動削除されない
- extensionsCache は非使用を証明できた entry だけが削除され、directory 一括削除されない
- `/`・`/vscode`・HOME・workspace の filesystem identity と `df` が実行時に測られ、before / after・候補量・回収量・skip 量・未回収量と掃除後の警告が報告される
- 毎起動経路は `--threshold 90` の percentage と絶対空き容量を併用し、`local_setup.sh` では npm より前に実行される。CLI 引数なしは無条件実行になる
- safety skip / no-op、partial failure、引数エラーが §3.3 の終了コードと報告契約どおり区別され、起動 wrapper は全非 0 を警告へ変換して lifecycle をブロックしない
- `scripts/clean-devcontainer-disk.test.ts` が §6 の契約を検証し、`npx vp check` と `npm test -- scripts/clean-devcontainer-disk.test.ts` が通る
- host 側案内が `docker system df` による診断を先行し、prune / volume / Docker Desktop reclaim の危険性と適用条件を区別する
- development.md と実装が一致している

## 8. 想定リスクと回避策

| リスク                                                                 | 回避策                                                                                                                                               |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 共有 `/vscode` の別コンテナ使用中 server 世代を削除して IDE 接続を壊す | server bin は自動削除対象外とし、dry-run の手動候補表示に限定する                                                                                    |
| cache / tmp の使用中判定と削除の間に process が起動する                | entry 単位の lock / process 状態を削除直前に再検証し、`active` / `unknown` / 変化ありは skip する                                                    |
| codex app-server 常駐により `~/.codex/.tmp` が回収されない             | 恒常 skip を正常状態として量と理由を報告し、回収見込みに含めない                                                                                     |
| 注入 root、symlink、特殊 pathname から allowlist 外を削除する          | production 固定 allowlist、`.temp/` canonical test root、symlink 非追跡、direct child / basename の直前再検証、NUL-safe 列挙と `--` を契約テストする |
| 最初の root category の失敗で HOME 側回収まで止まる                    | category ごとに失敗を捕捉して独立 category を継続し、skip と partial failure を分離して固定 exit 1 で報告する                                        |
| 満杯時に npm 自体が起動できない                                        | npm 経由に加え、canonical path と固定 allowlist を検証した `_cacache` 直接削除を選択肢として持つ                                                     |
| 過去の 11.6GB から現在の回収量を過大評価し、掃除後も危険水位に残る     | 2026-08-08 の上限約 1.8GB と予防目的を明記し、before / after と絶対空き容量を測り、掃除後も条件超過なら警告する                                      |
| workspace の mount 種別を固定視し、`.temp/` の影響を誤診する           | `/`・`/vscode`・HOME・workspace の device ID と `df` を実行時に比較し、同一 filesystem の場合だけ手動 emergency 候補として提示する                   |
| host 側原因に一律 prune を案内して不要 resource を削除する             | 固定容量を示さず、`docker system df` で内訳確認後、prune / volume / reclaim の適用条件と危険性を分けて案内する                                       |
| cleanup の operational failure が devcontainer lifecycle を止める      | npm より前の共通 wrapper が status を保存して警告し、最終的に exit 0 で継続する                                                                      |

## 9. 参考

- [development.md](../design/development.md)
- [`local_setup.sh`](../../local_setup.sh)
- [feature-plan-template.md](feature-plan-template.md)
- [typescript-agent-package-template](https://github.com/oubakiou/typescript-agent-package-template)
- 障害対応の元セッション記録: 2026-07-21 ENOSPC（コンテナディスク 100%、手動回収 11.6GB）
