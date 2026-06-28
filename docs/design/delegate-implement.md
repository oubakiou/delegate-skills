# delegate-implement 設計

ファイル編集を伴う実装・修正を、編集判断に向いた subagent に委譲する skill の設計。

delegate skill 共通の仕組み（アーキテクチャ・モデル解決・実行系分岐・ファイルプロトコル・多段委譲・脅威モデル）は [spec.md](spec.md) を参照。本書は delegate-implement 固有の設計判断のみを扱う。

## 1. 位置づけ

- `task_type=implement` / 既定モデル `sonnet` / Claude パスは `delegate-claude.sh`（`claude -p` 子プロセス）
- ファイル編集を伴う機能追加・バグ修正・リファクタなどを引き受ける。粒度は 1 コミットに収まる単位を想定する
- 調査だけなら explore、push・PR などの git / gh 操作は親エージェントが直接扱う

## 2. 他 skill との境界

| 作業の性質                   | 振り先               |
| ---------------------------- | -------------------- |
| read-only の調査・読解       | `delegate-explore`   |
| ファイル編集を伴う実装・修正 | `delegate-implement` |
| 差分の指摘出し               | `delegate-review`    |
| 上記いずれにも該当しない雑務 | `delegate-chore`     |

implement は「編集によって成果物を変える」作業に使う。機械的な整形だけなら chore で足りる場合があるが、設計判断・テスト調整・周辺影響の確認を伴うなら implement を選ぶ。

## 3. 既定モデルとツール権限

- **既定モデル `sonnet`**: implement は編集の設計判断を要するため、read 中心の作業より判断力のあるモデルを既定にする（spec.md [§3 既定モデルの根拠](spec.md#既定モデルの根拠) と同方針）。`DELEGATE_IMPLEMENT_MODEL` で上書き可
- **Claude パス**: Edit / Write / Bash による実作業と検証コマンド実行を伴うため、`delegate-claude.sh`（`claude -p` 子プロセス）で worker を起動する
- **制約**: 編集は可、ただし **push はしない**（push・PR は親エージェントが直接扱う）。実行系の sandbox 設定はプロトコル共通（spec.md [§5](spec.md#5-実行系の二分岐)）

## 4. 発火条件

implement は、調査・編集・検証を worker にまとめて任せる価値がある規模の実装を発火条件にする。複数ファイルにまたがる変更、既存パターン調査を伴う変更、worker が検証コマンドまで実行でき、main が `git diff` / Verification / Summary の確認に集中できる変更が対象。

一方、単一ファイルの小変更、明確な一括置換、main が既に読んだ箇所の数行修正、設計判断が未確定な実装は委譲しない。小さすぎる作業は委譲オーバーヘッドが勝ちやすく、設計判断が未確定な作業は worker に渡す前に main が方針を決める必要がある。

## 5. 実装と自己検証

implement の中核責務は、編集だけでなく worker 自身が決定論的な検証を実行して結果を返すこと。リクエストの Verification には `vp check` やテストなど、worker が実行すべきコマンドを明記し、レスポンスの Verification section には実行コマンドと exit code を収める。Changed files section も必須にし、main が差分確認の入口を安く取れるようにする。

親エージェントはまず `status` と `index` を読み、必要に応じて Summary / Verification / Changed files を確認する。lint・型チェック・テストの exit code は決定論的な事実として扱い、受け入れ基準や意味的な妥当性は Summary と差分を中心に確認する。この分担により、spec.md の脅威モデルに沿って、子の説明を鵜呑みにせず、検証可能な結果と判断が必要な結果を分けて扱える。

## 6. 起動テンプレートと出力規律

delegate-chore で先行適用した worker 起動の固定テンプレ化（J1）と main の echo / 再要約禁止（J3）を implement にも適用する。worker への起動プロンプトは `<REQUEST_FILE>` / `<RESPONSE_FILE>` だけを差し替える固定ボイラープレートにし、タスク本体は request_file に置く。固定テンプレには Changed files / Verification section 必須、実行コマンドと exit code、push 禁止、main が `git diff` や test result を裏取りする条件を含める。

worker の報告 Markdown は canonical 英語 section 名に固定する。`Summary` / `Changed files` / `Verification` は必須で、必要に応じて `Findings`、`Blockers`、`Error` を使う。main は response 読了後に worker 本文を echo / 再要約せず、ユーザー向けには Summary を指す 1 行に留める。これにより main の orchestration 出力を増やさず、詳細は response_file の段階読み取りと `git diff` / test result の裏取りに残す。

## 7. 共通事項への参照

- 実行フロー（前提条件チェック → モデル解決 → チェーン確認 → ファイル事前確保 → リクエスト作成 → 実行系分岐 → レスポンス読み取り）: [SKILL.md](../../skills/delegate-implement/SKILL.md)
- ファイルプロトコル v1: [protocol-v1.md](protocol-v1.md)
- 多段委譲ポリシー（`implement` がチェーンに二度登場するのを禁止）: spec.md [§7](spec.md#7-多段委譲ポリシー再帰防止)
- exit code / 環境変数 / 脅威モデル: spec.md [§9](spec.md#9-スクリプトと-exit-code) / [§11](spec.md#11-環境変数) / [§12](spec.md#12-脅威モデル割り切り)
