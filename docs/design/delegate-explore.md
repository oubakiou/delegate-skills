# delegate-explore 設計

コードベースとドキュメントの read-only な探索・読解を、最安モデルの subagent に委譲する skill の設計。

delegate skill 共通の仕組み（アーキテクチャ・モデル解決・実行系分岐・ファイルプロトコル・多段委譲・脅威モデル）は [spec.md](spec.md) を参照。本書は delegate-explore 固有の設計判断のみを扱う。

## 1. 位置づけ

- `task_type=explore` / 既定モデル `haiku`（最安）/ Claude パスは `delegate-claude.sh`（`claude -p` 子プロセス）
- read-only のコード調査を引き受ける。定義・参照・挙動の確認、関係箇所の特定、変更前の状況把握など
- 仕様書・README・設計資料などのドキュメント読解も対象にする。内容確認・要約・該当箇所特定を安く処理する
- explore の作業を委譲する場合は、この skill を使う。generic な subagent で代替しない

## 2. 他 skill との境界

| 作業の性質                   | 振り先               |
| ---------------------------- | -------------------- |
| read-only の調査・読解       | `delegate-explore`   |
| ファイル編集を伴う実装・修正 | `delegate-implement` |
| 差分の指摘出し               | `delegate-review`    |
| 上記いずれにも該当しない雑務 | `delegate-chore`     |

explore は「読むだけで答えが出る」作業に使う。調査の結果として編集が必要になった場合は implement に切り替え、差分に対する品質指摘が目的なら review を使う。
explore の作業を委譲する場合は、この skill の固定フローを使う。generic な subagent へ流す運用は想定しない。

## 3. 既定モデルとツール権限

- **既定モデル `haiku`**: explore は read 中心・低リスクで判断比重が小さいため最安モデルを既定にする（spec.md [§3 既定モデルの根拠](spec.md#既定モデルの根拠) と同方針）。`DELEGATE_EXPLORE_MODEL` で上書き可
- **Claude パス**: 編集を許さない read-only 調査が責務であり、Claude パスでは `delegate-claude.sh`（`claude -p` 子プロセス）で worker を起動する
- **制約**: ファイル編集・push はしない。実行系の sandbox 設定はプロトコル共通（spec.md [§5](spec.md#5-実行系の四分岐)）

## 4. 発火条件と段階読み取り

explore は読む量が大きいほど token cost 削減が効きやすい。複数ファイル・長めの設計資料・広い参照関係など、main が直接読むと context を膨らませる調査を発火条件にする。一方、単一の短いファイル確認、`rg` / `git grep` 一発で答えが出る調査、main が既に読んだ箇所の確認には使わず、main が直接処理する。

explore の成果物は、親エージェントが必要な分だけ読める形で返すことに価値がある。レスポンスは protocol v1 の `index` を先に読み、必要な section だけを後から取得する前提にする。これにより、調査対象の全文や長い根拠ログを main の context に流し込まずに済む。

## 5. 起動テンプレートと出力規律

delegate-chore で先行適用した worker 起動の固定テンプレ化（J1）と main の echo / 再要約禁止（J3）を explore にも適用する。worker への起動プロンプトは `<REQUEST_FILE>` / `<RESPONSE_FILE>` だけを差し替える固定ボイラープレートにし、タスク本体は request_file に置く。固定テンプレには read-only、根拠ファイル / 行の明示、main が読むべき最小 section の提示、編集・git 書き込み・push 禁止を含める。

worker の報告 Markdown は canonical 英語 section 名に固定する。`Summary` は必須で、必要に応じて `Findings`（根拠ファイル / 行）、`Verification`（実行コマンドと exit code）、`Blockers`、`Error` を使う。main は response 読了後に worker 本文を echo / 再要約せず、ユーザー向けには Summary を指す 1 行に留める。これにより main の orchestration 出力を増やさず、調査結果の詳細は response_file の段階読み取りに残す。

## 6. 探索対象の二面性

explore はコード調査とドキュメント読解を同じ read-only 枠で扱う。実装前に呼び出し関係を追う作業と、仕様書から該当要件を拾う作業はどちらも副作用がなく、安価な探索としてまとめて委譲できる。副作用がないため失敗時の巻き戻しも不要で、低リスクな前処理として使いやすい。

## 7. 共通事項への参照

- 実行フロー（前提条件チェック → モデル解決 → チェーン確認 → ファイル事前確保 → リクエスト作成 → 実行系分岐 → レスポンス読み取り）: [SKILL.md](../../skills/delegate-explore/SKILL.md)
- ファイルプロトコル v1: [protocol-v1.md](protocol-v1.md)
- 多段委譲ポリシー（`explore` がチェーンに二度登場するのを禁止）: spec.md [§8](spec.md#8-多段委譲ポリシー再帰防止)
- exit code / 環境変数 / 脅威モデル: spec.md [§10](spec.md#10-スクリプトと-exit-code) / [§12](spec.md#12-環境変数) / [§13](spec.md#13-脅威モデル割り切り)
