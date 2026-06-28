#!/usr/bin/env bash
set -euo pipefail

# 正本: shared/check-delegate-chain.sh
# 各 delegate-* skill の scripts/check-delegate-chain.sh は scripts/sync-shared.ts により
# この正本から自動生成されたコピー。編集は正本に対して行うこと。

# 多段委譲の再帰防止チェック（チェーン全体で同一種別禁止）
# Usage: check-delegate-chain.sh <task_type> <parent_task_type_chain_json>
#   <parent_task_type_chain_json>: 呼び出し元（親）の task_type_chain。top-level からの起動なら "[]"
# 判定: task_type が parent_task_type_chain に既にあれば exit 4（委譲サイクル）で fail-closed
# 成功時: 新しい task_type_chain（parent + [task_type]）を stdout に JSON で出力

if [ $# -lt 2 ]; then
  echo "Usage: $0 <task_type> <parent_task_type_chain_json>" >&2
  exit 2
fi

task_type="$1"
parent_task_type_chain="${2:-[]}"

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq が見つかりません。" >&2
  exit 3
fi

if printf '%s' "$parent_task_type_chain" | jq -e --arg t "$task_type" 'index($t) != null' >/dev/null; then
  echo "ERROR: 委譲チェーンに '$task_type' が既に存在します（同一種別の多段委譲は禁止）: $parent_task_type_chain" >&2
  exit 4
fi

printf '%s' "$parent_task_type_chain" | jq -c --arg t "$task_type" '. + [$t]'
