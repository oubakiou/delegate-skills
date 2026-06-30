#!/usr/bin/env bash
set -euo pipefail

# 正本: shared/resolve-model.sh
# 各 delegate-* skill の scripts/resolve-model.sh は scripts/sync-shared.ts により
# この正本から自動生成されたコピー。編集は正本に対して行うこと。

# モデル解決（共有スクリプト + skill 固有デフォルトの引数渡し）
# Usage: resolve-model.sh <種別env名> <skill固有デフォルト>
#   例: resolve-model.sh DELEGATE_IMPLEMENT_MODEL sonnet
# 解決順: $種別env → 引数デフォルト
# 出力: Claude エイリアス(sonnet|haiku|opus|fable) / gpt-* モデルID / swe-* モデルID / devin-* モデルID をそのまま echo
#   実行系の分岐（gpt* → Codex / swe*|devin* → Devin / それ以外 → claude -p）は呼び出し側が出力を見て行う
#   devin-* は delegate-devin.sh がプレフィックスを剥離して devin CLI に渡す（devin-glm-5.2 → glm-5.2）

if [ $# -lt 2 ]; then
  echo "Usage: $0 <TYPE_ENV_NAME> <DEFAULT_MODEL>" >&2
  exit 2
fi

type_env="$1"
default_model="$2"

# 間接展開で env を評価（未設定・空はデフォルトへフォールバック）
model="${!type_env:-$default_model}"

printf '%s\n' "$model"
