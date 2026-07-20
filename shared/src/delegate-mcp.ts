import { spawnSync } from 'node:child_process'
import { hasFileContent, isRecord, readFileOrEmpty } from './jq-compat.ts'

// bash 版 delegate-mcp.sh と同一契約。親環境の MCP 設定を canonical JSON
// （server 名 → {command,args,env} または {url}）へ抽出し、各 backend の
// 隔離 config 形式へ描画する。抽出失敗はすべて {} へ倒す（fail-soft）。

export type McpCanonical = Record<string, unknown>

const emptyCanonical = (): McpCanonical => ({})

export const mcpExtractJsonFile = (filePath: string): McpCanonical => {
  if (!hasFileContent(filePath)) {
    return emptyCanonical()
  }
  try {
    const parsed: unknown = JSON.parse(readFileOrEmpty(filePath))
    if (isRecord(parsed) && isRecord(parsed.mcpServers)) {
      return parsed.mcpServers
    }
    return emptyCanonical()
  } catch {
    return emptyCanonical()
  }
}

export const mcpExtractClaudeUser = (filePath: string): McpCanonical => mcpExtractJsonFile(filePath)

export const mcpExtractCursorGlobal = (filePath: string): McpCanonical =>
  mcpExtractJsonFile(filePath)

const codexStdioValue = (transport: Record<string, unknown>): Record<string, unknown> => {
  const value: Record<string, unknown> = { command: transport.command }
  if (Array.isArray(transport.args) && transport.args.length > 0) {
    value.args = transport.args
  }
  const env = transport.env ?? {}
  if (isRecord(env) && Object.keys(env).length > 0) {
    value.env = env
  }
  return value
}

const codexCanonicalValue = (transport: unknown): Record<string, unknown> | null => {
  if (!isRecord(transport)) {
    return null
  }
  if (typeof transport.url === 'string') {
    return { url: transport.url }
  }
  if (transport.type === 'stdio' && typeof transport.command === 'string') {
    return codexStdioValue(transport)
  }
  return null
}

const addCodexEntry = (canonical: McpCanonical, entry: unknown): void => {
  if (!isRecord(entry) || entry.enabled === false || typeof entry.name !== 'string') {
    return
  }
  const value = codexCanonicalValue(entry.transport)
  if (value !== null) {
    canonical[entry.name] = value
  }
}

const codexCanonicalFromList = (parsed: unknown): McpCanonical => {
  if (!Array.isArray(parsed)) {
    return emptyCanonical()
  }
  const canonical: McpCanonical = {}
  for (const entry of parsed) {
    addCodexEntry(canonical, entry)
  }
  return canonical
}

export const mcpExtractCodexUser = (realCodexHome: string): McpCanonical => {
  const listed = spawnSync('codex', ['mcp', 'list', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: realCodexHome },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (listed.status !== 0) {
    return emptyCanonical()
  }
  try {
    return codexCanonicalFromList(JSON.parse(listed.stdout ?? ''))
  } catch {
    return emptyCanonical()
  }
}

export const mcpHasServers = (canonical: McpCanonical): boolean => Object.keys(canonical).length > 0

export const mcpServerNames = (canonical: McpCanonical): string[] => Object.keys(canonical)

// jq -c の compact 出力と同じ 1 行 JSON + 改行
export const mcpRenderClaudeMcpConfig = (canonical: McpCanonical): string =>
  `${JSON.stringify({ mcpServers: canonical })}\n`

export const mcpRenderCursorMcpJson = (canonical: McpCanonical): string =>
  mcpRenderClaudeMcpConfig(canonical)

const tomlQuote = (value: unknown): string => {
  if (typeof value === 'string') {
    return JSON.stringify(value)
  }
  return JSON.stringify(String(value))
}

const tomlStringArray = (values: readonly unknown[]): string =>
  `[${values.map(tomlQuote).join(', ')}]`

const codexTomlEnvLines = (name: string, env: unknown): string[] => {
  if (!isRecord(env) || Object.keys(env).length === 0) {
    return []
  }
  const lines = ['', `[mcp_servers.${tomlQuote(name)}.env]`]
  for (const [key, value] of Object.entries(env)) {
    lines.push(`${tomlQuote(key)} = ${tomlQuote(value)}`)
  }
  return lines
}

const codexTomlServerLines = (name: string, server: Record<string, unknown>): string[] => {
  const lines = [`[mcp_servers.${tomlQuote(name)}]`]
  if (typeof server.command === 'string') {
    lines.push(`command = ${tomlQuote(server.command)}`)
  }
  if (Array.isArray(server.args) && server.args.length > 0) {
    lines.push(`args = ${tomlStringArray(server.args)}`)
  }
  if (typeof server.url === 'string') {
    lines.push(`url = ${tomlQuote(server.url)}`)
  }
  lines.push(...codexTomlEnvLines(name, server.env))
  return lines
}

export const mcpRenderCodexToml = (canonical: McpCanonical): string => {
  const blocks: string[] = []
  for (const [name, server] of Object.entries(canonical)) {
    if (isRecord(server)) {
      blocks.push(codexTomlServerLines(name, server).join('\n'))
    }
  }
  return blocks.join('\n\n')
}

const TOML_SERVER_HEADER = /^\s*\[mcp_servers\.(?<name>"(?:\\.|[^"])*"|[A-Za-z0-9_-]+)\]\s*$/

// bash 版 (try fromjson catch empty) と同じく壊れた quoted name は読み飛ばす
const parseQuotedTomlName = (raw: string): string | null => {
  try {
    return String(JSON.parse(raw))
  } catch {
    return null
  }
}

const tomlServerNameOf = (line: string): string | null => {
  const match = TOML_SERVER_HEADER.exec(line)
  if (match === null || typeof match.groups === 'undefined') {
    return null
  }
  const raw = match.groups.name
  if (typeof raw !== 'string') {
    return null
  }
  if (!raw.startsWith('"')) {
    return raw
  }
  return parseQuotedTomlName(raw)
}

export const mcpTomlServerNames = (configTomlPath: string): string[] => {
  if (!hasFileContent(configTomlPath)) {
    return []
  }
  const names = new Set<string>()
  for (const line of readFileOrEmpty(configTomlPath).split('\n')) {
    const name = tomlServerNameOf(line)
    if (name !== null) {
      names.add(name)
    }
  }
  return [...names].toSorted()
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  const { mkdirSync, writeFileSync } = await import('node:fs')

  const makeTempFile = (content: string): string => {
    mkdirSync('.temp', { recursive: true })
    const file = `.temp/delegate-mcp-test-${Math.random().toString(36).slice(2)}.json`
    writeFileSync(file, content)
    return file
  }

  describe('mcpExtractJsonFile', () => {
    it('extracts mcpServers and falls back to {} on missing or corrupt input', () => {
      const file = makeTempFile('{"mcpServers":{"notion":{"url":"https://mcp.example"}}}')
      expect(mcpExtractJsonFile(file)).toEqual({ notion: { url: 'https://mcp.example' } })
      expect(mcpExtractJsonFile('/nonexistent.json')).toEqual({})
      expect(mcpExtractJsonFile(makeTempFile('not json'))).toEqual({})
      expect(mcpExtractJsonFile(makeTempFile('{"mcpServers": []}'))).toEqual({})
    })
  })

  describe('mcpRenderCodexToml', () => {
    it('renders stdio and url servers with quoted names like the bash jq template', () => {
      const toml = mcpRenderCodexToml({
        notion: { command: 'npx', args: ['-y', 'notion-mcp'], env: { TOKEN: 'x' } },
        remote: { url: 'https://mcp.example' },
      })
      expect(toml).toContain('[mcp_servers."notion"]')
      expect(toml).toContain('command = "npx"')
      expect(toml).toContain('args = ["-y", "notion-mcp"]')
      expect(toml).toContain('[mcp_servers."notion".env]')
      expect(toml).toContain('"TOKEN" = "x"')
      expect(toml).toContain('url = "https://mcp.example"')
    })
  })

  describe('mcpTomlServerNames', () => {
    it('collects unique server names including quoted ones', () => {
      const file = makeTempFile(
        '[mcp_servers."notion"]\ncommand = "npx"\n\n[mcp_servers.plain]\nurl = "https://x"\n\n[mcp_servers."notion"]\n'
      )
      expect(mcpTomlServerNames(file)).toEqual(['notion', 'plain'])
      expect(mcpTomlServerNames('/nonexistent.toml')).toEqual([])
    })
  })

  describe('mcpHasServers', () => {
    it('mirrors the bash length > 0 check', () => {
      expect(mcpHasServers({})).toBe(false)
      expect(mcpHasServers({ notion: {} })).toBe(true)
    })
  })
}
