import type { NodeObj } from 'mind-elixir'
import type { NodeMeta } from './md2mind'

function nodeText(node: NodeObj): string {
  if (node.topic) return node.topic
  if (node.dangerouslySetInnerHTML) {
    const normalized = node.dangerouslySetInnerHTML.replace(/<br\s*\/?>/gi, '\n')
    const tmp = document.createElement('div')
    tmp.innerHTML = normalized
    return tmp.textContent?.trim() ?? ''
  }
  return ''
}

function foldSuffix(node: NodeObj): string {
  return node.expanded === false ? ' <!-- markmap: fold -->' : ''
}

function renderHeading(text: string, level: number, fold: string, lines: string[]): void {
  if (lines.length) lines.push('')
  const prefix = '#'.repeat(Math.max(1, Math.min(6, level)))
  const textLines = text.split('\n')
  lines.push(`${prefix} ${textLines[0]}${fold}`)
  for (let i = 1; i < textLines.length; i++) lines.push(textLines[i])
}

function renderListItem(text: string, listDepth: number, fold: string, lines: string[]): void {
  const indent = '  '.repeat(listDepth)
  const continuation = '  '.repeat(listDepth + 1)
  const textLines = text.split('\n')
  if (textLines.length === 1) {
    lines.push(`${indent}- ${textLines[0]}${fold}`)
    return
  }
  lines.push(`${indent}- ${textLines[0]}\\`)
  for (let i = 1; i < textLines.length - 1; i++) lines.push(`${continuation}${textLines[i]}\\`)
  lines.push(`${continuation}${textLines[textLines.length - 1]}${fold}`)
}

interface RenderCtx {
  parentKind: 'root' | 'heading' | 'listItem'
  parentLevel: number
  listDepth: number
}

function renderNode(node: NodeObj, ctx: RenderCtx, lines: string[]): void {
  const text = nodeText(node) || ' '
  const fold = foldSuffix(node)
  const meta = node.metadata as NodeMeta | undefined
  let kind: 'heading' | 'listItem'
  let level = ctx.parentLevel + 1
  let listDepth = ctx.listDepth
  if (meta?.kind === 'heading') {
    kind = 'heading'
    level = meta.level ?? level
  } else if (meta?.kind === 'listItem') {
    kind = 'listItem'
    listDepth = ctx.parentKind === 'listItem' ? ctx.listDepth + 1 : 0
  } else if (ctx.parentKind === 'listItem') {
    kind = 'listItem'
    listDepth = ctx.listDepth + 1
  } else if (ctx.parentKind === 'heading' && level <= 6) {
    kind = 'heading'
  } else {
    kind = 'listItem'
    listDepth = 0
  }
  if (kind === 'heading') {
    renderHeading(text, level, fold, lines)
  } else {
    renderListItem(text, listDepth, fold, lines)
  }
  const nextCtx: RenderCtx = {
    parentKind: kind,
    parentLevel: level,
    listDepth,
  }
  for (const child of node.children ?? []) renderNode(child, nextCtx, lines)
}

export function mindToMarkdown(root: NodeObj, frontmatter?: string): string {
  const lines: string[] = []
  if (frontmatter) {
    lines.push(frontmatter.trimEnd())
    lines.push('')
  }
  const text = nodeText(root)
  if (text && text !== ' ') {
    lines.push(`# ${text}${foldSuffix(root)}`)
  }
  const ctx: RenderCtx = { parentKind: 'heading', parentLevel: 1, listDepth: 0 }
  for (const child of root.children ?? []) renderNode(child, ctx, lines)
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}
