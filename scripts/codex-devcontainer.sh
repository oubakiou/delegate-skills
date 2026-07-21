#!/bin/sh
set -eu

if [ "${DELEGATE_DEVCONTAINER_BOUNDARY:-}" != "1" ]; then
  echo "codex-devcontainer: DELEGATE_DEVCONTAINER_BOUNDARY=1 is required; start this launcher inside the repository Dev Container." >&2
  exit 1
fi

if [ ! -e /.dockerenv ] && [ ! -e /run/.containerenv ]; then
  echo "codex-devcontainer: no container runtime marker found (expected /.dockerenv or /run/.containerenv); refusing full-access Codex." >&2
  exit 1
fi

if [ "${1:-}" = "--unattended" ]; then
  shift
  exec codex exec --dangerously-bypass-approvals-and-sandbox "$@"
fi

for arg in "$@"; do
  case "$arg" in
    --dangerously-bypass-approvals-and-sandbox | --dangerously-bypass-approvals-and-sandbox=* | \
      --yolo | --yolo=* | --full-auto | --full-auto=* | \
      --ask-for-approval | --ask-for-approval=* | -a | -a=* | -a?* | \
      --sandbox | --sandbox=* | -s | -s=* | -s?* | \
      --config | --config=* | -c | -c=* | -c?* | \
      --profile | --profile=* | -p | -p=* | -p?* | \
      --remote | --remote=* | --remote-auth-token-env | --remote-auth-token-env=*)
      echo "codex-devcontainer: normal mode does not allow policy override argument: $arg" >&2
      exit 1
      ;;
  esac
done

exec codex --sandbox danger-full-access --ask-for-approval on-request "$@"
