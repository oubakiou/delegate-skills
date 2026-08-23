# リファクタリング計画

[![MKDN](https://img.shields.io/badge/MKDN-review-red?style=for-the-badge)](https://mkdn.review/?url=https%3A%2F%2Fraw.githubusercontent.com%2Foubakiou%2Fdelegate-skills%2Frefs%2Fheads%2Fmain%2Fdocs%2Frefactoring%2Frefactoring-plan.md)

本ドキュメントは delegate-skills コードベース（実装の正本 `shared/src/**/*.ts`）に対するリファクタリング候補を優先度順に整理する。H / M / L 項目は「挙動を変えずに保守性・拡張性を上げる」ことを目的とし、新機能追加・バグ修正とは独立して、ファイル分割・責務再配置を中心に進める。

ただし、調査で見つかった security / correctness 上の構造的リスクは、純リファクタリングより先に解消すべき **先行対応（P: prerequisite）** として同じ計画に記録する。P0 は後続検証を信頼できる状態にする infrastructure guard として単独で先行し、P1 / P2 は挙動不変な境界抽出（`a`）と権限・不正入力時の挙動を正す hardening（`b`）を別 PR に分ける。P 項目は H / M / L 項目と混ぜない。テンプレートは [refactoring-plan-template.md](refactoring-plan-template.md) を参照。

## 目次

1. [背景と方針](#1-背景と方針)
2. [先行対応](#2-先行対応)
3. [優先度: 高](#3-優先度-高)
4. [優先度: 中](#4-優先度-中)
5. [優先度: 低](#5-優先度-低)
6. [推奨着手順](#6-推奨着手順)
7. [共通の進め方](#7-共通の進め方)

## 1. 背景と方針

`shared/src/` は 35 ファイル・計約 11,000 行（in-source test 含む）。行数上位は `observe-store.ts`（893 行）/ `prepare.ts`（684 行）/ `wrapper-common.ts`（656 行）/ `wrapper-report.ts`（599 行）/ `run-oneshot.ts`（513 行）。循環 import は無い。構造上の論点は次の 6 点に整理できる。

1. **test infrastructure failure と製品回帰を区別できない**: 契約テストは Node / bash / fake backend CLI を子プロセスで起動する。制限された Codex sandbox では `spawnSync` が `error.code === "EPERM"` と `status === 0` を同時に返して stdout を空にし、async `spawn` も error event なしで close 0 / 空 stdout になり得る。現行 gate はこれを製品 assertion の失敗または成功として扱い、多数の偽失敗・偽成功と終了待ちを起こし得る
2. **内部 artifact の confidentiality 境界が未統一**: request / response / observe JSON は `0600` だが、既定保存先が `/tmp` である一方、run directory・companion Markdown・worker prompt・stdout/stderr capture・一部の session / MCP config は mode を指定せず、`umask 0022` では directory `0755` / file `0644` になる。companion Markdown は run directory 外に残るため `DELEGATE_RUN_RETENTION_DAYS` の cleanup 対象にもならない
3. **response の生成権限と検証が分散**: wrapper が worker 出力から response を組み立てる契約なのに、既存 response があると回収・組み立てを省略する。protocol 読取も JSON object と `sections` の存在を中心に見ており、`protocol_version` / `type` / `status` の検証と resume 可否判定が単一の型付き境界に集約されていない
4. **observe JSON の writer facade への集約**: `observe-store.ts` が observe ドキュメント全 section（`state` / `heartbeat` / `events` / `usage` / `lineage` / `backend_session` / `run_context` / `timing` / `streams` / metrics）の mutation を 1 ファイルで抱えている。さらに `ObserveDoc = Record<string, unknown>` と文字列 phase の直接代入で状態遷移を表している
5. **4 backend wrapper の左右対称な骨格重複**: `wrapper-{claude,codex,cursor,devin}.ts` は終端処理を `wrapper-common.ts` / `wrapper-wait.ts` / `wrapper-report.ts` へ寄せた後も、entrypoint → preflight → prompt 構築 → spawn/wait → finalize → session outcome の 6 ブロックが対称なコピー構造で残っている。この 4 ファイルには in-source test が無い
6. **下位ユーティリティの置き場の歪み**: `wrapper-wait.ts` → `wrapper-report.ts`、`wrapper-imagegen.ts` → `wrapper-codex.ts`、`prepare-imagegen.ts` / `run-oneshot.ts` → `prepare.ts` 内部関数、のように「別責務モジュールの実装詳細」への import が数か所ある

> 本計画の連番（H1 / M1 / L1 など）は、過去シリーズの同名項目とは独立扱いとする。過去に完了したリファクタリングは `git log --grep refactor` で参照できる。本文で過去項目を参照する場合は `過去 M1 (<commit id 短縮>)` のように接頭辞 + 該当コミット ID を付け、世代を一意に特定できるようにする。

新しい候補を起票する際は、`git log --grep refactor --since=<日付>` で直近の完了項目を確認し、既に解消済みの問題を二重起票していないかチェックする。

方針：

- security / correctness に直接関わる P 項目は、保守性中心の H / M / L 項目より先に行う。P0 で後続テストの実行 capability を保証してから、P1 / P2 の `a` で挙動不変な境界を抽出し、`b` で mode や不正 artifact の扱いを正す。P1a / P1b、P2a / P2b は必ず別 PR にする
- **挙動不変なファイル移動を先**にする。リスクの高い構造変更（wrapper テンプレート化・dispatch 経路統一など）は後ろに回す
- **public API は変えない**: CLI subcommand 名 / `.sh` shim 名と引数仕様 / protocol-v1（request・response・observe JSON スキーマ）/ `run.sh` の単一 JSON 契約 / exit code。変える必要が出た場合は別 PR として切り出す
- **docs/design/spec.md・development.md と乖離する変更を入れる場合は同時にドキュメントを更新**する（development.md はモジュール一覧をディレクトリ構成節に列挙しているため、ファイル分割はほぼ必ず追従が要る）
- in-source test (`if (import.meta.vitest)`) は実装ファイルに隣接させる原則を保つ。ファイル分割時はテストも一緒に移す
- `shared/src/` を編集したら `npm run build` → `npm run sync-shared` を回し、fake CLI golden（`scripts/delegate-wrapper-session.test.ts` / `delegate-run.test.ts`）で end-to-end の等価性を確認する

## 2. 先行対応

P 項目は純リファクタリングより優先する prerequisite である。P0 は後続の test gate が成立する環境を先に検証する。P1 / P2 の `a` では既存挙動を保ったまま責務境界とテスト seam を作り、`b` で security / correctness hardening を適用する。

### P0. test execution capability preflight / infrastructure failure classification

**対象**:

- `scripts/test-execution-capability.ts` / `vite.config.ts`（Vitest `globalSetup`）
- `package.json` / `.github/workflows/ci.yml` / `.githooks/pre-commit`（正規 test gate）
- `docs/design/development.md` / `docs/design/spec.md`（検証結果を信頼する前提）

**現状**: full suite の複数経路が `spawnSync` / `spawn` / `execFileSync` で実 bundle・shim・wrapper・fake CLI を起動する。sandbox が子プロセス実行を抑止する環境でも status 0 が返る場合があり、各 assertion は空 stdout や未生成 artifact を製品回帰として報告する。さらに一部の async 経路は終了待ちが長期化する。個々の test を skip すると contract coverage 未実行のまま green になるため、解決にならない。

**対応**:

- package の `test` script 本体と Vitest `globalSetup` から sync / async の Node 子プロセスを sentinel stdout 付きで起動する。前者は npm lifecycle 設定に依存せず正規 gate を Vitest 起動前に単一診断で止め、後者は raw `vp test` の bypass を防ぐ
- 成功条件を「spawn error なし・status 0・signal なし・stdout が sentinel と完全一致」とし、`status === 0` だけを信用しない
- 不成立時は `TEST_ENVIRONMENT_UNSUPPORTED`、観測値、再実行方法を 1 件だけ表示し、test worker 作成前に fail-closed で停止する。skip や成功扱いにはしない
- `npm test` を正規 gate とし、CI / pre-commit / development docs を統一する。`vp test` の直接実行も同じ `globalSetup` を通す
- project `.codex/config.toml` の `danger-full-access` は採用しない。project config は CLI override より優先度が低く managed requirements に制約されるため host policy の解除を保証できず、trusted repository の全 session に sandbox 無効化を既定化するリスクもある。必要かつ許可される環境では one-off の `--sandbox danger-full-access`、それ以外は通常 terminal / CI で再実行する

**効果**: infrastructure failure が多数の製品 assertion failure や偽成功へ展開する前に一意な分類で停止する。以降の P / H / M / L 変更は、子プロセス契約を実行できる環境で得た gate 結果だけを根拠にできる。

**リスク**: 低〜中。子プロセスを使わない pure test も capability 不成立環境では同じ gate 内で停止するが、正規 suite の一部だけを実行して full gate と誤認する経路を残さないことを優先する。pure helper の確認が必要な場合も、capability が成立する terminal / CI で対象 filter を使う。

### P1a. private artifact I/O 境界の抽出

**対象**:

- `shared/src/build-request.ts:251-269`（work / run directory 作成）
- `shared/src/protocol.ts:92-98`（companion Markdown）
- `shared/src/wrapper-common.ts:118-151,246-249`（capture / prompt）
- `shared/src/wrapper-wait.ts:99-111`（capture file open）
- `shared/src/wrapper-{claude,codex,cursor}.ts`（session home・credential / MCP config）
- `shared/src/wrapper-report.ts` / `observe-followup.ts`（report / failed response 中間 artifact）

**現状**: 内部 artifact の生成が `mkdirSync` / `writeFileSync` / `openSync` / `copyFileSync` として各モジュールへ散在している。request / response / observe JSON と source Markdown は明示的に `0600` だが、同じ本文を持つ companion Markdown、request 全文を含む worker prompt、stdout/stderr capture、report 中間ファイル、session / MCP config の権限は呼び出し元の umask に依存する。どの artifact が private で、どれが利用者指定の公開成果物かも API 上で区別されていない。

**分割案**:

- `private-artifact.ts`（仮・leaf モジュール）: private directory / file の create・open・atomic replace・copy primitive を集約する
- 対象は protocol file、companion Markdown、run-local scratch、session home、credential / MCP config に限定する
- imagegen / htmldoc の利用者指定出力、利用者指定の metrics file、既存の `DELEGATE_WORK_DIR` 自体は対象外とし、所有権・公開範囲を勝手に変えない
- P1a では既存 mode を保ち、全 private artifact の移動表と call site を固定する

**効果**: security-sensitive な filesystem 書込が 1 境界に集まり、P1b の mode hardening を漏れなく適用・検証できる。今後 artifact が追加されたときも、private / user-output の区別を API 名から判断できる。

**リスク**: 低〜中。関数移動が中心だが、atomic replace・既存ファイル上書き・copy の mode 継承など syscall ごとの差を隠さず表現する必要がある。P1a では mode を変えない。

### P1b. private artifact の `0700` / `0600` hardening

**対象**: P1a で抽出した private artifact I/O 境界と、対応する mode golden

**現状**: 既定 work directory は `DELEGATE_WORK_DIR` → `TMPDIR` → `/tmp` の順で決まる。`umask 0022` では mode 未指定の run / session directory は `0755`、companion Markdown・prompt・capture・report / config は `0644` になり得る。companion Markdown は request / response JSON と同じ本文を持つが run directory 外にあり、run directory retention の対象外である。README が明記する token-bearing MCP env も、mode 未指定の config へ描画され得る。

**分割案**:

- 新規 private directory を `0700`、private file・copy destination・atomic replace 用 temporary file を `0600` で作る
- `writeFileSync(..., {mode})` が既存ファイルの mode を変更しない点を考慮し、境界内で「新規作成」と「既存 private artifact の mode 保証」を分ける
- request / response companion Markdown も JSON と同じ `0600` にする
- `umask 0022` の下で通常 run / resumable run を作り、protocol・prompt・capture・report・credential / MCP config の mode を検証する Linux golden を追加する
- public output directory / metrics file の mode が変わらない negative case も追加する

**効果**: 共有 `/tmp` や multi-user host で prompt、worker 出力、credential、token-bearing MCP env が他 user に読まれる経路を閉じる。権限ポリシーが call site の書き忘れではなく 1 境界で担保される。

**リスク**: 中。filesystem mode は観測可能な挙動なので純リファクタリングではない。POSIX / Linux 前提を docs に明記し、CLI / protocol schema と無関係な hardening PR として P1a から分離する。

### P2a. Protocol v1 envelope 型・decoder の一元化

**対象**:

- `shared/src/build-request.ts` / `build-response.ts`
- `shared/src/read-request.ts:24-60` / `read-response.ts`
- `shared/src/wrapper-report.ts:47-48,58-85`
- `shared/src/wrapper-common.ts:391-409`
- `shared/src/run-oneshot.ts:131-141`

**現状**: request / response の構築、status 語彙、JSON 読取、`sections` 抽出が複数モジュールに分散している。`loadProtocolFile` は JSON object であることを確認した後に `sections.map(String)` し、`validProtocolStatus` / `VALID_STATUSES` / one-shot の status 抽出 / resume 判定は別実装になっている。protocol の consumer ごとに検証強度が異なる。

**分割案**:

- `protocol-envelope.ts`（仮）: `ProtocolStatus`、`RequestEnvelopeV1`、`ResponseEnvelopeV1`、構築 helper、runtime decoder result 型を置く
- `read-request.ts` / `read-response.ts` から I/O を分離し、parsed `unknown` → envelope / validation error の pure decoder を共有する
- response status の語彙判定を 1 箇所へ寄せ、builder・wrapper・one-shot・resume 判定の consumer を列挙する
- P2a では valid な protocol v1 artifact の挙動を変えず、既存の invalid artifact の扱いも hardening せずに call site とテスト seam だけを統一する

**効果**: P2b で version / type / status / sections を厳密化する場所が 1 箇所になる。TypeScript 上も「検証済み response」と任意 JSON object を区別でき、resume 可否へ未検証値を渡しにくくなる。

**リスク**: 中。consumer が多く、P2a で暗黙に invalid-input behavior を変えると P2b との境界が崩れる。既存 valid fixture の byte / exit code / stdout golden を先に固定する。

### P2b. response single-writer 化と fail-closed 検証

**対象**:

- `shared/src/wrapper-common.ts:330-409`（response completion / resume 判定）
- `shared/src/wrapper-report.ts:197-327`（temporary response assembly）
- `shared/src/prompt-constraints.ts:6-23`（response path への書込許可）
- P2a の Protocol v1 decoder

**現状**: `completeResponse` は response file が既に存在すると structured output / report.md の回収と wrapper 側 assembly を省略する。一方 `finalizeResponse` は JSON の `status` が空でなく `failed` でもなければ resume を許すため、worker が事前生成した malformed / foreign response が schema 強制経路を迂回し得る。read-only 系 prompt も response path への報告生成を許可しており、既存 response は理論上だけの入力ではない。

**分割案**:

- wrapper を response の唯一の publisher とし、backend が返した structured output / report.md を検証後、run-local temporary file から atomic publish する
- worker 起動前から存在する、または worker が直接生成した canonical response は、成功 artifact として再利用せず fail-closed に扱う
- P2a decoder で `protocol_version === 1`、`type`、status 語彙、非空の string sections を確認し、検証済み `ResponseEnvelopeV1` だけから one-shot status / companion / resume 可否を導く
- prompt から response path への直接書込許可を除き、report mode ごとの正規の返却経路だけを記載する
- fake CLI golden に「pre-existing response」「不正 version / type / status / sections」「child exit 0 + malformed response」「不正 response は resumable base にならない」を追加する

**効果**: schema 強制・wrapper collection・atomic publish・resume 判定が単一の trust boundary になる。worker 出力崩れが protocol success や follow-up base として扱われる fail-open を防ぐ。

**リスク**: 中〜高。不正 artifact と worker による canonical response 直接生成の扱いが変わる correctness fix であり、純リファクタリングではない。P2a と別 PR にし、protocol-v1 / spec の「wrapper が response を組み立てる」契約を明文化してから実装する。

## 3. 優先度: 高

### H1a. observe schema / state transition core の型付け

**対象**: `shared/src/observe-store.ts`（893 行、実装約 788 行 + test 約 106 行）

**現状**: observe JSON の writer は `ObserveDoc = Record<string, unknown>` を読み、`sectionOf` が section 欠落・型不一致時に空 object を作って mutation を続ける。`prepared | running | superseded | stalled | ended` の phase も、`markSuperseded` / `dispatchStart` / `dispatchEnd` / `stallTimeout` が文字列を直接代入している。たとえば `dispatchEnd` は `stalled` だけを保持して終了 metadata を追記し、supersede は phase / requester 不一致なら mtime を変えない、という重要な invariant が I/O と mutation の中に埋まっている。このまま section 別にファイル分割すると、文字列ベースの状態機械と緩い document access が複数モジュールへ拡散する。

**分割案**:

- `observe-types.ts`（仮）: `ObservePhase`、writer が所有する `run` / `state` / `heartbeat` / `streams` / session metadata と event の型を置く。backend stream 由来で形が動的な payload は無理に閉じず、型付き section と拡張 payload の境界を明示する
- `observe-transition.ts`（仮）: `dispatchStart` / `heartbeat` / `dispatchEnd` / `stallTimeout` / `markSuperseded` の pure mutation core。I/O・lock・timestamp 生成済みの入力を受け、document と「書込が必要か」を返す
- 現行の phase 変化、event 追記、`stalled` の保持、supersede no-op、duration / heartbeat 更新を**遷移表**にし、in-source table test を先に作る
- H1a では current valid artifact に対する挙動を固定するだけに留め、壊れた observe の runtime validation や許可遷移の厳密化は行わない

**効果**: H1b の section 分割前に、observe v1 の内部 domain model と lifecycle invariant が pure test 可能な形で固定される。TypeScript の型検査が field / phase の typo を検出でき、I/O 分割後も状態遷移の正本が 1 箇所に残る。

**リスク**: 中。optional metadata と backend 由来 payload を過度に型付けすると型 assertion が増え、逆に安全性が下がる。型の対象は writer が所有する field に限定し、P2 と同様に「型境界の抽出」と「runtime hardening」を混ぜない。

### H1b. observe-store.ts の observe section 別分割

**対象**: H1a 後の `shared/src/observe-store.ts` と `observe-transition.ts`

**現状**: observe JSON の唯一の writer facade として、性質の異なる mutation が全部同居している。read/write/lock primitive（現行 34-109 行）、`initObserve`（123-178）、events・usage・MCP・lineage・backend_session 系（180-287）、git / run_context（289-330）、effort / cost 記録（332-403）、supersede（405-475）、dispatch lifecycle / heartbeat（477-633）、timing / stream 取り込み（647-718）、dispatch metrics（731-764）。`observe-{lock,cost,usage,timing,effort}.ts` は責務が明確なのに対し、store がそれらを束ねつつ独自ロジックも持つため肥大している。

**分割案**:

- `observe-store.ts`: read/write/locked mutation primitive・`initObserve` に加え、複数の分割先モジュールから使われる `appendObserveEvent` / `captureBytes` を残す（他モジュールが依存する土台）
- `observe-lifecycle.ts`: H1a の transition core を I/O へ接続し、`dispatchStart` / `heartbeat` / `dispatchEnd` / `responseMissing` / `failedResponseWritten` / `stallTimeout` / `markSuperseded` / `supersedeStalePrepared` を公開する
- `observe-session.ts`: `updateLineage` / `updateBackendSession` / `resumeUnavailable` / `updateRunContext` / `gitOutput` / `updateMcpConfig`
- `observe-record.ts`: `recordEffort` / `recordUsage` / `updateUsage` / `usageParseFailed` / `recordTiming` / `importStreams` / `appendDispatchMetrics`
- 着手前に、現行の**全 export と内部 primitive の移動表**を作り、primitive API（locked mutation / event append / capture 計測）を先に固定する

**効果**: observe JSON の section 群と mutation モジュールがほぼ 1:1 になり、変更影響範囲がファイル名から読める。`observe-followup.ts` など「store の一部だけ使う」依存側の import が細粒度になる。in-source test（789-893 行）も対応先へ分配され、1 ファイルの見通しが改善する。

**リスク**: 低〜中。H1a で mutation core を固定した後の挙動不変なファイル移動 + import 書き換えだが、現行 store には 13 モジュールが依存しており、移動表なしで進めると facade に責務が残るか場当たり的な横方向 import が生じる。分割後の循環 import 検査を必須とする。development.md の `observe-{store,lock,followup,effort,usage,cost,timing}.ts` 記載の更新を同 PR に含める。

### H2a. backend wrapper の finalize / session outcome 共通化

**対象**:

- `shared/src/wrapper-claude.ts`（`finalizeClaudeRun` 318-348 / `recordClaudeSessionOutcome` 288-316）
- `shared/src/wrapper-codex.ts`（`finalizeCodexRun` 246-283 / `recordCodexSessionOutcome` 217-244）
- `shared/src/wrapper-cursor.ts`（`finalizeCursorRun` 244-276 / `recordCursorSessionOutcome` 207-234）
- `shared/src/wrapper-devin.ts`（`finalizeDevinRun` 136-167 / `recordDevinSessionOutcome` 101-128）

**現状**: finalize ブロック（いずれも `completeResponse` → `finalizeResponse` → `recordUsageAndEffort` → session outcome → `wrapperResult`）と session outcome recorder（resumable / followup の分岐構造が同一）が 4 backend で対称に複製されている。ただし backend 差分は resume handle / usage extractor / effort extractor に**限らない**: Codex だけは session 記録後に成功条件付きで `codexHomePrune` を実行し（`wrapper-codex.ts:280-281`）、structured / report.md の report mode、Codex follow-up の prompt transport・inline 上限も backend 間で異なる。

**分割案**:

- 着手前に completion 設定 / session outcome 抽出 / post-success hook（`codexHomePrune` 等）/ prompt transport を列挙した **backend 差分表**を作り、共通化できる範囲を確定する
- 共通 finalizer は既に 656 行ある `wrapper-common.ts` へ追加せず、専用モジュール（`wrapper-finalize.ts` 仮、M6 の分割先と同居）として抽出し、差分表の項目を引数化する

**効果**: finalize / session outcome の対称複製が消え、backend 差分が差分表 = 引数リストとして明文化される。共通骨格に in-source test が書けるようになる。

**リスク**: 中。「機械的抽出」と呼べるのは差分表の完成後で、post-success hook の実行順・条件を変えると spec.md の記載とも不整合になる。`scripts/delegate-wrapper-session.test.ts` の argv・observe JSON assert を等価性の検知に使う。

### H2b. BackendDefinition による launch テンプレート化

**対象**:

- `shared/src/wrapper-claude.ts`（418 行）/ `wrapper-codex.ts`（377 行）/ `wrapper-cursor.ts`（395 行）/ `wrapper-devin.ts`（235 行）の launch 側 4 ブロック

**現状**: 4 backend で次のブロックが対称に複製されている。

1. entrypoint（`runWrapper*`: args parse → context 生成 → `*WithContext` 呼び出し。claude 407-418 / codex 366-377 / cursor 384-395 / devin 224-235）
2. preflight（`effortFailure` → session/backend 検証 → コマンド存在確認）
3. prompt 構築（`requestPromptStep` → `promptConstraints` → `workerPrompt` → prompt ファイル書き出し。差分は tail 行のみ）
4. spawn + wait（`spawnWorker` → `waitWithHeartbeat` に同じ observe/run/capture/response/env 一式を渡す）

また 4 ファイルとも in-source test が無く、カバレッジは fake CLI golden だけに依存している。

**分割案**:

- `wrapper-backend.ts`（仮）: `BackendDefinition` 型（command・buildArgs・buildEnv・prompt tail・report mode・preflight 検証・session outcome 抽出等）と共通の `runBackendWrapper`
- 各 `wrapper-*.ts` は定義オブジェクト + backend 固有 helper（Claude の session file 探索、Cursor の config isolation 等）だけを持つ

**効果**: 新 backend 追加が「定義 1 つ + 固有 helper」で済む。骨格が pure な関数群になり、fake CLI golden に依存しない in-source test が書けるようになる（現状 4 wrapper はテスト行 0）。

**リスク**: 中。構造変更。backend 差分の吸収設計を誤ると条件分岐だらけの定義オブジェクトになる。H2a の差分表と実装結果を見て、差分が定義に素直に収まらなければ**不採用**として本項を閉じる。

### H3. prepare.ts のフェーズ分割と共有ユーティリティの切り出し

**対象**:

- `shared/src/prepare.ts`（684 行、実装約 538 行 + test 約 147 行）
- `shared/src/prepare-imagegen.ts`（249 行、`prepare.ts` 内部への依存）

**現状**: argv / session-mode parse（30-103 行）、follow-up メタ読み取り（105-134）、git repo root（136-145）、prepare metrics（147-193）、`parseRunPaths`（195-213）、モデル / follow-up / effort validation pipeline（215-349）、request 構築（351-380）、lineage / session 記録（382-432）、出力組み立て（434-458）、observe 初期化（460-499）、`runPrepare`（501-527）が 1 ファイルに直列で並ぶ。さらに `prepare-imagegen.ts`（`appendPrepareMetrics` / `parseRunPaths` / `RunPathsJson`）と `run-oneshot.ts`（`parseRunPaths` / `runPrepare`）が prepare 内部の関数を import しており、「pipeline 本体」と「他モジュールと共有するユーティリティ」が未分離。

**分割案**:

- `prepare-common.ts`（仮）: `parseRunPaths` / `appendPrepareMetrics` / `RunPathsJson` など imagegen / one-shot と共有する部分
- `prepare-validate.ts`（仮）: モデル解決・follow-up 検証・effort 検証の validation pipeline
- `prepare.ts`: argv parse + フェーズ組み立て + `runPrepare` のみ

**効果**: `prepare-imagegen.ts` / `run-oneshot.ts` の依存先が「共有モジュール」になり、prepare pipeline 本体の変更が波及しにくくなる。validation pipeline が独立し、exit 5（follow-up 検証失敗）/ exit 6（effort 指定不正）の fail-closed 分岐のテストがフェーズ単位で書ける（exit 3 は md2idx のバンドル内包で廃止済み。`prepare.ts:27` 参照）。

**リスク**: 低〜中。大半はファイル抽出だが、validation pipeline の切れ目（どこまでを validate 側に置くか）に設計判断がある。in-source test（539-684 行）の分配を伴う。

## 4. 優先度: 中

### M1. wrapper-report.ts からプロセス診断・Codex prune を分離

**対象**:

- `shared/src/wrapper-report.ts`（599 行、実装約 420 行）
- `shared/src/wrapper-wait.ts:9`（`positiveIntOrZero` / `processTreeJson` の import）

**現状**: report parsing（report mode / schema、request inline 抽出、structured output 抽出、front-matter parse、response 組み立て）と、stall 診断用 process tree 取得（342-387 行）、Codex home prune（389-413 行）という無関係な責務が同居。その結果 `wrapper-wait.ts` が wait / stall 制御のために report モジュールへ依存している。

**分割案**:

- `process-utils.ts`（仮）: `processTreeJson` / `positiveIntOrZero`
- Codex home prune は M4 の codex ユーティリティモジュールへ（または `wrapper-codex.ts` へ）移す

**効果**: `wrapper-wait.ts` → `wrapper-report.ts` の依存が消え、report parsing が「worker 出力 → protocol response」の純粋な変換に近づく。

**リスク**: 低。関数移動と import 書き換えのみ。

### M2. Env 型の一元化

**対象**:

- `shared/src/build-request.ts:35` / `shared/src/observe-store.ts:28`（`Env` 型の重複定義）

**現状**: `Env` 型は `build-request.ts` と `observe-store.ts` に重複定義されており、前者には 17 モジュールが依存する。build / read / prepare / dispatch / wrapper / observe の各層が、環境変数の型だけを得るため request builder または observe store に依存している。protocol envelope / reader の依存方向は P2a で整理するため、本項では `Env` の leaf 化だけを扱う。

**分割案**:

- `env.ts`（仮・leaf モジュール）: `Env` 型を一元化し、`build-request.ts` / `observe-store.ts` の両定義を統合して全 consumer を移す

**効果**: `Env` の二重管理が消え、依存方向が「各 subcommand / domain module → env」に一方向化する。P2a の protocol 境界と組み合わせると、build-request が汎用型の配布元になっている歪みも解消する。

**リスク**: 低。型の付け替え自体は機械的だが consumer が多いため、P2a 後の import graph を基準に一括移行する。

### M3. dedicated wrapper dispatch 経路の統一（要精査・不採用含み）

**対象**:

- `shared/src/run-oneshot.ts:299-310`（`dedicatedWrapperDispatch`）
- `shared/src/dispatch.ts:248-278`（supersede / `dispatchToWrapper`）
- `shared/src/wrapper-dedicated.ts:92` / `shared/src/wrapper-xresearch.ts:120`

**現状**: 通常経路は observe 初期化・supersede・dispatch lifecycle を親側（`dispatch.ts`）で記録するのに対し、dedicated 経路（`run-imagegen` / `run-x-research`）は wrapper 内（`wrapper-dedicated.ts`）で記録する。さらに Grok fallback 後の実効 model は wrapper だけが知っており、metrics へ明示的に渡している（`wrapper-xresearch.ts:120`）。dispatch の入口が 2 つあり、observe 記録の一貫性を 2 か所で保証する必要がある。

**分割案**: 単純に親側へ統合すると、metrics の model 誤記録・dedicated 経路への意図しない supersede・直接 shim 起動時の lifecycle 欠落・start/end イベントの二重記録が起こり得る。統一を検討する場合は次の順で進める。

1. 観点を「observe 初期化の所有者 / supersede の適用範囲 / PID 所有者 / 実効 model の伝搬 / 直接 shim 起動」の 5 点で**不変条件表**にまとめる
2. 「start/end イベント各 1 件」「fallback 後 model の metrics 記録」「standalone 起動」を fake CLI golden へ**先に**追加する
3. 共通 helper が不変条件を全て表現できる場合のみ実装し、できなければ**不採用**として本項を閉じる

**効果**: 統一が成立した場合、dispatch lifecycle の記録が単一経路になり、observe JSON の一貫性検証・metrics 集計の前提が単純になる。

**リスク**: 高。経路ごとの契約差が大きく「挙動不変」の保証が本計画中もっとも難しい。golden 拡充（上記 2）なしでは着手しない。

### M4. copyCodexAuth の共有モジュール化

**対象**: `shared/src/wrapper-imagegen.ts:16` / `shared/src/wrapper-codex.ts:89`

**現状**: dedicated wrapper（imagegen）が backend wrapper（codex）の実装詳細 `copyCodexAuth` を import している。

**分割案**: `codex-home.ts`（仮）へ `copyCodexAuth` を移す。M1 で移す `codexHomePrune` と同居させてよい。

**効果**: dedicated wrapper と backend wrapper の依存が共有ユーティリティ経由になり、`wrapper-codex.ts` の内部変更が imagegen に波及しない。

**リスク**: 低。M1 と同一 PR で実施してよい。

### M5. observe-followup.ts からの failed response 生成の分離

**対象**: `shared/src/observe-followup.ts:197-223`（`writeFailedResponse`）

**状態**: **P2b との統合候補** — P2b の single-writer boundary が failed response も所有する設計なら、本項の作業を P2b に含めて M5 は完了扱いにする。

**現状**: validation 本体（`validateFollowup`、173 行〜）は既に判定結果 `FollowupValidation` を返す独立関数で、`writeFailedResponse` を呼ばない。問題は failed response 書き込み関数が validation モジュールに同居し、`observe-store.ts` の `failedResponseWritten` / `Env` へ依存している点にある。また validation 自体も observe 読取・`realpathSync`・git 実行を含むため、response 生成を移すだけでは pure にならない。

**分割案**:

- P2b が作る response publisher（または `failed-response.ts`）へ `writeFailedResponse` を移し、canonical response の writer を 1 か所にする。呼び出し側（`wrapper-common.ts` / `wrapper-dedicated.ts`）へ個別に寄せない
- pure 化まで狙う場合は、読取済み session snapshot を検証する core と、I/O adapter（observe 読取 / git / `realpathSync`）に分ける

**効果**: fail-closed 判定の core が I/O モックなしでテストできるようになり、`observe-followup.ts` → `observe-store.ts` の依存が細くなる。

**リスク**: 低〜中。fail-closed の等価性（失敗時に必ず failed response が書かれること）を fake CLI golden で確認する。P2b に統合しない場合だけ独立 PR とする。

### M6. wrapper-common.ts の責務分割

**対象**: `shared/src/wrapper-common.ts`（656 行、実装約 558 行）

**現状**: 4 backend wrapper の共通化の受け皿として、argv / context 生成（49-153 行）、pre-child failure response（167-209）、prompt 骨格（211-249）、response 完成（252-355）、missing / final response（357-410）、usage / effort 記録（412-465）、resumable / follow-up backend_session 記録（467-547）を 1 ファイルで抱えている。H2a の共通 finalizer をこのままここへ集めると、新しい集中点を作ることになる。P2b 完了後は response publish / validation の境界が先に分離されている前提になる。

**分割案**:

- `wrapper-context.ts`（仮）: argv parse / context 生成 / env helper
- `wrapper-finalize.ts`（仮）: P2b の response publisher を呼ぶ orchestration と usage / effort 記録（H2a の共通 finalizer の置き場を兼ねる）
- `wrapper-session.ts`（仮）: resumable / follow-up の backend_session outcome 記録

**効果**: H2a / H2b の共通化の受け皿が細粒度になり、`wrapper-common.ts` の再肥大を防ぐ。

**リスク**: 低。挙動不変のファイル抽出。**H2a より先に実施する**。

## 5. 優先度: 低

### L1. run-oneshot.ts の出力エンベロープ処理の抽出

**対象**: `shared/src/run-oneshot.ts:25-115`

**現状**: `run.sh` の単一 JSON 契約（`exit_code` / `status` / `content` / `content_truncated` 等）と `DELEGATE_RUN_CONTENT_MAX` による byte クリップ処理が、one-shot のフロー制御と同じファイルにある。

**分割案**: `oneshot-output.ts`（仮）へエンベロープ生成・クリップ処理を移す。

**効果**: `run.sh` の JSON 契約が 1 モジュールに固まり、契約変更時の影響範囲が明確になる。

**リスク**: 低。

### L2. backend wrapper の pure helper への in-source test 追加

**対象**: `shared/src/wrapper-claude.ts` / `wrapper-cursor.ts`（in-source test 0 行）

**現状**: Claude の session file 探索（47-88 行）や Cursor のモデル prefix / effort 変換（42-66 行）・config isolation など、pure に切り出せる helper が fake CLI golden 経由でしか検証されていない。

**分割案**: H2b の完了後、`BackendDefinition` と backend 固有 helper に in-source test を隣接させる（H2 を実施しない場合でも、pure helper 単位でのテスト追加は可能）。

**効果**: backend 固有ロジックの回帰を fake CLI golden より速く・細かく検知できる。

**リスク**: 低。テスト追加のみで実装は変えない。

## 6. 推奨着手順

security / correctness の prerequisite を先に解消する。各 P 項目内では挙動不変な境界抽出（`a`）を hardening（`b`）より先にし、その後も挙動不変なファイル移動から構造変更（テンプレート化・経路統一）へ進む。

1. **P0** — test execution capability preflight を入れ、以降の gate が infrastructure failure を製品回帰と誤分類しない状態にする
2. **P1a → P1b** — private artifact の I/O 境界を挙動不変で抽出してから、`0700` / `0600` を強制する
3. **P2a → P2b** — valid Protocol v1 の型・decoder を一元化してから、response single-writer / strict fail-closed を適用する
4. **H1a → H1b** — observe の型・遷移表を pure test で固定してから、最大ファイルを section 別に分割する
5. **M1 + M4** — 小さな依存の歪み解消。同一 PR で実施可
6. **M2** — `Env` 一元化。P2a / H1b 後の import graph を基準に consumer を一括移行する
7. **H3** — prepare の共有部切り出し。wrapper 系とは独立
8. **M5** — P2b に failed response 生成を統合しなかった場合だけ実施する
9. **M6 → H2a → H2b** — P2b の response publisher を再利用して M6 で受け皿を作り、H2a の backend 差分表を先に作成する。H2b は差分表と H2a の結果で採否を判断する
10. **L1 / L2** — 手が空いたときに
11. **M3** — 不変条件表の作成と fake CLI golden の拡充を終えてから採否を決める

## 7. 共通の進め方

- 各候補は **1 PR = 1 候補** を原則とする（M1 + M4 のように同時実施を推奨している組は同一 PR で OK）
- P0 は後続すべての前提として単独 PR にする。P1a / P1b、P2a / P2b は必ず別 PR にし、`a` の diff が挙動不変であることを確認してから `b` の hardening を行う
- 「ファイル分割のみ」と「責務再配置を含む構造変更」を含む候補は H1a / H1b、H2a / H2b のように独立 sub-section へ分けて各 1 PR とし、前半は挙動不変であることを diff で確認できる形にする
- in-source test は実装と同じ移動先に追従させる
- `shared/src/` を編集したら `npm run build` → `npm run sync-shared` を回す。生成コピー（`skills/*/scripts/*`）は直接編集しない
- コミット前ゲートは development.md の CI ゲート（[development.md の git hooks / CI 節](../design/development.md#git-hookspre-commit)を正本とする）をすべて通す: `npm run build:check` / `npm run sync-shared:check` / `bash scripts/check-no-jq-md2idx.sh` / `npm run metrics:baseline:check` / `vp check` / `npm test`。end-to-end の等価性は fake CLI golden（`scripts/delegate-wrapper-session.test.ts` / `delegate-run.test.ts`）が担保する。P0 は capability 不成立時の単一 infrastructure error と成立環境での full pass、P1b は mode golden、P2b は malformed / pre-existing response と resume 不許可、M3 は metrics レコード形状、M1 / M4 は spawn 参照の静的検査（check-no-jq-md2idx）を重点確認する
- 実装が終わったら **サブエージェントで独立レビューする**（delegate-review）。特に「挙動不変」を狙う候補では、等価性・テストカバレッジの欠落・写し間違い・依存方向（循環参照）を重点的に確認させ、指摘を反映してから PR を出す
- docs/design/spec.md・development.md と乖離する変更は**ドキュメント更新を同 PR に含める**（development.md のディレクトリ構成節はファイル分割でほぼ必ず追従が要る）
- 実装が PR として merge できる状態になったら、計画書本文の該当候補に **`### P1a. (完了済み) <タイトル>`** のような状態マーカを付け、コミット ID を添える（例: `**状態**: **完了済み** — commit \`abc1234\` で merge`）。番号は欠番扱いにし、後続項目の番号を詰めない
- 本計画書に含まれる候補がすべて完了（または不要と判断）したら、**リファクタリング計画ドキュメント自体を削除する**（履歴は `git log --grep refactor` で辿れる）
