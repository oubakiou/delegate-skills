#!/usr/bin/env bash
set -euo pipefail

# 正本: shared/delegate-mcp.sh
# 各 delegate-* skill の scripts/delegate-mcp.sh は scripts/sync-shared.ts により
# この正本から自動生成されたコピー。編集は正本に対して行うこと。

delegate_mcp_extract_json_file() {
  local file_path="$1"

  if [ ! -s "$file_path" ]; then
    printf '{}\n'
    return 0
  fi

  jq -c 'if (.mcpServers | type) == "object" then .mcpServers else {} end' "$file_path" 2>/dev/null || printf '{}\n'
  return 0
}

delegate_mcp_extract_claude_user() {
  delegate_mcp_extract_json_file "$1"
}

delegate_mcp_extract_cursor_global() {
  delegate_mcp_extract_json_file "$1"
}

delegate_mcp_extract_codex_user() {
  local real_codex_home="$1"
  local output

  if ! output="$(CODEX_HOME="$real_codex_home" codex mcp list --json 2>/dev/null)"; then
    printf '{}\n'
    return 0
  fi

  printf '%s' "$output" | jq -c '
    def stdio_value:
      {command: .transport.command}
      + (if (.transport.args | type) == "array" and (.transport.args | length) > 0 then {args: .transport.args} else {} end)
      + (if ((.transport.env // {}) | type) == "object" and ((.transport.env // {}) | length) > 0 then {env: .transport.env} else {} end);
    def canonical_value:
      if (.transport.url? | type) == "string" then
        {url: .transport.url}
      elif .transport.type == "stdio" and (.transport.command | type) == "string" then
        stdio_value
      else
        null
      end;
    if type == "array" then
      map(select(.enabled != false and (.name | type) == "string") | {key: .name, value: canonical_value} | select(.value != null))
      | from_entries
    else
      {}
    end
  ' 2>/dev/null || printf '{}\n'
  return 0
}

delegate_mcp_has_servers() {
  local canonical_json="$1"

  printf '%s' "$canonical_json" | jq -e 'type == "object" and length > 0' >/dev/null 2>&1
}

delegate_mcp_render_claude_mcp_config() {
  local canonical_json="$1"

  printf '%s' "$canonical_json" | jq -c 'if type == "object" then {mcpServers: .} else {mcpServers: {}} end' 2>/dev/null || printf '{"mcpServers":{}}\n'
  return 0
}

delegate_mcp_render_cursor_mcp_json() {
  delegate_mcp_render_claude_mcp_config "$1"
}

delegate_mcp_render_codex_toml() {
  local canonical_json="$1"

  printf '%s' "$canonical_json" | jq -r '
    def quote: @json;
    def scalar_value:
      if type == "string" then quote
      else tostring | quote
      end;
    def string_array:
      map(scalar_value) | "[" + join(", ") + "]";
    if type == "object" then
      to_entries
      | map(select(.value | type == "object"))
      | map(
          .key as $name
          | .value as $server
          | ["[mcp_servers.\($name | quote)]"]
            + (if ($server.command? | type) == "string" then ["command = \($server.command | quote)"] else [] end)
            + (if ($server.args? | type) == "array" and ($server.args | length) > 0 then ["args = \($server.args | string_array)"] else [] end)
            + (if ($server.url? | type) == "string" then ["url = \($server.url | quote)"] else [] end)
            + (if ($server.env? | type) == "object" and ($server.env | length) > 0 then
                [""]
                + ["[mcp_servers.\($name | quote).env]"]
                + ($server.env | to_entries | map("\(.key | quote) = \(.value | scalar_value)"))
              else
                []
              end)
        )
      | map(join("\n"))
      | join("\n\n")
    else
      ""
    end
  ' 2>/dev/null || true
  return 0
}

delegate_mcp_toml_server_names() {
  local config_toml_path="$1"

  if [ ! -s "$config_toml_path" ]; then
    printf '[]\n'
    return 0
  fi

  jq -R -s -c '
    split("\n")
    | map(
        capture("^\\s*\\[mcp_servers\\.(?<name>(\"(?:\\\\.|[^\"])*\"|[A-Za-z0-9_-]+))\\]\\s*$")?
        | select(. != null)
        | .name
        | if startswith("\"") then (try fromjson catch empty) else . end
      )
    | unique
  ' "$config_toml_path" 2>/dev/null || printf '[]\n'
  return 0
}
