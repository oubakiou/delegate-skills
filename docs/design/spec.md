# delegate-skills 仕様

実装・調査・雑務などのタスクを安価なモデルの subagent に委譲し、トークン費用を圧縮する skill 集の仕様。

## 1. 目的

- main agent（高価なモデル）の context を汚さず、定型的・機械的な作業を安価なモデルの subagent に委譲してトークン総量を圧縮する
- 委譲先の品質ブレは main の検証フェーズで吸収し、手戻りによるトークン増を抑える

## 2. アーキテクチャ概要

```
main agent
  ├─ prepare.sh               前提チェック → モデル解決 → チェーン確認 → リクエスト生成を集約
  │   ├─ check-md2idx.sh          前提条件チェック（npx md2idx, fail-closed）
  │   ├─ resolve-model.sh         モデル解決（種別env → デフォルト）
  │   ├─ check-delegate-chain.sh  多段委譲の再帰防止（同一種別2度禁止）
  │   └─ build-request.sh         request_file / response_file を生成（ts + 乱数を共有）
  ├─ 実行系分岐
  │    ├─ model が gpt*  → delegate-codex.sh（Codex 子プロセス）
  │    └─ それ以外        → delegate-claude.sh（Claude 子プロセス、claude -p）
  └─ response を read-response.sh auto または status → index → 必要 section の順に読み取り → 検証
```

ファイルプロトコルは実行系（claude -p / Codex）に依存しない。「誰が request_file を読み response_file を書くか」だけが変わる。

### 委譲メカニズムの選定理由

- Claude 系は **`claude -p` 子プロセス**（`delegate-claude.sh`）を使う。in-session の Agent tool は requester が Codex のとき利用できないため、Claude / Codex どちらの requester からも一貫して呼べる `claude -p` を採用する
- `gpt-*` は **Codex 子プロセス**（`delegate-codex.sh`）が必須（in-session の実行手段が無い）
- requester が Codex でも Claude でも、`resolve-model.sh` の出力プレフィックスに基づき適切な子プロセス（`claude -p` / `codex exec`）を起動する

## 3. skill 一覧

| skill                                         | 用途                                       | ツール権限                   | 既定モデル | env                                                                              |
| --------------------------------------------- | ------------------------------------------ | ---------------------------- | ---------- | -------------------------------------------------------------------------------- |
| [`delegate-explore`](delegate-explore.md)     | read-only のコード/ドキュメント探索・読解  | read-only（Read/Grep/Glob）  | `haiku`    | `DELEGATE_EXPLORE_MODEL` / `DELEGATE_WORK_DIR`                                   |
| [`delegate-implement`](delegate-implement.md) | コード実装・修正（1 コミットに収まる単位） | Edit/Write/Bash（push なし） | `sonnet`   | `DELEGATE_IMPLEMENT_MODEL` / `DELEGATE_WORK_DIR`                                 |
| [`delegate-chore`](delegate-chore.md)         | フォールバック雑務                         | Edit/Write/Bash（push なし） | `haiku`    | `DELEGATE_CHORE_MODEL` / `DELEGATE_WORK_DIR`                                     |
| [`delegate-review`](delegate-review.md)       | コード/ドキュメントレビュー（差分の指摘）  | read-only（Read/Grep/Glob）  | `opus`     | `DELEGATE_REVIEW_MODEL` / `DELEGATE_WORK_DIR`                                    |
| `delegate-imagegen`                           | 画像生成/編集の capability bridge          | Codex 子プロセス             | `gpt-5`    | `DELEGATE_IMAGEGEN_MODEL` / `DELEGATE_WORK_DIR` / `DELEGATE_IMAGEGEN_OUTPUT_DIR` |

delegate-review は README / spec / design docs / changelog などのドキュメント差分も対象に含める。既存の read-only / Findings 優先の枠組みは維持し、記述の矛盾、古い前提、欠けた根拠、実装との不整合を指摘対象に含める。

### 既定モデルの根拠

- explore / chore は read 中心・低リスクのため `haiku`
- implement も編集の判断を要するため `sonnet`
- review は指摘品質が成果物に直結し判断比重が高いため `opus`
- 個々のタスクが軽微なときは、その種別の既定モデルを `DELEGATE_<TYPE>_MODEL=haiku` で明示的に引き下げてコストを抑えられる
- imagegen は `DELEGATE_IMAGEGEN_MODEL` → 既定 `gpt-5` で解決するが、Codex 限定の実行系として扱う。`gpt*` 以外に解決された場合は Claude パスへフォールバックせず中止する。主目的は token cost 削減ではなく capability bridge と context isolation で、ユーザー向けには画像生成モデル選択の概念を持たせない。出力先は明示がなければ `.temp/imagegen/` 配下

## 4. モデル解決

共有 `resolve-model.sh` にロジックを一元化し、skill 固有デフォルトは各 SKILL.md が引数で渡す。

```
resolve-model.sh <種別env名> <skill固有デフォルト>
解決順: $種別env → 引数デフォルト
出力: Claude エイリアス(sonnet|haiku|opus|fable) または gpt-* モデルID
```

env に入れる値は Claude エイリアス（claude -p の --model 引数対応）か `gpt-*` モデルID（Codex へ渡す）の2系統に限定する。

## 5. 実行系の二分岐

`resolve-model.sh` の出力プレフィックスで選ぶ。

| 種別      | Claude パス（`claude -p -m <model>`）                           | Codex パス（`codex exec -m <model>`）        |
| --------- | --------------------------------------------------------------- | -------------------------------------------- |
| explore   | `--dangerously-skip-permissions` + `--allowedTools "Read,Bash"` | `--sandbox danger-full-access` + constraints |
| implement | `--dangerously-skip-permissions`                                | `--sandbox danger-full-access`               |
| chore     | `--dangerously-skip-permissions`                                | `--sandbox danger-full-access`               |
| review    | `--dangerously-skip-permissions` + `--allowedTools "Read,Bash"` | `--sandbox danger-full-access` + constraints |

`delegate-imagegen` は同じモデル解決を使うが、画像生成 capability bridge のため `gpt*` → `delegate-imagegen-codex.sh` のみを許可し、非 `gpt*` では fail-closed する。

### Claude パスの起動

`delegate-claude.sh` は `delegate-codex.sh` と対称構造の Claude 子プロセスラッパ。

- `claude -p` で非対話モードの子プロセスを起動
- `--model "$MODEL"` でモデル指定（`resolve-model.sh` の出力をそのまま渡す）
- `--dangerously-skip-permissions`（非対話のため permission prompt は使えない）
- `--no-session-persistence`（エフェメラル実行。セッションをディスクに残さない）
- read-only 種別（explore / review）では `--allowedTools "Read,Bash"` を付与し Edit / Write を技術的に除外する。Codex パスでは sandbox が同等の制約を提供できないため、この防御層は Claude パス固有
- cwd を `$REPO_ROOT` に切り替えて起動（対象リポジトリ root で実作業）
- worker は `build-response.sh` を使い response_file を生成する（Codex パスの手組み `npx md2idx | jq` と等価だが validation・telemetry 付き）
- stdout は response_file のパスのみ

### Codex パスの起動

`delegate-codex.sh` は [guarded-webfetch-codex](https://github.com/oubakiou/skills/tree/main/skills/guarded-webfetch-codex) の起動骨格を流用する。

- 隔離 `CODEX_HOME`（disposable home に `auth.json` だけコピーしログイン維持）/ TMPDIR 隔離
- `--skip-git-repo-check --ephemeral --ignore-user-config`
- `--ignore-rules` は**付けない**（AGENTS.md を読ませ規約遵守させる）
- `--sandbox danger-full-access`
- `-C "$REPO_ROOT"`（隔離 cwd ではなく対象リポジトリ root で実作業）
- `--output-last-message` は status の回収に流用する（本文は子が直接 response_file に書くため `--output-schema` は使わない）
- stdout は response_file のパスのみ

### sandbox / permission を全開放に統一する理由

- Codex: `read-only` だと response_file を書けない（shell 書き込みも全面遮断）。explore も report を書くため最低限の書き込みが要る。`npx md2idx` のダウンロードにネットワークが要る（`workspace-write` では遮断される）
- Claude: `claude -p` は非対話なので permission prompt に応答できない。`--dangerously-skip-permissions` が必須
- トレードオフ: push 抑止・explore の read-only 性は sandbox / permission では強制されず prompt の constraints と main の検証フェーズに依存する

## 6. ファイルプロトコル（protocol v1）

main が request_file / response_file を事前確保する。詳細は [protocol-v1.md](protocol-v1.md)。

### 命名

```bash
ts="$(date +%Y%m%d_%H%M%S)"
tmp_name="delegate_<type>_${ts}_req_XXXXX"
# 既定の置き場は mktemp に委ねる（TMPDIR、無ければ /tmp）。DELEGATE_WORK_DIR で上書き可
if [ -n "${DELEGATE_WORK_DIR:-}" ]; then
  mkdir -p "$DELEGATE_WORK_DIR"
  request_tmp="$(mktemp --tmpdir="$DELEGATE_WORK_DIR" "$tmp_name" --suffix=.json)"
else
  request_tmp="$(mktemp --tmpdir "$tmp_name" --suffix=.json)"
fi
request_token="$(basename "$request_tmp")"
request_token="${request_token#delegate_<type>_${ts}_req_}"
request_token="${request_token%.json}"
request_file="${request_tmp%/*}/delegate_<type>_${ts}_${request_token}_req.json"
mv "$request_tmp" "$request_file"
response_file="${request_file%_req.json}_res.json"
```

- request_file と response_file は `ts`（タイムスタンプ）とランダムトークンを共有し、末尾の `_req`/`_res` だけが異なる → 同一秒に並列実行してもファイル名から両者の対応関係を一意特定できる
- 乱数の出所は request の mktemp 1 箇所。一意性も保たれる
- クリーンアップ: ファイルは残す（監査・デバッグ用）。既定では mktemp の置き場（`TMPDIR`、無ければ `/tmp`）に蓄積するため不要分は手動で削除する。`DELEGATE_WORK_DIR` で置き場を固定できる
- **main 事前確保の利点**: main は sub の最終メッセージをパースせずに response_file パスを決定的に知れる。sub の返答が崩れてもパスを見失わない

### 人間向け Markdown 派生物

request / response の JSON は protocol の source of truth とし、agent 間通信・互換性判定・段階読み取りは JSON だけを見る。一方、監査・デバッグで人間が読みやすいよう、JSON 書き出し後に同じ basename の `.md` を best-effort で生成する。

```bash
jq -r '.sections | join("\n\n")' "$request_file" >"${request_file%.json}.md"
jq -r '.sections | join("\n\n")' "$response_file" >"${response_file%.json}.md"
```

`.md` は `sections` を結合した補助成果物であり、`task_type_chain` / `requester_session_id` / `status` / `responder_session_id` などの構造化メタデータは正本 JSON に残す。`.md` 生成に失敗しても protocol の成否は JSON 生成結果で判定する。

### リクエストファイル（main → sub）

```json
{
  "protocol_version": 1,
  "type": "request",
  "task_type": "implement",
  "task_type_chain": ["implement"],
  "requester_session_id": "...",
  "index": "...",
  "sections": ["..."]
}
```

- `type`: 固定値 `request`（ファイル種別の自己記述）
- `task_type_chain`: 委譲チェーン（先祖種別 + 自種別）。再帰防止に使う
- `requester_session_id`: 必須。リクエスト元（親）のプロセス / セッション ID（追跡・デバッグ用）
- `index` / `sections`: 指示 Markdown（Objective / Scope / Context / Acceptance criteria / Verification / Constraints）の md2idx 出力
- response_file パスは prompt で渡す（request file には含めない）
- JSON 書き出し後、人間向けに `${request_file%.json}.md` を補助生成する

### レスポンスファイル（sub → main）

```json
{
  "protocol_version": 1,
  "type": "response",
  "status": "completed",
  "responder_session_id": "...",
  "index": "...",
  "sections": ["..."]
}
```

- `protocol_version`: リクエストと揃える（バージョン差検出用）
- `type`: 固定値 `response`（ファイル種別の自己記述）
- `status`: `completed | partial | failed | needs_input`（構造化フィールド。main が最優先・最安に読む）
- `responder_session_id`: 必須。リクエスト先（子）のプロセス / セッション ID（追跡・デバッグ用）
- `index` / `sections`: 報告 Markdown（Summary / Changed files / Commands / Verification / Findings / Blockers / Error）の md2idx 出力。検証結果は構造化フィールドに持たず、報告 Markdown の Verification section に収め、main は `status` の次にこの section だけを必要時に引く
- JSON 書き出し後、人間向けに `${response_file%.json}.md` を補助生成する

### md2idx（トークン圧縮の核）

両ファイルとも書き手は指示/報告の Markdown を `npx md2idx` に通して `index` / `sections` を生成し、その前に構造化キー（md2idx 出力ではない機械可読フィールド。request なら `protocol_version` / `type` / `task_type` / `task_type_chain` 等、response なら `protocol_version` / `type` / `status` 等）を前置する。response の読み手（main）は `status` → `index` → 必要 section の順で段階読み取りする。ただし段階読みは jq の複数往復を要するため、`read-response.sh auto` は response が小さい（`DELEGATE_RESPONSE_INLINE_MAX`、既定 10KB 未満）ときは status と全 section を 1 回で丸読みし、大きいときのみ段階読みへ誘導する（小さな report では丸読みの方が往復が少なく安い）。一方 request の読み手（sub）は読み飛ばしてよい情報が無く、sub のトークン単価も安いため `read-request.sh all` で丸ごと読む運用を既定とする。`npx md2idx` は前提条件であり、実行不可なら fail-closed（exit 3）。

### 任意 telemetry（proxy metric）

`DELEGATE_METRICS_FILE` が設定されたときだけ、共有スクリプトは JSONL に proxy metric を追記する。通常運用では未設定で、挙動も出力も変えない。metrics 書き込みは best-effort であり、書き込み先の作成や追記に失敗しても本処理は継続する。記録対象は `prepare.sh` / `build-request.sh` / `read-request.sh` / `build-response.sh` / `read-response.sh` で、主なフィールドは `kind`、対象ファイル、selector、inline 判定、section 数、`bytes` / `chars` / `lines` / `estimated_tokens`。`read-request.sh` / `read-response.sh` はファイル全体サイズに加え、実際に stdout へ出した `selected` 量を記録する。この telemetry は実課金額ではなく、main が読んだ response 量、worker が読んだ request 量、orchestration event 数を比較するための近似である。

### main 側の context / cache 規律（コスト最適化）

main が最高級モデルのとき、削減は「委譲」とは独立の別レイヤーとしても効く。md2idx 圧縮と乗算で効く原則:

- **append-only**: 過去ターン（SKILL.md / プロトコルの規約文、既読の response）を再注入・再要約しない。プレフィックスを保てば prompt cache のヒット率が上がる
- **最小・一度きりの読み取り**: 各 response は `status` → 必要 section を1回で済ませ、同じ response_file を後続ターンで再 Read しない（再読は tool result として二重計上される）
- **echo しない**: sub の出力本文を main が要約し直さない（main の出力が次ターンの入力として二重計上される）。response の Summary section を参照させる
- **多段委譲は TTL 内に詰める**: §7 の多段（`implement ⇒ explore` 等）は間を空けず連続実行し、確認待ちは1点に集約して cache TTL 跨ぎの再キャッシュを避ける

## 7. 多段委譲ポリシー（再帰防止）

- delegate された sub も別種別の delegate skill を呼べる（`implement ⇒ explore` は可）
- **同一種別がチェーンに二度登場することを禁止**（`implement ⇒ implement` も `implement ⇒ explore ⇒ implement` も不可、`implement ⇒ explore ⇒ review` は可）
- 種別が有限（explore / implement / chore / review）なのでチェーン長が頭打ちになり無限ループが構造的に発生しない
- チェーンは request file の構造化キー `task_type_chain`（先祖種別 + 自種別）で持ち回る。Claude パスは env が Bash 呼び出し間で持続しないため `task_type_chain` を source of truth とし子起動時に明示的に渡す
- 起動エントリで `check-delegate-chain.sh <task_type> <parent_task_type_chain>` を実行、該当すれば exit 4

## 8. delegate-chore からの skill 昇格提案

delegate-chore に流れるタスクは「専用 skill が無い作業」のシグナル。親エージェントはレスポンス消費後に評価する。

- **トリガ**: その chore が繰り返し現れる / 明確にスコープされた再利用可能なカテゴリのとき（一度きりの些末な chore では提案しない）
- **提案**: `AskUserQuestion` で専用 `delegate-<name>` skill 作成を提案（想定名 / 既定モデル / ツール権限 / 起動種別を添える）
- **生成**: 合意後 skill-creator で雛形を作り本プロトコル（resolve-model 既定の引数渡し / delegate-claude.sh・delegate-codex.sh 対称構造 / md2idx / 多段委譲チェーン参加）に沿わせる。新種別は `task_type_chain` 禁止対象に自動的に加わる

### TODO: 有望な追加・拡張候補

- `delegate-test-analysis`: 長い test / CI / typecheck / snapshot / coverage log を read-only に解析し、main が巨大ログを直接読まずに失敗原因・関連ファイル・再実行すべき検証だけを受け取る専用 skill を検討する。修正作業は `delegate-implement` に分け、test-analysis はログ読解と仮説提示に閉じる
- `session resume`: protocol v1 では標準化しない。`responder_session_id` は trace / debug 用 ID とし、resume token とは扱わない。標準の継続手段は、新しい `delegate-implement` request に前回の request / response / diff / 追加指示を再投入してコンテキストを再構成する方式とする。Claude は `--resume <session-id>` / `--session-id <uuid>` を持ち、session JSONL に `sessionId` / `cwd` が保存されるため、将来 opt-in の runtime-specific optimization として実験可能。ただし現行の `delegate-claude.sh` は `--no-session-persistence` によるエフェメラル実行を既定にしており、永続化は明示 opt-in に限る。Codex は `codex exec resume` と `$CODEX_HOME/sessions/.../<session-id>.jsonl` を持つが、resume 側で `-C` / `--sandbox` を明示できず、現行の `delegate-codex.sh` も isolated `CODEX_HOME` + `--ephemeral` を使うため、wrapper の隔離・権限制約と相性が悪い。Codex resume は CLI 側で cwd / sandbox を再指定できるまで標準化しない

### 決定論的プロセスの自動化提案

skill 昇格提案と同じ精神で、**LLM の判断を要さず決定論的に自動化できる手順**を検出したら、親エージェントは自動化を提案する。

- **トリガ**: 同じ多段コマンド列・検証手順・定型編集が繰り返し現れ、かつ分岐が固定的で LLM の判断が要らないとき（毎回同じ `git` 連打、固定パイプライン、機械的な一括置換など）
- **提案**: `AskUserQuestion` で、スクリプト化 / git hook / npm script / CI など適切な自動化手段を提示する（対象手順 / 自動化先 / 想定トリガを添える）。一度きりの手順や判断が絡む手順は提案しない
- **境界**: LLM の文脈判断が本質的に要る作業は skill 委譲（§3）に、判断が要らない決定論的手順はスクリプト/hook 等の自動化に振り分ける

## 9. スクリプトと exit code

| スクリプト                  | 役割                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `resolve-model.sh`          | モデル解決（種別非依存の汎用部品）                                                                                          |
| `check-md2idx.sh`           | `npx md2idx` 前提条件チェック                                                                                               |
| `check-delegate-chain.sh`   | 多段委譲の再帰防止チェック                                                                                                  |
| `delegate-codex.sh`         | gpt-\* 時の Codex 子プロセス起動                                                                                            |
| `prepare.sh`                | 準備の集約（前提チェック→モデル解決→チェーン確認→リクエスト生成を 1 呼び出しに畳み main の bash 往復と context 出力を削減） |
| `build-request.sh`          | リクエスト生成（命名・md2idx・envelope 付与）。telemetry 有効時は request/body サイズを記録                                 |
| `read-request.sh`           | リクエストの段階読み取り（worker 側）。telemetry 有効時は worker が実際に読んだ selector と出力量を記録                     |
| `build-response.sh`         | レスポンス生成（worker 側）。telemetry 有効時は response/body サイズを記録                                                  |
| `read-response.sh`          | レスポンスの段階読み取り（main 側）。`auto` でサイズゲート丸読み。telemetry 有効時は inline 判定と response サイズを記録    |
| `summarize-metrics.ts`      | telemetry JSONL の集計（human table / `--json`）                                                                            |
| `run-metrics-fixtures.sh`   | 固定 fixture を protocol scripts に通して metrics と summary を生成                                                         |
| `check-metrics-baseline.sh` | fixture 現在値と `fixtures/metrics/baseline.json` の drift 検出                                                             |

| exit | 意味                                                     |
| ---- | -------------------------------------------------------- |
| 0    | 成功                                                     |
| 1    | その他の実行失敗                                         |
| 2    | 引数エラー（usage）                                      |
| 3    | 前提条件不足（codex/npx/jq 不在、`npx md2idx` 実行不可） |
| 4    | 委譲サイクル検出（同一種別の多段委譲）                   |

## 10. リポジトリ構成と配布

```
delegate-skills/
  fixtures/
    metrics/                      # telemetry の固定シナリオと baseline
      baseline.json
      scriptable-chore/{request.md,response.md}
      read-heavy-chore/{request.md,response.md}
      mixed-chore/{request.md,response.md}
  skills/                        # gh skill install の配布元（canonical SKILL.md）
    delegate-explore/
      SKILL.md
      scripts/                   # shared/ からの生成コピー（sync-shared.ts）
    delegate-implement/{SKILL.md, scripts/}
    delegate-chore/{SKILL.md, scripts/}
    delegate-review/{SKILL.md, scripts/}
  shared/                        # 共有スクリプトの正本（種別/実行系非依存）
    resolve-model.sh
    check-md2idx.sh
    check-delegate-chain.sh
    delegate-codex.sh            # gpt-* 時の Codex 子プロセス起動
    delegate-claude.sh           # Claude 系時の claude -p 子プロセス起動
    prepare.sh
    build-request.sh
    read-request.sh
    build-response.sh
    read-response.sh
  scripts/
    sync-shared.ts               # shared/ → 各 skill scripts/ への同期（+ in-source test）
    summarize-metrics.ts         # telemetry JSONL 集計
    run-metrics-fixtures.sh      # fixture 実行
    check-metrics-baseline.sh    # baseline drift 検出
  docs/
    design/
      spec.md                    # 本仕様
      protocol-v1.md             # ファイルプロトコル詳細
  README.md
```

- Claude パスは `delegate-claude.sh`（`claude -p` 子プロセス）、Codex パスは `delegate-codex.sh`（`codex exec` 子プロセス）で、どちらも SKILL.md から同じ呼び出し形式で起動する
- **self-contained 配布**: 共有スクリプトの正本は `shared/` に置き、guarded 系と同じ `shared/ → 各 skill の scripts/ へコピー同期`パターンで各 skill に同梱する。`gh skill install` 後の呼び出しパスは Claude Code では `.claude/skills/delegate-<type>/scripts/...`、Codex では `.agents/skills/delegate-<type>/scripts/...` になり、同じ相対構造を保つ。SKILL.md のコマンド例は Claude Code の allowed-tools と整合するよう `.claude/...` を示し、Codex では `.agents/...` に読み替える。同期は `sync-shared.ts`（`npm run sync-shared` / `:check`）が担い、コピーの直接編集は drift として fail-closed で検出する
- 共有スクリプトは shell のため `bash -n` / 実行 smoke / fixture baseline で、TypeScript スクリプトは Vitest の in-source testing で検証する

## 11. 環境変数

| 環境変数                       | 既定                                     | 説明                                                             |
| ------------------------------ | ---------------------------------------- | ---------------------------------------------------------------- |
| `DELEGATE_<TYPE>_MODEL`        | skill 毎                                 | 種別別のモデル上書き                                             |
| `DELEGATE_WORK_DIR`            | mktemp 既定（`TMPDIR`、無ければ `/tmp`） | リクエスト/レスポンスファイルの置き場                            |
| `DELEGATE_RESPONSE_INLINE_MAX` | `10240`（バイト）                        | `read-response.sh auto` が丸読み/段階読みを切り替えるサイズ閾値  |
| `DELEGATE_METRICS_FILE`        | 未設定（記録しない）                     | 設定時のみ proxy metric を JSONL で追記する任意 telemetry 出力先 |
| `DELEGATE_IMAGEGEN_OUTPUT_DIR` | `.temp/imagegen`                         | `delegate-imagegen` の既定出力先                                 |

## 12. 脅威モデル・割り切り

- 結果/リクエストは自前 subagent が書くものであり外部 untrusted コンテンツではない → サニタイズ不要
- subagent がリポジトリ内の悪意あるファイルを読んで影響を受ける可能性は残る（スコープ外）
- 安価モデルの品質ブレは main の検証フェーズで吸収する前提
- 検証は worker 側に閉じ込め、main は報告 Markdown の Verification section（実行コマンドと exit code を含む）から最小限だけ確認する（§6）。決定論的検証（`vp check` の lint/型、`vp test`）は exit code をそのまま信頼し、意味的・受け入れ基準のみ main が最小サマリで確認する。安価 worker による虚偽 pass のリスクは、捏造の旨みが薄い機械的な exit code 報告に信頼を限定することで抑える
- Codex パスは別課金のサブプロセス（GPT 系に in-session 実行手段が無いため不可避）。Claude パスも `claude -p` 子プロセスのため別セッション課金になる
- Codex パスは `danger-full-access` で動くため sandbox 由来の隔離が無い。Claude パスは `--dangerously-skip-permissions` だが、read-only 種別（explore / review）では `--allowedTools "Read,Bash"` で Edit / Write を技術的に除外する。ただし Bash 経由のシェル書き込みは防げないため、push 抑止を含む完全な read-only 性は prompt の constraints と main の検証に依存する残存リスクがある

## 13. 参照

- [protocol-v1.md](protocol-v1.md) — ファイルプロトコル v1 の詳細
- [md2idx](https://github.com/oubakiou/md2idx) — リクエスト/レスポンスのトークン圧縮（`index` / `sections`）
- [guarded-webfetch-codex](https://github.com/oubakiou/skills/tree/main/skills/guarded-webfetch-codex) — Codex 子プロセス起動骨格の流用元（§5）
- [vite-plus（`vp`）](https://www.npmjs.com/package/vite-plus) — format / lint / test / 型チェックのツールチェーン
