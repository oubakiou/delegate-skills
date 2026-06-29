---
name: delegate-x-research
license: MIT
description: >
  x.com / X 上の投稿・アカウント・話題・反応を調査する作業を、X 調査 capability を持つ子プロセスへ委譲するスキル。
  ユーザーが X、x.com、Twitter、ポスト、スレッド、アカウント、ハッシュタグ、炎上、世論、直近の反応、
  コミュニティノート、投稿URLの確認などを調べたい場合に使う。main agent 側で X を直接確認できない、
  または最新投稿・検索結果・引用元確認を隔離したい場合に使う。現在のバックエンドは Grok CLI で、
  DELEGATE_X_RESEARCH_MODEL でモデルを切り替える。
  x.com 調査を委譲する場合は、この skill を使う。generic な subagent で代替しない。
allowed-tools: Bash(bash .claude/skills/delegate-x-research/scripts/prepare.sh:*), Bash(bash .claude/skills/delegate-x-research/scripts/resolve-model.sh:*), Bash(bash .claude/skills/delegate-x-research/scripts/delegate-x-research-grok.sh:*), Bash(bash .claude/skills/delegate-x-research/scripts/check-md2idx.sh:*), Bash(bash .claude/skills/delegate-x-research/scripts/check-delegate-chain.sh:*), Bash(bash .claude/skills/delegate-x-research/scripts/build-request.sh:*), Bash(bash .claude/skills/delegate-x-research/scripts/read-response.sh:*), Bash(npx md2idx:*), Bash(jq:*), Bash(mktemp:*), Bash(date:*), Read
---

# delegate-x-research

x.com / X の調査を、X 調査 capability を持つ子プロセスへ委譲する。task_type=`xresearch`、既定モデル `grok-build`。他 delegate と同じ request/response protocol v1 を使う。現在の実装バックエンドは Grok CLI で、`grok -p -m` へリクエストを渡す。

## スクリプトパス

- Claude Code: `skill_dir=.claude/skills/delegate-x-research`
- Codex: `skill_dir=.agents/skills/delegate-x-research`

以降のコマンド例は Claude Code の `.claude/skills/delegate-x-research` を使う。Codex で使う場合は、同じ相対構造の `.agents/skills/delegate-x-research` に読み替える。

## モデル価格参照

コスト分析・単価比較が必要な場合のみ、`<skill_dir>/model-token-prices.json` を読む。このデータは参照用であり、delegate の起動可否判定には使わない。

## 委譲する前に

この skill は、X 上の投稿・アカウント・スレッド・検索結果・直近の反応・コミュニティノートなど、Grok の X 調査能力を使う必要がある場合に使う。通常の Web ページ、リポジトリ内ドキュメント、コード調査だけで足りる場合は、main が直接処理するか `delegate-explore` を使う。

リクエストには、調査対象、期間、言語、地域、確認したい主張、必要な粒度、引用してよいソース種別を明記する。特に「最新」「今日」「昨日」などの相対日付は、request 作成時点の具体的な日付も併記する。

## 実行フロー

1. **準備**: Objective / Scope / Context / Acceptance criteria / Verification / Constraints の Markdown を stdin で渡す。exit 3=前提不足 / exit 4=委譲サイクルなら中止。
   - `out="$(printf '%s' "$req_md" | bash .claude/skills/delegate-x-research/scripts/prepare.sh xresearch DELEGATE_X_RESEARCH_MODEL grok-build "$PARENT_TASK_TYPE_CHAIN" "$REQUESTER_SESSION_ID")"`（top-level 起動なら `$PARENT_TASK_TYPE_CHAIN` は空でよい）
   - `model="$(printf '%s' "$out" | jq -r .model)"` / `request_file="$(printf '%s' "$out" | jq -r .request_file)"` / `response_file="$(printf '%s' "$out" | jq -r .response_file)"`
2. **調査実行**: 現在は `bash .claude/skills/delegate-x-research/scripts/delegate-x-research-grok.sh "$model" "$request_file" "$response_file"` で Grok CLI を起動する。
3. **レスポンス読み取り**: `bash .claude/skills/delegate-x-research/scripts/read-response.sh "$response_file" auto`。`auto` が大きな response と判定した場合は `... "$response_file" index` → Findings / Sources / Limitations / Blockers section（`... "$response_file" <N>`）の段階読みに切り替える。読了後、worker の本文を再要約しない。main のユーザー向け応答は、必要な結論と参照すべき section を短く示す。
4. **検証フェーズ**: 重要な主張について、Sources に投稿URL・アカウント・投稿日時・確認時刻が含まれるか確認する。根拠が弱い箇所や Grok 側のアクセス制限は Limitations / Blockers として扱い、断定しない。

## Worker report

worker の report Markdown は次の見出しを基本にする。

- `Summary`: 結論の短い要約
- `Findings`: 主な発見。事実、推測、未確認情報を分ける
- `Sources`: x.com URL、投稿者、投稿日時、確認時刻、関連検索語
- `Method`: 検索語、確認した範囲、除外した情報
- `Limitations`: 非公開投稿、削除済み投稿、検索結果の偏り、取得不能、時点依存
- `Blockers`: Grok CLI 不在、ログイン不備、X へのアクセス不可、入力不足

## 制約

- `DELEGATE_X_RESEARCH_MODEL` → `grok-build` の順でモデル解決する
- Grok CLI が指定モデルを公開しておらず `grok-build` が利用可能な場合は、実行時に `grok-build` へフォールバックする
- `GROK_DELEGATE_SANDBOX` が設定された場合のみ Grok CLI に `--sandbox` を渡す
- 現在の実行バックエンドは Grok CLI。将来別バックエンドに差し替える場合も、skill 名と env 名は X 調査という用途に合わせる
- x.com / X の調査に集中する。Web 一般やコード調査へ広がる場合は、request の Scope に必要な範囲だけを書く
- 直近情報は確認日時を明記し、削除・編集・非公開化で変わり得ることを Limitations に残す
- task_type_chain 内種別への再委譲はしない（別種別 delegate は可）
- main は worker の探索ログを echo / 再要約しない。必要な結論と参照 section だけを返す
