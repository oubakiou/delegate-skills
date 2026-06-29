# delegate-x-research 設計

`delegate-x-research` は、x.com / X の調査を X 調査 capability を持つ子プロセスへ委譲する capability bridge である。delegate skill 共通のファイルプロトコル、段階読み取り、多段委譲、脅威モデルは [spec.md](spec.md) を参照する。現在の実装バックエンドは Grok CLI だが、skill 名と env 名は用途に合わせ、特定ベンダーへ固定しない。

## スコープ

- `task_type=xresearch`
- 既定モデルは `grok-4.3`
- モデル解決は `DELEGATE_X_RESEARCH_MODEL` → `grok-4.3`
- 現在の実行系は Grok CLI。Claude / Codex へフォールバックしない

## 使い分け

| タスク                                        | skill                 |
| --------------------------------------------- | --------------------- |
| x.com 投稿・スレッド・アカウント・反応の調査  | `delegate-x-research` |
| 通常の Web / repo 内ドキュメント / コード調査 | `delegate-explore`    |
| 生成・編集などコード変更を伴う作業            | `delegate-implement`  |

X の状態は削除、編集、非公開化、検索順位変動で変わるため、worker report には確認時刻、検索語、投稿URL、投稿日時を残す。根拠が弱い主張は Findings で断定せず、Limitations に不確実性を書く。

## 実行フロー

1. main は `prepare.sh xresearch DELEGATE_X_RESEARCH_MODEL grok-4.3 ...` で request/response を準備する
2. 現在は `delegate-x-research-grok.sh "$model" "$request_file" "$response_file"` が Grok CLI を起動する
3. Grok worker は request_file を段階読みし、X / web search を使って調査する
4. worker は Summary / Findings / Sources / Method / Limitations / Blockers の report を `npx md2idx | jq` で response_file に書く
5. main は `read-response.sh auto` で読み、必要に応じて index → section の段階読みに切り替える

## 環境変数

| Variable                        | Default              | Description                          |
| ------------------------------- | -------------------- | ------------------------------------ |
| `DELEGATE_X_RESEARCH_MODEL`     | `grok-4.3`           | X 調査 backend に渡すモデル          |
| `DELEGATE_WORK_DIR`             | mktemp default       | request/response/report/tmp の置き場 |
| `GROK_DELEGATE_SANDBOX`         | `danger-full-access` | Grok CLI の sandbox profile          |
| `GROK_DELEGATE_PERMISSION_MODE` | `bypassPermissions`  | Grok CLI の permission mode          |

## 失敗時

- `grok` CLI が見つからない場合は exit 3
- Grok が response_file を生成しない場合は exit 1
- X へのアクセス不可、ログイン不備、調査対象不足は worker report の Blockers に書き、status は `failed` または `needs_input` にする
