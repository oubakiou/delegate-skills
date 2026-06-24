# delegate-skills protocol v1

main agent と delegate された subagent / Codex 子プロセスの間のファイルベースプロトコル。実行系（Claude Agent tool / Codex）に依存しない。

> 生成・読み取りは `shared/{build-request,read-request,build-response,read-response}.sh`（各 skill の `scripts/` に同梱）に集約されている。以下の `npx md2idx` / `jq` の手順はこれらが内部で行う処理の仕様であり、運用では手組みの代わりにスクリプトを使う。

## ファイル命名（main 事前確保）

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
response_file="${request_file/_request_/_response_}"   # 乱数トークンを共有して派生
```

- request/response は `ts` とランダムトークンを共有し、`request`/`response` だけが異なる（例: `..._request_Ab3kP.json` ↔ `..._response_Ab3kP.json`）。同一秒の並列実行でもペアを一意に特定できる
- 乱数の出所は request の mktemp 1 箇所。response はそれを流用するため一意性も保たれる
- クリーンアップ: ファイルは残す（監査・デバッグ用）。既定では mktemp の置き場（`TMPDIR`、無ければ `/tmp`）に蓄積するため、不要になれば手動または別途のクリーンアップで削除する。`DELEGATE_WORK_DIR` で置き場を固定できる

## 人間向け Markdown 派生物

request / response の JSON は protocol の source of truth とし、agent 間通信・互換性判定・段階読み取りは JSON だけを見る。一方、監査・デバッグで人間が読みやすいよう、JSON 書き出し後に同じ basename の `.md` を best-effort で生成する。

```bash
jq -r '.sections | join("\n\n")' "$request_file" >"${request_file%.json}.md"
jq -r '.sections | join("\n\n")' "$response_file" >"${response_file%.json}.md"
```

`.md` は `sections` を結合した補助成果物であり、`task_type_chain` / `requester_session_id` / `status` / `responder_session_id` などの構造化メタデータは正本 JSON に残す。`.md` 生成に失敗しても protocol の成否は JSON 生成結果で判定する。スクリプトは `.md` 本文を stdout に出さず、ファイルへ直接書く。

## リクエストファイル（main → sub）

トップレベルキー: `protocol_version` / `type` / `task_type` / `task_type_chain` / `requester_session_id` / `index` / `sections`

```json
{
  "protocol_version": 1,
  "type": "request",
  "task_type": "implement",
  "task_type_chain": ["implement"],
  "requester_session_id": "...",
  "index": "...",
  "sections": ["...", "..."]
}
```

- `type`: 固定値 `request`（ファイル種別の自己記述）
- `task_type_chain`: 委譲チェーン（先祖の skill 種別 + 自種別）。再帰防止に使う
- `requester_session_id`: 必須。リクエスト元（親エージェント）のプロセス / セッション ID。多段委譲の追跡・デバッグ用
- `index` / `sections`: 作業指示の md2idx 出力。Markdown 見出しは Objective / Scope / Context / Acceptance criteria / Verification / Constraints
- response_file のパスは request file には含めず、起動時の prompt で渡す（main 事前確保のパスを唯一の source of truth とする）

生成:

```bash
# requester_session_id は必須（トレーサビリティ用）
npx md2idx request.md | jq --argjson c "$task_type_chain" --arg sid "$REQUESTER_SESSION_ID" \
  '{protocol_version: 1, type: "request", task_type: "implement", task_type_chain: $c, requester_session_id: $sid}
   + .' > "$request_file"
jq -r '.sections | join("\n\n")' "$request_file" >"${request_file%.json}.md"
```

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
- `responder_session_id`: 必須。リクエスト先（子エージェント / Codex 子プロセス）のプロセス / セッション ID。追跡・デバッグ用
- `index` / `sections`: 作業報告の md2idx 出力。Markdown 見出しは Summary / Changed files / Commands / Verification / Findings / Blockers / Error。検証結果は構造化フィールドに持たず、Verification section に収める。main は `status` の次にこの section だけを必要時に引く（検証ログを main の context に流し込まない）

生成:

```bash
# responder_session_id は必須（トレーサビリティ用）。検証結果は report.md の Verification section に収める
npx md2idx report.md | jq --arg s "$status" --arg sid "$RESPONDER_SESSION_ID" \
  '{protocol_version: 1, type: "response", status: $s, responder_session_id: $sid}
   + .' > "$response_file"
jq -r '.sections | join("\n\n")' "$response_file" >"${response_file%.json}.md"
```

段階読み取り（main 側）:

```bash
jq -r '.status'               "$response_file"   # まずゲーティング（最安）
jq -r '.index'                "$response_file"   # 次に目次
# 検証結果が要るときだけ Verification section を引く（pass なら検証ログは読まない）
jq -r '.sections[1]'          "$response_file"   # 必要 section のみ
```

## 多段委譲（再帰防止）

- delegate された sub も別種別の delegate skill を呼べる（`implement ⇒ explore` は可）
- ただし**同一種別がチェーンに二度登場することを禁止**（`implement ⇒ implement` も `implement ⇒ explore ⇒ implement` も不可、`implement ⇒ explore ⇒ review` は可）
- 起動エントリで `check-delegate-chain.sh <task_type> <parent_task_type_chain>` を実行。該当すれば exit 4

## exit code

| code | 意味                                                         |
| ---- | ------------------------------------------------------------ |
| 0    | 成功                                                         |
| 2    | 引数エラー（usage）                                          |
| 3    | 前提条件不足（codex/npx/jq 不在、`npx md2idx` 実行不可など） |
| 4    | 委譲サイクル検出（同一種別の多段委譲）                       |
| 1    | その他の実行失敗                                             |
