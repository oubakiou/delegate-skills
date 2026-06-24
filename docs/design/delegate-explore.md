# delegate-explore 設計

コードベースとドキュメントの read-only な探索・読解を、最安モデルの subagent に委譲する skill の設計。

delegate skill 共通の仕組み（アーキテクチャ・モデル解決・実行系分岐・ファイルプロトコル・多段委譲・脅威モデル）は [spec.md](spec.md) を参照。本書は delegate-explore 固有の設計判断のみを扱う。

## 1. 位置づけ

- `task_type=explore` / 既定モデル `haiku`（最安）/ Claude パスの `subagent_type=Explore`
- read-only のコード調査を引き受ける。定義・参照・挙動の確認、関係箇所の特定、変更前の状況把握など
- 仕様書・README・設計資料などのドキュメント読解も対象にする。内容確認・要約・該当箇所特定を安く処理する

## 2. 他 skill との境界

| 作業の性質                   | 振り先               |
| ---------------------------- | -------------------- |
| read-only の調査・読解       | `delegate-explore`   |
| ファイル編集を伴う実装・修正 | `delegate-implement` |
| git / gh 操作（push・PR）    | `delegate-git`       |
| 差分の指摘出し               | `delegate-review`    |
| 上記いずれにも該当しない雑務 | `delegate-chore`     |

explore は「読むだけで答えが出る」作業に使う。調査の結果として編集が必要になった場合は implement に切り替え、差分に対する品質指摘が目的なら review を使う。

## 3. 既定モデルとツール権限

- **既定モデル `haiku`**: explore は read 中心・低リスクで判断比重が小さいため最安モデルを既定にする（spec.md [§3 既定モデルの根拠](spec.md#既定モデルの根拠) と同方針）。`DELEGATE_EXPLORE_MODEL` で上書き可
- **`subagent_type=Explore`**: 編集を許さない read-only 調査が責務であり、Claude パスでは専用の探索エージェントを使う
- **制約**: ファイル編集・push はしない。実行系の sandbox 設定はプロトコル共通（spec.md [§5](spec.md#5-実行系の二分岐)）

## 4. 段階読み取りと探索の二面性

explore の成果物は、親エージェントが必要な分だけ読める形で返すことに価値がある。レスポンスは protocol v1 の `index` を先に読み、必要な section だけを後から取得する前提にする。これにより、調査対象の全文や長い根拠ログを main の context に流し込まずに済む。

もう一つの役割は、コード調査とドキュメント読解を同じ read-only 枠で扱うこと。実装前に呼び出し関係を追う作業と、仕様書から該当要件を拾う作業はどちらも副作用がなく、安価な探索としてまとめて委譲できる。副作用がないため失敗時の巻き戻しも不要で、低リスクな前処理として使いやすい。

## 5. 共通事項への参照

- 実行フロー（前提条件チェック → モデル解決 → チェーン確認 → ファイル事前確保 → リクエスト作成 → 実行系分岐 → レスポンス読み取り）: [SKILL.md](../../skills/delegate-explore/SKILL.md)
- ファイルプロトコル v1: [protocol-v1.md](protocol-v1.md)
- 多段委譲ポリシー（`explore` がチェーンに二度登場するのを禁止）: spec.md [§7](spec.md#7-多段委譲ポリシー再帰防止)
- exit code / 環境変数 / 脅威モデル: spec.md [§9](spec.md#9-スクリプトと-exit-code) / [§11](spec.md#11-環境変数) / [§12](spec.md#12-脅威モデル割り切り)
