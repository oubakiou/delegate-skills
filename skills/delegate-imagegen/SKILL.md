---
name: delegate-imagegen
license: MIT
description: >
  画像生成 capability を持たない requester から、画像生成 capability を持つ Codex 子プロセスへ画像生成・画像編集作業を委譲するスキル。
  ユーザーが画像、イラスト、写真風ビジュアル、バナー、サムネイル、アイコン案、テクスチャ、モック画像などの生成や編集を求め、
  main agent 側で画像生成手段を直接使えない、またはプロンプト試行錯誤・生成パラメータ・失敗ログを隔離したい場合に使う。
  主目的は token cost 削減ではなく capability bridge と context isolation。DELEGATE_IMAGEGEN_MODEL で Codex モデルを切り替える。
allowed-tools: Bash(bash .claude/skills/delegate-imagegen/scripts/prepare-imagegen.sh:*), Bash(bash .claude/skills/delegate-imagegen/scripts/resolve-model.sh:*), Bash(bash .claude/skills/delegate-imagegen/scripts/delegate-imagegen-codex.sh:*), Bash(bash .claude/skills/delegate-imagegen/scripts/check-md2idx.sh:*), Bash(bash .claude/skills/delegate-imagegen/scripts/check-delegate-chain.sh:*), Bash(bash .claude/skills/delegate-imagegen/scripts/build-request.sh:*), Bash(bash .claude/skills/delegate-imagegen/scripts/read-response.sh:*), Bash(npx md2idx:*), Bash(jq:*), Bash(mktemp:*), Bash(date:*), Bash(test -f:*), Bash(ls:*), Bash(file:*), Read
---

# delegate-imagegen

画像生成・画像編集を Codex 子プロセスへ委譲する。task_type=`imagegen`、既定モデル `gpt-5`。他 delegate と同じモデル解決を使うが、画像生成 capability bridge のため実行系は `gpt*` → Codex のみに限定し、Claude パスは使わない。

## スクリプトパス

- Claude Code: `skill_dir=.claude/skills/delegate-imagegen`
- Codex: `skill_dir=.agents/skills/delegate-imagegen`

以降のコマンド例は Claude Code の `.claude/skills/delegate-imagegen` を使う。Codex で使う場合は、同じ相対構造の `.agents/skills/delegate-imagegen` に読み替える。

## 委譲する前に

この skill は、main agent が画像生成 capability を持たない場合、または画像生成に関する試行錯誤を worker 側へ隔離したい場合に使う。ユーザーが求める成果物が SVG / HTML / CSS / canvas / 既存デザインシステム内のコードで表現する方が適切なら、この skill ではなく通常の実装・編集として扱う。

ユーザーから出力先の明示がない場合、worker には `.temp/imagegen/` 配下へ保存させる。既存画像を編集する場合は、対象ファイルパス、保持すべき要素、変更点、許容されるスタイル変更を request に明記する。

## 実行フロー

1. **準備**: Objective / Scope / Context / Acceptance criteria / Verification / Constraints の Markdown を stdin で渡す。出力先指定がなければ Constraints に `.temp/imagegen/` を書く。exit 3=前提不足 / exit 4=委譲サイクルなら中止。
   - `out="$(printf '%s' "$req_md" | bash .claude/skills/delegate-imagegen/scripts/prepare-imagegen.sh "$PARENT_TASK_TYPE_CHAIN" "$REQUESTER_SESSION_ID")"`（top-level 起動なら `$PARENT_TASK_TYPE_CHAIN` は空でよい）
   - `model="$(printf '%s' "$out" | jq -r .model)"` / `request_file="$(printf '%s' "$out" | jq -r .request_file)"` / `response_file="$(printf '%s' "$out" | jq -r .response_file)"`
2. **実行系分岐**:
   - `model` が `gpt*`: `bash .claude/skills/delegate-imagegen/scripts/delegate-imagegen-codex.sh "$model" "$request_file" "$response_file"`
   - それ以外: 画像生成 capability bridge として扱えないため中止する
3. **レスポンス読み取り**: `bash .claude/skills/delegate-imagegen/scripts/read-response.sh "$response_file" auto`。`auto` が大きな response と判定した場合は `... "$response_file" index` → Generated files / Verification / Blockers section（`... "$response_file" <N>`）の段階読みに切り替える。読了後、worker の本文を再要約しない。main のユーザー向け応答は生成ファイル一覧と短い結果だけに留める。
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
- 出力先が明示されていなければ `.temp/imagegen/` 配下に保存する
- task_type_chain 内種別への再委譲はしない（別種別 delegate は可）
- main は worker の試行錯誤ログを echo / 再要約しない。生成ファイル一覧と短い結果だけを返す
