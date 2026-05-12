import { Transformer } from 'markmap-lib'
import {
  pluginFrontmatter,
  pluginCheckbox,
  pluginHljs,
  pluginNpmUrl,
  pluginSourceLines,
} from 'markmap-lib/plugins'
import type { IPureNode } from 'markmap-common'
import type { NodeObj } from 'mind-elixir'

// Exclude pluginKatex; include pluginSourceLines for line ranges
const transformer = new Transformer([
  pluginFrontmatter,
  pluginHljs,
  pluginNpmUrl,
  pluginCheckbox,
  pluginSourceLines,
])

let idCounter = 0
function nextId(): string {
  idCounter += 1
  return `n${Date.now().toString(36)}${idCounter}`
}

function htmlToText(html: string): string {
  const normalized = html.replace(/<br\s*\/?>/gi, '\n')
  const tmp = document.createElement('div')
  tmp.innerHTML = normalized
  return tmp.textContent?.trim() ?? ''
}

function openLinksInNewTab(html: string): string {
  return html.replace(/<a\b([^>]*)>/gi, (match, attrs: string) => {
    if (/\btarget\s*=/i.test(attrs)) return match
    return `<a${attrs} target="_blank" rel="noopener noreferrer">`
  })
}

export type NodeKind = 'root' | 'heading' | 'listItem' | 'block'

export interface NodeMeta {
  kind: NodeKind
  level?: number
  startLine: number
  endLine: number
  bodyStart?: number
  marker?: string
  indent?: number
  fold?: boolean
  rawBody?: string
}

interface NodePayload {
  tag?: string
  fold?: number
  lines?: string
  listIndex?: number
}

function parseLines(lines: string | undefined): [number, number] {
  if (!lines) return [-1, -1]
  const [a, b] = lines.split(',').map((s) => parseInt(s, 10))
  return [Number.isFinite(a) ? a : -1, Number.isFinite(b) ? b : -1]
}

function metaFromPayload(payload: NodePayload | undefined, rawMd: string[]): NodeMeta {
  const tag = (payload?.tag ?? '').toLowerCase()
  const [startLine, endLine] = parseLines(payload?.lines)
  const fold = payload?.fold === 1 || payload?.fold === 2
  let kind: NodeKind = 'block'
  let level: number | undefined
  if (/^h[1-6]$/.test(tag)) {
    kind = 'heading'
    level = Number(tag[1])
  } else if (tag === 'li') {
    kind = 'listItem'
  }
  const firstLine = startLine >= 0 ? rawMd[startLine] ?? '' : ''
  let bodyStart = 0
  let marker = ''
  let indent = 0
  if (kind === 'heading') {
    const m = firstLine.match(/^(\s*)(#{1,6})\s+/)
    if (m) {
      indent = m[1].length
      marker = m[2] + ' '
      bodyStart = m[0].length
    }
  } else {
    const m = firstLine.match(/^(\s*)([-*+]|\d+[.)])\s+/)
    if (m) {
      indent = m[1].length
      marker = m[2] + ' '
      bodyStart = m[0].length
    }
  }
  const rawBody = firstLine.slice(bodyStart).replace(/\s*<!--\s*markmap:\s*fold\s*-->\s*$/i, '')
  return {
    kind,
    level,
    startLine,
    endLine: endLine - 1,
    bodyStart,
    marker,
    indent,
    fold,
    rawBody,
  }
}

function toNodeObj(node: IPureNode, rawMd: string[]): NodeObj {
  const payload = (node as IPureNode & { payload?: NodePayload }).payload
  const meta = metaFromPayload(payload, rawMd)
  const topic = meta.rawBody || htmlToText(node.content || '') || ' '
  const obj: NodeObj = {
    id: nextId(),
    topic,
    metadata: meta,
  }
  if (meta.fold) {
    obj.expanded = false
  }
  return obj
}

export interface MindData {
  nodeData: NodeObj
}

function buildChildren(parent: IPureNode, parentObj: NodeObj, rawMd: string[]) {
  const children = parent.children ?? []
  if (!children.length) return
  parentObj.children = []
  for (const child of children) {
    const obj = toNodeObj(child, rawMd)
    parentObj.children.push(obj)
    buildChildren(child, obj, rawMd)
  }
}

export function markdownToMind(markdown: string): MindData {
  const { root, frontmatterInfo } = transformer.transform(markdown || '# ')
  const rawMd = markdown.split('\n')
  const rootObj: NodeObj = toNodeObj(root, rawMd)
  const meta = rootObj.metadata as NodeMeta
  if (meta.kind === 'block' || meta.startLine < 0) {
    meta.kind = 'root'
  }
  if (frontmatterInfo) {
    ;(rootObj.metadata as NodeMeta & { frontmatter?: string }).frontmatter = markdown
      .split('\n')
      .slice(0, frontmatterInfo.lines)
      .join('\n')
  }
  buildChildren(root, rootObj, rawMd)
  return { nodeData: rootObj }
}
