import {
  validateComposerDto,
  type ComposerDto,
  type ComposerSectionKind,
  type TwoCallContractFailure,
} from './two-call-contract.ts'
import { validateXFeedRichMarkdown, type XFeedOutputGuardFailure } from './output-contract.ts'
import { CurrentRunItemRegistry } from './current-run-item-registry.ts'

export interface DigestRenderSuccess {
  readonly ok: true
  readonly text: string
  readonly urls: readonly string[]
  readonly usedItemIds: readonly string[]
}

export type DigestRenderFailure = TwoCallContractFailure | XFeedOutputGuardFailure
export type DigestRenderResult = DigestRenderSuccess | DigestRenderFailure

const SECTION_ORDER: readonly ComposerSectionKind[] = ['highlight', 'timeline', 'wander', 'focus', 'source']
const SECTION_LABELS: Readonly<Record<ComposerSectionKind, string>> = {
  highlight: '⭐ 高优先级',
  timeline: '🌊 时间线',
  wander: '🔄 漫游发现',
  focus: '🎯 聚焦主题',
  source: '📌 来源补充',
}

/** Render validated Composer DTO data into one deterministic delivery artifact. */
export function renderDigest(value: unknown, registry: CurrentRunItemRegistry): DigestRenderResult {
  const validated = validateComposerDto(value, { itemIds: registry.modelAllowlist() })
  if (!validated.ok) return validated
  const dto: ComposerDto = validated.value
  const sections = new Map(dto.sections.map(section => [section.kind, section]))
  const lines = [`📦 X 洞察 ${dto.title}`, '']
  const urls: string[] = []
  const usedItemIds: string[] = []

  for (const kind of SECTION_ORDER) {
    const section = sections.get(kind)
    if (section === undefined) continue
    if (lines.length > 2) lines.push('')
    lines.push(SECTION_LABELS[kind])
    for (const item of section.items) {
      const current = registry.getByItemId(item.itemId)
      if (current === undefined) {
        return { ok: false, code: 'unknown-item-id', message: 'composer item is not in the current run registry' }
      }
      usedItemIds.push(item.itemId)
      urls.push(current.canonicalUrl)
      lines.push(`- ${item.summary} (${current.canonicalUrl})`)
    }
  }

  const text = lines.join('\n')
  const guarded = validateXFeedRichMarkdown(text, { preparedUrls: urls })
  if (!guarded.ok) return guarded
  return Object.freeze({
    ok: true,
    text: guarded.text,
    urls: Object.freeze([...guarded.urls]),
    usedItemIds: Object.freeze([...usedItemIds]),
  })
}
