# delegate-skills protocol v1

main agent と delegate された worker 子プロセスの間のファイルベースプロトコル。実行系（`claude -p` / `codex exec` / `devin -p` / `agent -p` / `opencode run`）に依存しない。target backend は 5 種、requester は Claude / Codex / Devin / Cursor の 4 種のままである。

> 生成・読み取りはバンドル内蔵の `delegate-cli`（各 skill の `scripts/` に同梱する exec shim 経由）が行う。runtime 前提は Node.js 24+、`.sh` shim を実行する POSIX shell、対象 backend CLI であり、`jq` も `npx md2idx` も要らない。follow-up を使う場合は `git` も必要になる。

## ファイル命名（main 事前確保）

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
response_file="${request_file%_req.json}_res.json"   # 乱数トークンを共有して派生
```

- request/response は `ts` とランダムトークンを共有し、末尾の `_req`/`_res` だけが異なる（例: `..._Ab3kP_req.json` ↔ `..._Ab3kP_res.json`）。同一秒の並列実行でもペアを一意に特定できる
- 乱数の出所は request の mktemp 1 箇所。response はそれを流用するため一意性も保たれる
- クリーンアップ: ファイルは残す（監査・デバッグ用）。既定では mktemp の置き場（`TMPDIR`、無ければ `/tmp`）に蓄積するため、不要になれば手動または別途のクリーンアップで削除する。`DELEGATE_WORK_DIR` で置き場を固定できる

## 人間向け Markdown 派生物

request / response の JSON は protocol の source of truth とし、agent 間通信・互換性判定・段階読み取りは JSON だけを見る。一方、監査・デバッグで人間が読みやすいよう、JSON 書き出し後に同じ basename の `.md` を best-effort で生成する。実装は `protocol.ts` の `writeCompanionMarkdown` が `sections` を `\n\n` で結合して `<basename>.md` に書く（`build-request` / `build-response` / wrapper が呼ぶ）。

`.md` は `sections` を結合した補助成果物であり、`task_type_chain` / `requester_session_id` / `status` / `responder_session_id` などの構造化メタデータは正本 JSON に残す。`.md` 生成に失敗しても protocol の成否は JSON 生成結果で判定する。スクリプトは `.md` 本文を stdout に出さず、ファイルへ直接書く。

## observe JSON の optional metadata

protocol v1 の request / response schema は、session reuse の有無で変えない。resumable initial run と follow-up run は、通常 run と同じ request/response file を新しく作り、lineage と backend resume handle は observe JSON の optional metadata にだけ記録する。

- `lineage`: `lineage_id` と、follow-up では前回 observe JSON への `followup_of`
- `backend_session`: backend CLI へ渡す resume metadata。`backend` / `model` / `resume_id` / `resume_source` / `persistence` / `home_dir` を持つ
- `run_context`: `repo_root` / `worktree_root` / `git_head` を必須にした stale-context 判定情報。`git_branch` / `dirty` は補助情報
- `error`: 子 CLI の失敗分類がついた run だけに入る。`kind` / `retryable` / `backend` / `model` / `detected_at` を持ち、親は `read-json.sh .error.kind` で読める。分類がつかない run ではキー自体が現れない

`responder_session_id` は response を書いた worker / wrapper の追跡 ID であり、backend resume handle ではない。follow-up 可否は `backend_session.persistence == "resumable"` と `backend_session.resume_id`、および `run_context` の検証結果で判断する。

## リクエストファイル（main → sub）

トップレベルキー: `protocol_version` / `type` / `task_type` / `model` / `task_type_chain` / `requester_session_id` / `index` / `sections`

```json
{
  "protocol_version": 1,
  "type": "request",
  "task_type": "implement",
  "model": "sonnet",
  "task_type_chain": ["implement"],
  "requester_session_id": "...",
  "index": "...",
  "sections": ["...", "..."]
}
```

- `type`: 固定値 `request`（ファイル種別の自己記述）
- `model`: 依頼先のモデル名。`prepare.sh` で解決した値を格納する
- `task_type_chain`: 委譲チェーン（先祖の skill 種別 + 自種別）。再帰防止に使う
- `requester_session_id`: 必須。リクエスト元（親エージェント）のプロセス / セッション ID。多段委譲の追跡・デバッグ用
- `index` / `sections`: 作業指示の md2idx 出力。Markdown 見出しは Objective / Scope / Context / Acceptance criteria / Verification / Constraints
- response_file のパスは request file には含めず、起動時の prompt で渡す（main 事前確保のパスを唯一の source of truth とする）

生成は `build-request.sh`（→ `delegate-cli build-request`）が行う。指示 Markdown をバンドル内蔵の md2idx で `index` / `sections` に変換し、構造化キーを前置して request JSON を書く。JSON 書き出し後、人間向けに `${request_file%.json}.md` を補助生成する。

### request の worker への受け渡し

wrapper は検証済み request JSON（正本）の `.sections` と `task_type_chain` を**初期 prompt に埋め込んで**渡す。worker が read-request で 1 往復を使う必要はない。gate は `DELEGATE_REQUEST_INLINE_MAX`（既定 256KB。モデル context 上限に対する保守的なバイト近似）で、超過時のみ従来の `read-request.sh` 指示へ fallback する。companion `.md` は best-effort の監査用派生物であり、実行入力には使わない。

prompt 自体の受け渡しは argv ではなく Claude / Codex / Cursor / OpenCode は stdin、Devin は `--prompt-file`（ARG_MAX 非依存、`ps` にも載らない）。Grok と Codex follow-up（`exec resume`）は stdin 受け渡しが未実測のため argv を維持しており、この 2 経路のみ埋め込み gate を単一引数上限（MAX_ARG_STRLEN ≈128KiB）に収まる縮小値（96KB）に絞る。request_file は fallback・監査・多段委譲の追跡用に従来どおり生成される。

OpenCode は例外である。cwd 外の request file を worker が読めないため `read-request.sh` fallback は成立しない。`DELEGATE_REQUEST_INLINE_MAX` 超過は child 起動前に fail-closed とし、wrapper が failed response を書いて exit 1 で停止する。回避策は request を分割するか、他 backend を使うことである。

## レスポンスファイル（sub → main）

トップレベルキー: `protocol_version` / `type` / `status` / `responder_session_id` / `index` / `sections`

```json
{
  "protocol_version": 1,
  "type": "response",
  "status": "completed",
  "responder_session_id": "...",
  "index": "...",
  "sections": ["...", "..."]
}
```

- `protocol_version`: リクエストと揃える（バージョン差検出・互換性判定用）
- `type`: 固定値 `response`（ファイル種別の自己記述）
- `status`: `completed | partial | failed | needs_input`。main が最優先・最安に読む構造化フィールド（md2idx の section ではない）
- `responder_session_id`: 必須。リクエスト先 worker 子プロセスのプロセス / セッション ID。追跡・デバッグ用。backend resume handle ではない
- `index` / `sections`: 作業報告の md2idx 出力。標準の Markdown 見出しは Summary / Changed files / Commands / Verification / Findings / Blockers / Error。skill 固有の成果物に合わせて見出しを追加・置換してよい。`delegate-imagegen` は Summary / Generated files / Parameters / Verification / Blockers を使う。検証結果は構造化フィールドに持たず、Verification section に収める。main は `status` の次にこの section だけを必要時に引く（検証ログを main の context に流し込まない）

生成は `build-response.sh`（→ `delegate-cli build-response`）が行う。wrapper が worker から回収した報告 Markdown をバンドル内蔵の md2idx で `index` / `sections` に変換し、構造化キーを前置して response JSON を書く。JSON 書き出し後、人間向けに `${response_file%.json}.md` を補助生成する。worker は md2idx / jq / build-response.sh を実行しない。

### 誰が response を組み立てるか（worker / wrapper の責務）

ファイル形式は上記のまま、組み立ての責務は wrapper 側にある。worker は LLM 往復を増やす md2idx 変換をせず、**報告本体だけ**を返す。報告方式は wrapper が子プロセス起動前に backend で確定する。方式は 3 つある:

- **構造化最終応答方式**（`structured`。schema を CLI で強制できる backend が既定: Claude `--json-schema`、Codex `--output-schema`）: worker は最終 assistant message として `{status, report_markdown}` の構造化出力だけを返す。wrapper が回収（Claude は stream-json result event の `structured_output`、Codex は `--output-last-message` ファイル）して md2idx 変換・envelope 付与・検証を行う。報告用のファイル書込許可は不要
- **report.md 方式**（`report_md`。schema 強制手段が無い backend が既定: Cursor / Devin / Grok）: worker は wrapper 指定のパスに front-matter `status: <値>` 付き Markdown を 1 回で書き、最終応答は status 一語のみ。wrapper が front-matter を剥がして md2idx 変換・envelope 付与を行う
- **stdout_text 方式**（`stdout_text`。OpenCode）: worker は最終応答として front-matter 付き Markdown を返す。wrapper は JSONL の最終 `text` イベントから回収し、front-matter を剥がして md2idx 変換・envelope 付与を行う。run_dir への書き込みを worker に要求しない

いずれの方式でも、回収失敗（構造化出力の欠落・`status` の語彙外・report ファイル欠落や front-matter 不正）は wrapper が failed response を生成する（fail-closed。方式の実行後切替や自動リトライはしない）。構造化最終応答方式の parse 成否は observe JSON `timing.structured_output_parse` に記録される。`report_md` / `stdout_text` では `timing.structured_output_parse` は `null` である（front-matter parse の成否はここへ入れない）。

段階読み取り（main 側）:

```bash
bash <skill>/scripts/read-response.sh "$response_file" auto
# 小さい response は status と全 section を 1 回で返す。大きいときは status + index + Summary だけを返し、
# 必要 section は "$response_file" <N> で追加取得する
bash <skill>/scripts/read-json.sh .status "$response_file"
```

## 多段委譲（再帰防止）

- delegate された sub も別種別の delegate skill を呼べる（`implement ⇒ explore` は可）
- ただし**同一種別がチェーンに二度登場することを禁止**（`implement ⇒ implement` も `implement ⇒ explore ⇒ implement` も不可、`implement ⇒ explore ⇒ review` は可）
- 起動エントリで `check-delegate-chain.sh <task_type> <parent_task_type_chain>` を実行。該当すれば exit 4

## exit code

| code | 意味                                                                                    |
| ---- | --------------------------------------------------------------------------------------- |
| 0    | 成功                                                                                    |
| 1    | その他の実行失敗                                                                        |
| 2    | 引数エラー（usage）                                                                     |
| 3    | 前提条件不足（node / 対象 backend CLI 不在）                                            |
| 4    | 委譲サイクル検出（同一種別の多段委譲）                                                  |
| 5    | follow-up 検証失敗（resume 不可・context 不一致・継承 model 名が無効）                  |
| 6    | model 名・effort 指定不正（無効な model 表記・effort 不正値・backend 非対応・二重指定） |

OpenCode 固有: 不正な `DELEGATE_OPENCODE_MCP_SOURCE` は child 起動前に exit 3。`DELEGATE_REQUEST_INLINE_MAX` 超過は child 起動前に exit 1 と failed response（`read-request.sh` fallback は cwd 外を読めないため成立しない）。
