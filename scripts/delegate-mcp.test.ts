import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const delegateMcpScript = path.join(repoRoot, 'shared', 'delegate-mcp.sh')

const makeWorkDir = (): string => {
  const tempRoot = path.join(repoRoot, '.temp')
  mkdirSync(tempRoot, { recursive: true })
  return mkdtempSync(path.join(tempRoot, 'delegate-mcp-test-'))
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", String.raw`'\''`)}'`

const runBash = (script: string, env: NodeJS.ProcessEnv = {}): string =>
  execFileSync('bash', ['-c', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })

const callFunction = (
  functionName: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {}
): string =>
  runBash(
    `set -euo pipefail; source ${shellQuote(delegateMcpScript)}; ${functionName} ${args
      .map(shellQuote)
      .join(' ')}`,
    env
  )

const parseJson = (content: string): unknown => JSON.parse(content)

const expectTomlContains = (toml: string, lines: string[]): void => {
  for (const line of lines) {
    expect(toml).toContain(line)
  }
}

describe('delegate-mcp.sh extraction', () => {
  it.each([['delegate_mcp_extract_claude_user'], ['delegate_mcp_extract_cursor_global']])(
    '%s returns an empty object for missing files and files without mcpServers',
    (functionName) => {
      const workDir = makeWorkDir()
      const missingPath = path.join(workDir, 'missing.json')
      expect(parseJson(callFunction(functionName, [missingPath]))).toEqual({})

      const withoutServersPath = path.join(workDir, 'without-servers.json')
      writeFileSync(withoutServersPath, JSON.stringify({ model: 'keep-out' }))
      expect(parseJson(callFunction(functionName, [withoutServersPath]))).toEqual({})
    }
  )

  it.each([['delegate_mcp_extract_claude_user'], ['delegate_mcp_extract_cursor_global']])(
    '%s extracts mcpServers without rewriting definitions',
    (functionName) => {
      const workDir = makeWorkDir()
      const configPath = path.join(workDir, 'config.json')
      const mcpServers = {
        remote: { url: 'https://example.test/mcp' },
        'server.with-dot': {
          args: ['server.js', 'TOKEN'],
          command: 'node',
          env: { API_TOKEN: 'secret' },
        },
      }

      writeFileSync(configPath, JSON.stringify({ mcpServers, other: true }))
      expect(parseJson(callFunction(functionName, [configPath]))).toEqual(mcpServers)
    }
  )

  it('extracts enabled Codex MCP servers through a fake CLI', () => {
    const workDir = makeWorkDir()
    const binDir = path.join(workDir, 'bin')
    mkdirSync(binDir, { recursive: true })
    const codexPath = path.join(binDir, 'codex')
    writeFileSync(
      codexPath,
      `#!/usr/bin/env node
const payload = [
  {
    name: 'stdio-server',
    enabled: true,
    transport: {
      type: 'stdio',
      command: 'node',
      args: ['/tmp/server.js', 'TOKEN'],
      env: { API_TOKEN: 'secret' },
      env_vars: [],
      cwd: null
    }
  },
  {
    name: 'disabled-server',
    enabled: false,
    transport: { type: 'stdio', command: 'node', args: ['disabled.js'], env: null }
  },
  {
    name: 'remote-server',
    enabled: true,
    transport: { type: 'http', url: 'https://example.test/mcp' }
  }
]
if (process.argv.slice(2).join(' ') !== 'mcp list --json') {
  process.exit(9)
}
console.log(JSON.stringify(payload))
`
    )
    chmodSync(codexPath, 0o755)

    expect(
      parseJson(
        callFunction('delegate_mcp_extract_codex_user', [path.join(workDir, 'codex-home')], {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
        })
      )
    ).toEqual({
      'remote-server': { url: 'https://example.test/mcp' },
      'stdio-server': {
        args: ['/tmp/server.js', 'TOKEN'],
        command: 'node',
        env: { API_TOKEN: 'secret' },
      },
    })
  })
})

describe('delegate-mcp.sh predicates and renderers', () => {
  it('checks whether canonical JSON contains servers', () => {
    expect(callFunction('delegate_mcp_has_servers', ['{"one":{}}']).trim()).toBe('')

    expect(() => callFunction('delegate_mcp_has_servers', ['{}'])).toThrow()
    expect(() => callFunction('delegate_mcp_has_servers', ['not json'])).toThrow()
  })

  it('renders Claude and Cursor JSON configs from canonical servers', () => {
    const canonical = JSON.stringify({
      local: { args: ['server.js'], command: 'node' },
      remote: { url: 'https://example.test/mcp' },
    })
    const expected = {
      mcpServers: {
        local: { args: ['server.js'], command: 'node' },
        remote: { url: 'https://example.test/mcp' },
      },
    }

    expect(parseJson(callFunction('delegate_mcp_render_claude_mcp_config', [canonical]))).toEqual(
      expected
    )
    expect(parseJson(callFunction('delegate_mcp_render_cursor_mcp_json', [canonical]))).toEqual(
      expected
    )
  })

  it('renders Codex TOML without carrying unrelated top-level keys', () => {
    const canonical = JSON.stringify({
      'dot.server-name': {
        args: [String.raw`C:\tools\server.js`, 'say "hi"'],
        command: 'node',
        env: {
          'TOKEN.NAME': 'abc"def',
          WINDOWS_PATH: 'C:\\tmp\\mcp',
        },
      },
      remote: {
        url: 'https://example.test/mcp?name="quoted"',
      },
    })

    const toml = callFunction('delegate_mcp_render_codex_toml', [canonical])

    expectTomlContains(toml, [
      '[mcp_servers."dot.server-name"]',
      'command = "node"',
      String.raw`args = ["C:\\tools\\server.js", "say \"hi\""]`,
      '[mcp_servers."dot.server-name".env]',
      String.raw`"TOKEN.NAME" = "abc\"def"`,
      String.raw`"WINDOWS_PATH" = "C:\\tmp\\mcp"`,
      '[mcp_servers."remote"]',
      String.raw`url = "https://example.test/mcp?name=\"quoted\""`,
    ])
    const topLevelLines = toml
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('[') && !line.includes(' = '))
    const nonMcpTables = toml
      .split('\n')
      .filter((line) => line.startsWith('[') && !line.startsWith('[mcp_servers.'))
    expect(topLevelLines).toEqual([])
    expect(nonMcpTables).toEqual([])
  })

  it('extracts Codex TOML server names from top-level mcp server tables', () => {
    const workDir = makeWorkDir()
    const configPath = path.join(workDir, 'config.toml')
    writeFileSync(
      configPath,
      [
        '[mcp_servers.simple]',
        'command = "simple"',
        '',
        '[mcp_servers."dot.server-name"]',
        'command = "quoted"',
        '',
        '[mcp_servers."dot.server-name".env]',
        '"TOKEN.NAME" = "secret"',
        '',
        '[mcp_servers.hyphen-name]',
        'url = "https://example.test/mcp"',
      ].join('\n')
    )

    expect(parseJson(callFunction('delegate_mcp_toml_server_names', [configPath]))).toEqual([
      'dot.server-name',
      'hyphen-name',
      'simple',
    ])
  })

  it('returns an empty server name list for missing Codex TOML', () => {
    const workDir = makeWorkDir()

    expect(
      parseJson(
        callFunction('delegate_mcp_toml_server_names', [path.join(workDir, 'missing.toml')])
      )
    ).toEqual([])
  })
})
