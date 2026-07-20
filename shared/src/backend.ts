// bash 版 observe-json.sh の delegate_observe_backend_from_model / _backend_for と同一契約。
// モデル名プレフィックスによる実行系分岐は決定論で、README の対応表が公開仕様。

export const backendFromModel = (model: string): string => {
  if (model.startsWith('gpt')) {
    return 'codex'
  }
  if (model.startsWith('swe') || model.startsWith('devin-')) {
    return 'devin'
  }
  if (model.startsWith('composer') || model.startsWith('cursor-')) {
    return 'cursor'
  }
  return 'claude'
}

export const backendFor = (taskType: string, model: string): string => {
  if (taskType === 'xresearch') {
    return 'grok'
  }
  if (taskType === 'imagegen') {
    return 'codex'
  }
  return backendFromModel(model)
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest
  describe('backendFromModel', () => {
    it('maps model name prefixes to backends like the bash case branch', () => {
      expect(backendFromModel('gpt-5.5@high')).toBe('codex')
      expect(backendFromModel('swe-1.7')).toBe('devin')
      expect(backendFromModel('devin-glm-5.2')).toBe('devin')
      expect(backendFromModel('composer-2.5')).toBe('cursor')
      expect(backendFromModel('cursor-grok-4.5')).toBe('cursor')
      expect(backendFromModel('haiku')).toBe('claude')
      expect(backendFromModel('')).toBe('claude')
    })
  })

  describe('backendFor', () => {
    it('pins xresearch to grok and imagegen to codex regardless of model', () => {
      expect(backendFor('xresearch', 'haiku')).toBe('grok')
      expect(backendFor('imagegen', 'haiku')).toBe('codex')
      expect(backendFor('chore', 'haiku')).toBe('claude')
      expect(backendFor('implement', 'gpt-5')).toBe('codex')
    })
  })
}
