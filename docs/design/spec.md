# delegate-skills 仕様

実装・調査・git 操作・雑務などのタスクを安価なモデルの subagent に委譲し、トークン費用を圧縮する skill 集の仕様。

## 1. 目的

- main agent（高価なモデル）の context を汚さず、定型的・機械的な作業を安価なモデルの subagent に委譲してトークン総量を圧縮する
- 委譲先の品質ブレは main の検証フェーズで吸収し、手戻りによるトークン増を抑える

## 2. アーキテクチャ概要

```
main agent
  ├─ check-md2idx.sh          前提条件チェック（npx md2idx, fail-closed）
  ├─ resolve-model.sh         モデル解決（種別env → デフォルト）
  ├─ check-delegate-chain.sh  多段委譲の再帰防止（同一種別2度禁止）
  ├─ request_file / response_file を mktemp で事前確保（ts + 乱数を共有）
  ├─ 実行系分岐
  │    ├─ model が gpt*  → delegate-codex.sh（Codex 子プロセス）
  │    └─ それ以外        → Agent tool（in-session, subagent_type は skill 毎）
  └─ response を status → verdict → index → 必要 section の順に段階読み取り → 検証
```

ファイルプロトコルは実行系（Claude Agent tool / Codex）に依存しない。「誰が request_file を読み response_file を書くか」だけが変わる。

### 委譲メカニズムの選定理由

- Claude 系は in-session の **Agent tool** を使う。`claude -p` は別起動のサブプロセスで課金体系変更のリスクがあるため採用しない
- `gpt-*` は in-session の実行手段が無いため **Codex 子プロセス**が必須

## 3. skill 一覧

| skill                                         | 用途                                       | subagent_type   | ツール権限                                       | 既定モデル | env                                              |
| --------------------------------------------- | ------------------------------------------ | --------------- | ------------------------------------------------ | ---------- | ------------------------------------------------ |
| [`delegate-explore`](delegate-explore.md)     | read-only のコード/ドキュメント探索・読解  | Explore         | read-only（Read/Grep/Glob）                      | `haiku`    | `DELEGATE_EXPLORE_MODEL` / `DELEGATE_WORK_DIR`   |
| [`delegate-implement`](delegate-implement.md) | コード実装・修正（1 コミットに収まる単位） | general-purpose | Edit/Write/Bash（push なし）                     | `sonnet`   | `DELEGATE_IMPLEMENT_MODEL` / `DELEGATE_WORK_DIR` |
| [`delegate-git`](delegate-git.md)             | git + gh 操作                              | general-purpose | git/gh 限定はプロンプト制約で担保（push・PR 可） | `haiku`    | `DELEGATE_GIT_MODEL` / `DELEGATE_WORK_DIR`       |
| [`delegate-chore`](delegate-chore.md)         | フォールバック雑務                         | general-purpose | Edit/Write/Bash（push なし）                     | `haiku`    | `DELEGATE_CHORE_MODEL` / `DELEGATE_WORK_DIR`     |
| [`delegate-review`](delegate-review.md)       | コードレビュー（差分の指摘）               | general-purpose | read-only（Read/Grep/Glob）                      | `opus`     | `DELEGATE_REVIEW_MODEL` / `DELEGATE_WORK_DIR`    |

### 既定モデルの根拠

- explore / chore は read 中心・低リスクのため `haiku`
- git は取り消し困難な外向き操作（push/PR）を含むが、判断をサブエージェントに委ねず main が明確な指示で単純操作のみを delegate する前提のため `haiku`
- implement も編集の判断を要するため `sonnet`
- review は指摘品質が成果物に直結し判断比重が高いため `opus`
- 個々のタスクが軽微なときは、その種別の既定モデルを `DELEGATE_<TYPE>_MODEL=haiku` で明示的に引き下げてコストを抑えられる

## 4. モデル解決

共有 `resolve-model.sh` にロジックを一元化し、skill 固有デフォルトは各 SKILL.md が引数で渡す。

```
resolve-model.sh <種別env名> <skill固有デフォルト>
解決順: $種別env → 引数デフォルト
出力: Claude エイリアス(sonnet|haiku|opus|fable) または gpt-* モデルID
```

env に入れる値は Claude エイリアス（Agent tool の enum 対応）か `gpt-*` モデルID（Codex へ渡す）の2系統に限定する。

## 5. 実行系の二分岐

`resolve-model.sh` の出力プレフィックスで選ぶ。

| 種別      | Claude パス（Agent tool）                      | Codex パス（`codex exec -m <model>`）        |
| --------- | ---------------------------------------------- | -------------------------------------------- |
| explore   | `subagent_type: Explore`（read-only）          | `--sandbox danger-full-access` + constraints |
| implement | `subagent_type: general-purpose`               | `--sandbox danger-full-access`               |
| git       | `subagent_type: general-purpose` + constraints | `--sandbox danger-full-access` + constraints |
| chore     | `subagent_type: general-purpose`               | `--sandbox danger-full-access`               |
| review    | `subagent_type: general-purpose`（read-only）  | `--sandbox danger-full-access` + constraints |

### Codex パスの起動

`delegate-codex.sh` は [guarded-webfetch-codex](https://github.com/oubakiou/skills/tree/main/skills/guarded-webfetch-codex) の起動骨格を流用する。

- 隔離 `CODEX_HOME`（disposable home に `auth.json` だけコピーしログイン維持）/ TMPDIR 隔離
- `--skip-git-repo-check --ephemeral --ignore-user-config`
- `--ignore-rules` は**付けない**（AGENTS.md を読ませ規約遵守させる）
- `--sandbox danger-full-access`
- `-C "$REPO_ROOT"`（隔離 cwd ではなく対象リポジトリ root で実作業）
- `--output-last-message` は status の回収に流用する（本文は子が直接 response_file に書くため `--output-schema` は使わない）
- stdout は response_file のパスのみ

### Codex sandbox を danger-full-access に統一する理由

- `read-only` だと response_file を書けない（shell 書き込みも全面遮断）。explore も report を書くため最低限の書き込みが要る
- `npx md2idx` のダウンロードにネットワークが要る（`workspace-write` では遮断される）
- トレードオフ: push 抑止・explore の read-only 性は sandbox では強制されず prompt の constraints と main の検証フェーズに依存する

## 6. ファイルプロトコル（protocol v1）

main が request_file / response_file を事前確保する。詳細は [protocol-v1.md](protocol-v1.md)。

### 命名

```bash
ts="$(date +%Y%m%d_%H%M%S)"
name="delegate_<type>_${ts}_request_XXXXX"
# 既定の置き場は mktemp に委ねる（TMPDIR、無ければ /tmp）。DELEGATE_WORK_DIR で上書き可
if [ -n "${DELEGATE_WORK_DIR:-}" ]; then
  mkdir -p "$DELEGATE_WORK_DIR"
  request_file="$(mktemp --tmpdir="$DELEGATE_WORK_DIR" "$name" --suffix=.json)"
else
  request_file="$(mktemp --tmpdir "$name" --suffix=.json)"
fi
response_file="${request_file/_request_/_response_}"
```

- request_file と response_file は `ts`（タイムスタンプ）とランダムトークンを共有し、ファイル名中の `request`/`response` だけが異なる → 同一秒に並列実行してもファイル名から両者の対応関係を一意特定できる
- 乱数の出所は request の mktemp 1 箇所。一意性も保たれる
- クリーンアップ: ファイルは残す（監査・デバッグ用）。既定では mktemp の置き場（`TMPDIR`、無ければ `/tmp`）に蓄積するため不要分は手動で削除する。`DELEGATE_WORK_DIR` で置き場を固定できる
- **main 事前確保の利点**: main は sub の最終メッセージをパースせずに response_file パスを決定的に知れる。sub の返答が崩れてもパスを見失わない

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

### md2idx（トークン圧縮の核）

両ファイルとも書き手は指示/報告の Markdown を `npx md2idx` に通して `index` / `sections` を生成し、その前に構造化キー（md2idx 出力ではない機械可読フィールド。request なら `protocol_version` / `type` / `task_type` / `task_type_chain` 等、response なら `protocol_version` / `type` / `status` 等）を前置する。response の読み手（main）は `status` → `index` → 必要 section の順で段階読み取りする。一方 request の読み手（sub）は読み飛ばしてよい情報が無く、sub のトークン単価も安いため JSON を丸ごと読む。`npx md2idx` は前提条件であり、実行不可なら fail-closed（exit 3）。

### main 側の context / cache 規律（コスト最適化）

main が最高級モデルのとき、削減は「委譲」とは独立の別レイヤーとしても効く。md2idx 圧縮と乗算で効く原則:

- **append-only**: 過去ターン（SKILL.md / プロトコルの規約文、既読の response）を再注入・再要約しない。プレフィックスを保てば prompt cache のヒット率が上がる
- **最小・一度きりの読み取り**: 各 response は `status` → 必要 section を1回で済ませ、同じ response_file を後続ターンで再 Read しない（再読は tool result として二重計上される）
- **echo しない**: sub の出力本文を main が要約し直さない（main の出力が次ターンの入力として二重計上される）。response の Summary section を参照させる
- **多段委譲は TTL 内に詰める**: §7 の多段（`implement ⇒ explore ⇒ git` 等）は間を空けず連続実行し、確認待ちは1点に集約して cache TTL 跨ぎの再キャッシュを避ける

## 7. 多段委譲ポリシー（再帰防止）

- delegate された sub も別種別の delegate skill を呼べる（`implement ⇒ explore` は可）
- **同一種別がチェーンに二度登場することを禁止**（`implement ⇒ implement` も `implement ⇒ explore ⇒ implement` も不可、`implement ⇒ explore ⇒ git` は可）
- 種別が有限（explore / implement / git / chore）なのでチェーン長が頭打ちになり無限ループが構造的に発生しない
- チェーンは request file の構造化キー `task_type_chain`（先祖種別 + 自種別）で持ち回る。Claude パスは env が Bash 呼び出し間で持続しないため `task_type_chain` を source of truth とし子起動時に明示的に渡す
- 起動エントリで `check-delegate-chain.sh <task_type> <parent_task_type_chain>` を実行、該当すれば exit 4

## 8. delegate-chore からの skill 昇格提案

delegate-chore に流れるタスクは「専用 skill が無い作業」のシグナル。親エージェントはレスポンス消費後に評価する。

- **トリガ**: その chore が繰り返し現れる / 明確にスコープされた再利用可能なカテゴリのとき（一度きりの些末な chore では提案しない）
- **提案**: `AskUserQuestion` で専用 `delegate-<name>` skill 作成を提案（想定名 / 既定モデル / ツール権限 / 起動種別を添える）
- **生成**: 合意後 skill-creator で雛形を作り本プロトコル（resolve-model 既定の引数渡し / subagent_type / md2idx / 多段委譲チェーン参加）に沿わせる。新種別は `task_type_chain` 禁止対象に自動的に加わる

### 決定論的プロセスの自動化提案

skill 昇格提案と同じ精神で、**LLM の判断を要さず決定論的に自動化できる手順**を検出したら、親エージェントは自動化を提案する。

- **トリガ**: 同じ多段コマンド列・検証手順・定型編集が繰り返し現れ、かつ分岐が固定的で LLM の判断が要らないとき（毎回同じ `git` 連打、固定パイプライン、機械的な一括置換など）
- **提案**: `AskUserQuestion` で、スクリプト化 / git hook / npm script / CI など適切な自動化手段を提示する（対象手順 / 自動化先 / 想定トリガを添える）。一度きりの手順や判断が絡む手順は提案しない
- **境界**: LLM の文脈判断が本質的に要る作業は skill 委譲（§3）に、判断が要らない決定論的手順はスクリプト/hook 等の自動化に振り分ける

## 9. スクリプトと exit code

| スクリプト                | 役割                               |
| ------------------------- | ---------------------------------- |
| `resolve-model.sh`        | モデル解決（種別非依存の汎用部品） |
| `check-md2idx.sh`         | `npx md2idx` 前提条件チェック      |
| `check-delegate-chain.sh` | 多段委譲の再帰防止チェック         |
| `delegate-codex.sh`       | gpt-\* 時の Codex 子プロセス起動   |

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
  skills/                        # gh skill install の配布元（canonical SKILL.md）
    delegate-explore/
      SKILL.md
      scripts/                   # shared/ からの生成コピー（sync-shared.ts）
    delegate-implement/{SKILL.md, scripts/}
    delegate-git/{SKILL.md, scripts/}
    delegate-chore/{SKILL.md, scripts/}
    delegate-review/{SKILL.md, scripts/}
  shared/                        # 共有スクリプトの正本（種別/実行系非依存）
    resolve-model.sh
    check-md2idx.sh
    check-delegate-chain.sh
    delegate-codex.sh            # gpt-* 時のみ必要
  scripts/
    sync-shared.ts               # shared/ → 各 skill scripts/ への同期（+ in-source test）
  docs/
    design/
      spec.md                    # 本仕様
      protocol-v1.md             # ファイルプロトコル詳細
  README.md
```

- Claude パスは専用 Bash スクリプトを持たず、SKILL.md の指示で main が Agent tool を直接呼ぶ。Codex パスのみ `delegate-codex.sh` が要る
- **self-contained 配布**: 共有スクリプトの正本は `shared/` に置き、guarded 系と同じ `shared/ → 各 skill の scripts/ へコピー同期`パターンで各 skill に同梱する。SKILL.md は skill ディレクトリ相対の `.claude/skills/delegate-<type>/scripts/...` でスクリプトを呼び、`gh skill install` 単体でも動くようにする。同期は `sync-shared.ts`（`npm run sync-shared` / `:check`）が担い、コピーの直接編集は drift として fail-closed で検出する
- 共有スクリプトは shell のため shellcheck 等で、`sync-shared.ts` は Vitest の in-source testing で検証する

## 11. 環境変数

| 環境変数                | 既定                                     | 説明                                  |
| ----------------------- | ---------------------------------------- | ------------------------------------- |
| `DELEGATE_<TYPE>_MODEL` | skill 毎                                 | 種別別のモデル上書き                  |
| `DELEGATE_WORK_DIR`     | mktemp 既定（`TMPDIR`、無ければ `/tmp`） | リクエスト/レスポンスファイルの置き場 |

## 12. 脅威モデル・割り切り

- 結果/リクエストは自前 subagent が書くものであり外部 untrusted コンテンツではない → サニタイズ不要
- subagent がリポジトリ内の悪意あるファイルを読んで影響を受ける可能性は残る（スコープ外）
- 安価モデルの品質ブレは main の検証フェーズで吸収する前提
- 検証は worker 側に閉じ込め、main は報告 Markdown の Verification section（実行コマンドと exit code を含む）から最小限だけ確認する（§6）。決定論的検証（`vp check` の lint/型、`vp test`）は exit code をそのまま信頼し、意味的・受け入れ基準のみ main が最小サマリで確認する。安価 worker による虚偽 pass のリスクは、捏造の旨みが薄い機械的な exit code 報告に信頼を限定することで抑える
- Codex パスは別課金のサブプロセス（GPT 系に in-session 実行手段が無いため不可避）
- Codex パスは `danger-full-access` で動くため sandbox 由来の隔離が無い。push 抑止・explore の read-only 性は prompt の constraints と main の検証に依存する残存リスクがある
- `delegate-git` の破壊的操作（force push / branch 削除 / PR merge）は残存リスクであり main の検証で確認する

## 13. 参照

- [protocol-v1.md](protocol-v1.md) — ファイルプロトコル v1 の詳細
- [md2idx](https://github.com/oubakiou/md2idx) — リクエスト/レスポンスのトークン圧縮（`index` / `sections`）
- [guarded-webfetch-codex](https://github.com/oubakiou/skills/tree/main/skills/guarded-webfetch-codex) — Codex 子プロセス起動骨格の流用元（§5）
- [vite-plus（`vp`）](https://www.npmjs.com/package/vite-plus) — format / lint / test / 型チェックのツールチェーン
