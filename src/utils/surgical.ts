import type { NodeMeta } from './md2mind'

const FOLD_SUFFIX_RE = /\s*<!--\s*markmap:\s*fold\s*-->\s*$/i

function splitFold(line: string): { body: string; fold: string } {
  const m = line.match(FOLD_SUFFIX_RE)
  if (!m) return { body: line, fold: '' }
  return { body: line.slice(0, m.index), fold: m[0] }
}

function escapeNewlinesForListItem(text: string, indent: number): string {
  const continuation = ' '.repeat(indent + 2)
  const parts = text.split('\n')
  if (parts.length === 1) return parts[0]
  return parts
    .map((part, i) => (i === 0 ? part : continuation + part))
    .join('\\\n')
}

export function editNodeText(markdown: string, meta: NodeMeta, newText: string): string {
  if (meta.startLine < 0) {
    if (meta.kind !== 'root') return markdown
    const head = `# ${newText.split('\n')[0]}`
    const rest = markdown.trim()
    if (!rest) return head + '\n'
    return head + '\n\n' + rest + (rest.endsWith('\n') ? '' : '\n')
  }
  const lines = markdown.split('\n')
  const firstLine = lines[meta.startLine]
  if (firstLine === undefined) return markdown
  const bodyStart = meta.bodyStart ?? 0
  const prefix = firstLine.slice(0, bodyStart)
  const { fold } = splitFold(firstLine)
  const foldSuffix = fold ? ` ${fold.trim()}` : ''
  const indent = meta.indent ?? 0

  if (meta.kind === 'heading') {
    const replacement = newText.split('\n')[0]
    lines.splice(
      meta.startLine,
      meta.endLine - meta.startLine + 1,
      prefix + replacement + foldSuffix
    )
  } else {
    const formatted = escapeNewlinesForListItem(newText, indent)
    const newLines = formatted.split('\n')
    newLines[0] = prefix + newLines[0]
    newLines[newLines.length - 1] = newLines[newLines.length - 1] + foldSuffix
    lines.splice(meta.startLine, meta.endLine - meta.startLine + 1, ...newLines)
  }

  return lines.join('\n')
}

function escapeBody(text: string, indent: number): string {
  const cont = ' '.repeat(indent + 2)
  const parts = text.split('\n')
  if (parts.length === 1) return parts[0]
  return parts.map((p, i) => (i === 0 ? p : cont + p)).join('\\\n')
}

function inferChildFormat(
  parentMeta: NodeMeta,
  sibling?: NodeMeta
): { indent: number; marker: string } {
  if (sibling && sibling.kind !== 'block') {
    if (sibling.kind === 'heading') {
      const level = sibling.level ?? 2
      return { indent: sibling.indent ?? 0, marker: '#'.repeat(level) + ' ' }
    }
    return { indent: sibling.indent ?? 0, marker: sibling.marker ?? '- ' }
  }
  if (parentMeta.kind === 'heading') {
    const level = parentMeta.level ?? 1
    if (level >= 2) {
      return { indent: 0, marker: '- ' }
    }
    return { indent: 0, marker: '#'.repeat(level + 1) + ' ' }
  }
  if (parentMeta.kind === 'listItem') {
    return { indent: (parentMeta.indent ?? 0) + 2, marker: '- ' }
  }
  return { indent: 0, marker: '## ' }
}

export function insertChild(
  markdown: string,
  parentMeta: NodeMeta,
  parentBlockEnd: number,
  newText: string,
  parentExpanded: boolean,
  siblingMeta?: NodeMeta
): string {
  const lines = markdown.split('\n')
  const { indent, marker } = inferChildFormat(parentMeta, siblingMeta)
  const body = escapeBody(newText, indent)
  const newLines = body
    .split('\n')
    .map((p, i) => (i === 0 ? ' '.repeat(indent) + marker + p : p))
  const insertAt = Math.min(lines.length, parentBlockEnd + 1)
  const foldSuffix = !parentExpanded ? ' <!-- markmap: fold -->' : ''
  if (foldSuffix && parentMeta.startLine >= 0) {
    const head = lines[parentMeta.startLine]
    if (head && !/<!--\s*markmap:\s*fold\s*-->/.test(head)) {
      lines[parentMeta.startLine] = head + foldSuffix
    }
  }
  lines.splice(insertAt, 0, ...newLines)
  return lines.join('\n')
}

export function insertSibling(
  markdown: string,
  refMeta: NodeMeta,
  type: 'before' | 'after',
  newText: string,
  refBlockEnd?: number,
  parentMeta?: NodeMeta
): string {
  const lines = markdown.split('\n')
  let indent: number
  let marker: string
  if (refMeta.kind === 'block') {
    const fmt = inferChildFormat(parentMeta ?? { kind: 'root', startLine: -1, endLine: -1 })
    indent = fmt.indent
    marker = fmt.marker
  } else if (refMeta.kind === 'heading') {
    indent = refMeta.indent ?? 0
    marker = refMeta.marker ?? '## '
  } else {
    indent = refMeta.indent ?? 0
    marker = '- '
  }
  const body = escapeBody(newText, indent)
  const newLines = body
    .split('\n')
    .map((p, i) => (i === 0 ? ' '.repeat(indent) + marker + p : p))
  const insertAt =
    type === 'before' ? refMeta.startLine : (refBlockEnd ?? refMeta.endLine) + 1
  lines.splice(insertAt, 0, ...newLines)
  return lines.join('\n')
}

export function moveBlock(
  markdown: string,
  fromMeta: NodeMeta,
  newIndent: number,
  newMarker: string | null,
  insertBeforeLine: number
): string {
  const lines = markdown.split('\n')
  const blockLen = fromMeta.endLine - fromMeta.startLine + 1
  const block = lines.slice(fromMeta.startLine, fromMeta.endLine + 1)
  const indentDelta = newIndent - (fromMeta.indent ?? 0)
  const adjusted = block.map((line, i) => {
    if (i === 0 && newMarker) {
      const m = line.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/)
      if (m) return ' '.repeat(newIndent) + newMarker + m[2]
      const h = line.match(/^(\s*)(#{1,6})\s+(.*)$/)
      if (h) return ' '.repeat(newIndent) + newMarker + h[3]
    }
    if (indentDelta === 0) return line
    if (indentDelta > 0) return ' '.repeat(indentDelta) + line
    const stripped = line.replace(new RegExp(`^ {0,${-indentDelta}}`), '')
    return stripped
  })
  lines.splice(fromMeta.startLine, blockLen)
  const target = insertBeforeLine > fromMeta.startLine ? insertBeforeLine - blockLen : insertBeforeLine
  lines.splice(Math.max(0, target), 0, ...adjusted)
  return lines.join('\n')
}

export function removeNodes(markdown: string, metas: NodeMeta[]): string {
  const lines = markdown.split('\n')
  const sorted = [...metas]
    .filter((m) => m && m.kind !== 'root' && m.startLine >= 0 && m.endLine >= m.startLine)
    .sort((a, b) => b.startLine - a.startLine)
  for (const meta of sorted) {
    lines.splice(meta.startLine, meta.endLine - meta.startLine + 1)
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n') + '\n'
}

interface NodeLike {
  topic?: string
  children?: NodeLike[]
  expanded?: boolean
}

function renderSubtreeLines(
  node: NodeLike,
  parentMeta: NodeMeta,
  parentSiblingMeta: NodeMeta | undefined,
  out: string[]
): void {
  const { indent, marker } = (function () {
    if (parentSiblingMeta && parentSiblingMeta.kind !== 'block') {
      if (parentSiblingMeta.kind === 'heading') {
        const level = parentSiblingMeta.level ?? 2
        return { indent: parentSiblingMeta.indent ?? 0, marker: '#'.repeat(level) + ' ' }
      }
      return { indent: parentSiblingMeta.indent ?? 0, marker: parentSiblingMeta.marker ?? '- ' }
    }
    if (parentMeta.kind === 'heading') {
      const level = parentMeta.level ?? 1
      if (level >= 2) return { indent: 0, marker: '- ' }
      return { indent: 0, marker: '#'.repeat(level + 1) + ' ' }
    }
    if (parentMeta.kind === 'listItem') {
      return { indent: (parentMeta.indent ?? 0) + 2, marker: '- ' }
    }
    return { indent: 0, marker: '## ' }
  })()

  const text = node.topic || ' '
  const foldSuffix = node.expanded === false ? ' <!-- markmap: fold -->' : ''
  const lines = text.split('\n')
  if (lines.length === 1) {
    out.push(' '.repeat(indent) + marker + lines[0] + foldSuffix)
  } else {
    const continuation = ' '.repeat(indent + 2)
    out.push(' '.repeat(indent) + marker + lines[0] + '\\')
    for (let i = 1; i < lines.length - 1; i++) {
      out.push(continuation + lines[i] + '\\')
    }
    out.push(continuation + lines[lines.length - 1] + foldSuffix)
  }

  const selfMeta: NodeMeta = {
    kind: marker.trim().startsWith('#') ? 'heading' : 'listItem',
    level: marker.trim().startsWith('#') ? marker.trim().length : undefined,
    indent,
    marker,
    startLine: -1,
    endLine: -1,
  }
  for (const child of node.children ?? []) {
    renderSubtreeLines(child, selfMeta, undefined, out)
  }
}

export function insertSubtree(
  markdown: string,
  parentMeta: NodeMeta,
  parentBlockEnd: number,
  node: NodeLike,
  parentExpanded: boolean,
  siblingMeta?: NodeMeta
): string {
  const lines = markdown.split('\n')
  const out: string[] = []
  renderSubtreeLines(node, parentMeta, siblingMeta, out)
  const insertAt = Math.min(lines.length, parentBlockEnd + 1)
  if (!parentExpanded && parentMeta.startLine >= 0) {
    const head = lines[parentMeta.startLine]
    if (head && !/<!--\s*markmap:\s*fold\s*-->/.test(head)) {
      lines[parentMeta.startLine] = head + ' <!-- markmap: fold -->'
    }
  }
  lines.splice(insertAt, 0, ...out)
  return lines.join('\n')
}

export function setFold(markdown: string, meta: NodeMeta, fold: boolean): string {
  if (meta.kind === 'root' || meta.startLine < 0) return markdown
  const lines = markdown.split('\n')
  const line = lines[meta.startLine]
  if (line === undefined) return markdown
  const { body, fold: existing } = splitFold(line)
  const trimmed = body.replace(/\s+$/, '')
  if (fold) {
    if (existing) return markdown
    lines[meta.startLine] = `${trimmed} <!-- markmap: fold -->`
  } else {
    if (!existing) return markdown
    lines[meta.startLine] = trimmed
  }
  return lines.join('\n')
}
