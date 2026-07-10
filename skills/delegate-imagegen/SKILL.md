---
name: delegate-imagegen
license: MIT
description: >
  画像生成 capability を持たない requester から、画像生成 capability を持つ Codex 子プロセスへ画像生成・画像編集作業を委譲するスキル。
  ユーザーが画像、イラスト、写真風ビジュアル、バナー、サムネイル、アイコン案、テクスチャ、モック画像などの生成や編集を求め、
  main agent 側で画像生成手段を直接使えない、またはプロンプト試行錯誤・生成パラメータ・失敗ログを隔離したい場合に使う。
  主目的は token cost 削減ではなく capability bridge と context isolation。DELEGATE_IMAGEGEN_MODEL で Codex モデルを切り替える。
  imagegen の作業を委譲する場合は、この skill を使う。generic な subagent で代替しない。
allowed-tools: Bash(bash .claude/skills/delegate-imagegen/scripts/prepare-imagegen.sh:*), Bash(bash .claude/skills/delegate-imagegen/scripts/delegate-imagegen-codex.sh:*), Bash(bash .claude/skills/delegate-imagegen/scripts/read-response.sh:*), Bash(jq:*), Bash(test -f:*), Bash(ls:*), Bash(file:*), Read
---

# delegate-imagegen

画像生成・画像編集を Codex 子プロセスへ委譲する。task_type=`imagegen`、既定モデル `gpt-5`。他 delegate と同じモデル解決を使うが、画像生成 capability bridge のため実行系は `gpt*` → Codex のみに限定し、Claude パスは使わない。

## スクリプトパス

- Claude Code: `skill_dir=.claude/skills/delegate-imagegen`
- Codex: `skill_dir=.agents/skills/delegate-imagegen`

以降のコマンド例は Claude Code の `.claude/skills/delegate-imagegen` を使う。Codex で使う場合は、同じ相対構造の `.agents/skills/delegate-imagegen` に読み替える。

## モデル価格参照

コスト分析・単価比較が必要な場合のみ、`<skill_dir>/model-token-prices.json` を読む。このデータは参照用であり、delegate の起動可否判定には使わない。

## 委譲する前に

この skill は、main agent が画像生成 capability を持たない場合、または画像生成に関する試行錯誤を worker 側へ隔離したい場合に使う。ユーザーが求める成果物が SVG / HTML / CSS / canvas / 既存デザインシステム内のコードで表現する方が適切なら、この skill ではなく通常の実装・編集として扱う。

ユーザーから出力先の明示がない場合、worker には `DELEGATE_IMAGEGEN_OUTPUT_DIR` の既定出力先へ保存させる。既存画像を編集する場合は、対象ファイルパス、保持すべき要素、変更点、許容されるスタイル変更を request に明記する。

## 実行フロー

1. **準備**: Objective / Scope / Context / Acceptance criteria / Verification / Constraints の Markdown を stdin で渡す。出力先指定がなければ Constraints に `DELEGATE_IMAGEGEN_OUTPUT_DIR` の既定出力先を使う旨を書く。exit 3=前提不足 / exit 4=委譲サイクルなら中止。
   - `out="$(printf '%s' "$req_md" | bash .claude/skills/delegate-imagegen/scripts/prepare-imagegen.sh "$PARENT_TASK_TYPE_CHAIN" "$REQUESTER_SESSION_ID")"`（top-level 起動なら `$PARENT_TASK_TYPE_CHAIN` は空でよい）
   - `model="$(printf '%s' "$out" | jq -r .model)"` / `request_file="$(printf '%s' "$out" | jq -r .request_file)"` / `response_file="$(printf '%s' "$out" | jq -r .response_file)"` / `run_dir="$(printf '%s' "$out" | jq -r .run_dir)"` / `observe_file="$(printf '%s' "$out" | jq -r .observe_file)"`
2. **実行系分岐**:
   - `model` が `gpt*`: `bash .claude/skills/delegate-imagegen/scripts/delegate-imagegen-codex.sh "$model" "$request_file" "$response_file" "$run_dir" "$observe_file"`。非対話モードの親（`claude -p` 等）では子プロセス起動を必ずフォアグラウンドで実行し、委譲所要時間より長い Bash timeout（Claude Code なら `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` または Bash tool の timeout 引数）を設定する。実行中の通常監視は `observe_file` から `state.phase` / `state.started_at` / `heartbeat.ts` / `heartbeat.stdout_bytes` / `heartbeat.stderr_bytes` / `heartbeat.last_stream_change_at` だけを `jq` で読む。`state.phase` は `prepared | running | superseded | stalled | ended`。`prepared` / `superseded` は dispatch されなかった observe（`state.started_at == null`、`usage` は未設定で jq では null 相当）なので、usage を集計する場合は分母から除外する。
   - それ以外: 画像生成 capability bridge として扱えないため中止する
3. **レスポンス読み取り**: `bash .claude/skills/delegate-imagegen/scripts/read-response.sh "$response_file" auto`。`auto` が大きな response と判定した場合は status + index + Summary section を返すので、Generated files / Verification / Blockers など必要 section だけ `... "$response_file" <N>` で追加取得する。読了後、worker の本文を再要約しない。main のユーザー向け応答は生成ファイル一覧と短い結果だけに留める。
4. **検証フェーズ**: `Generated files` のパスが存在することを main 側で確認する。必要に応じて画像ファイルを開いて、Acceptance criteria と明らかに矛盾しないか確認する。

## Worker report

worker の report Markdown は次の見出しを基本にする。

- `Summary`: 生成・編集結果の短い説明
- `Generated files`: 作成・更新した画像ファイルのパス
- `Parameters`: 使用したプロンプト、サイズ、枚数、参照画像、重要な生成条件
- `Verification`: ファイル存在確認、目視確認、失敗時の再試行内容
- `Blockers`: 生成不能・入力不足・安全上の制約・ツール不在

## 制約

- `DELEGATE_IMAGEGEN_MODEL` → `gpt-5` の順でモデル解決する
- Codex 限定で起動する。`gpt*` 以外に解決された場合は Claude パスへ落とさず中止する
- ユーザーに画像生成モデル選択を求めない。必要な場合は環境変数で運用側が切り替える
- 出力先が明示されていなければ `DELEGATE_IMAGEGEN_OUTPUT_DIR` の既定出力先に保存する
- task_type_chain 内種別への再委譲はしない（別種別 delegate は可）
- main は worker の試行錯誤ログを echo / 再要約しない。生成ファイル一覧と短い結果だけを返す
