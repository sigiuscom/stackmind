<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import MindElixir from 'mind-elixir'
import type { MindElixirInstance, NodeObj } from 'mind-elixir'
import MarkdownIt from 'markdown-it'
import 'mind-elixir/style'
import { useDocumentStore } from '@/stores/document'
import { markdownToMind } from '@/utils/md2mind'
import type { NodeMeta } from '@/utils/md2mind'
import { mindToMarkdown } from '@/utils/mind2md'
import {
  editNodeText,
  insertChild,
  insertParent as insertParentMd,
  insertSibling,
  insertSubtree,
  moveBlock,
  removeNodes,
  setFold,
} from '@/utils/surgical'

const store = useDocumentStore()
const host = ref<HTMLDivElement | null>(null)
let mind: MindElixirInstance | null = null
let lastInternalMarkdown: string | null = null
let freshNodeId: string | null = null
let creatingNode: false | 'addChild' | 'insertSibling' | 'insertParent' = false
const lastChildMap = new Map<string, string>()
const inlineRenderer = new MarkdownIt({ html: true, breaks: true })
let refreshTimer: number | null = null
let resizeObserver: ResizeObserver | null = null
let recenterTimer: number | null = null

function scheduleRefresh() {
  if (refreshTimer) window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null
    if (!mind) return
    const data = markdownToMind(store.markdown)
    mind.refresh(data)
    const line = store.cursorLine
    if (line >= 0) {
      const target = findNodeByLine(mind.nodeData, line)
      if (target) {
        try {
          const el = MindElixir.E(target.id)
          if (el) mind.selectNode(el)
        } catch {
          /* hidden */
        }
      }
    }
  }, 200)
}

function fitToView() {
  if (!mind) return
  const { map, container, nodes } = mind
  map.style.transformOrigin = '0 0'
  map.style.transform = 'translate3d(0px, 0px, 0) scale(1)'
  mind.scaleVal = 1
  void map.offsetWidth
  const cRect = container.getBoundingClientRect()
  const nRect = nodes.getBoundingClientRect()
  const cw = cRect.width
  const ch = cRect.height
  const nw = nRect.width
  const nh = nRect.height
  if (cw === 0 || ch === 0 || nw === 0 || nh === 0) return
  const padding = 0.9
  const scale = Math.min(1, Math.min(cw / nw, ch / nh) * padding)
  const nLeftRel = nRect.left - cRect.left
  const nTopRel = nRect.top - cRect.top
  const dx = cw / 2 - (nLeftRel + nw / 2) * scale
  const dy = ch / 2 - (nTopRel + nh / 2) * scale
  map.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${scale})`
  mind.scaleVal = scale
  mind.bus.fire('scale', scale)
}

function scheduleRecenter() {
  if (recenterTimer) window.clearTimeout(recenterTimer)
  recenterTimer = window.setTimeout(() => {
    recenterTimer = null
    if (!mind || !host.value) return
    if (host.value.clientWidth === 0 || host.value.clientHeight === 0) return
    fitToView()
  }, 50)
}

function pushMarkdownFromMind() {
  if (!mind) return
  const root = mind.getData().nodeData
  const frontmatter = (root.metadata as { frontmatter?: string } | undefined)?.frontmatter
  const md = mindToMarkdown(root, frontmatter)
  lastInternalMarkdown = md
  store.setMarkdown(md)
}

function refreshMetadata() {
  if (!mind) return
  const fresh = markdownToMind(store.markdown).nodeData
  const map = new Map<string, NodeMeta | undefined>()
  const freshPaths: string[] = []
  function indexFresh(node: typeof fresh, byPath: string) {
    map.set(byPath, node.metadata as NodeMeta | undefined)
    freshPaths.push(`${byPath} = "${node.topic}" (${(node.metadata as NodeMeta)?.kind})`)
    ;(node.children ?? []).forEach((c, i) => indexFresh(c, `${byPath}/${i}`))
  }
  indexFresh(fresh, 'root')
  const live = mind.nodeData
  function apply(node: typeof live, byPath: string) {
    const meta = map.get(byPath)
    if (meta) node.metadata = meta
    ;(node.children ?? []).forEach((c, i) => apply(c, `${byPath}/${i}`))
  }
  apply(live, 'root')
}

function isDescendant(node: { parent?: unknown; id: string }, ancestor: { id: string }): boolean {
  let cur: { parent?: unknown; id: string } | undefined = node
  while (cur?.parent) {
    cur = cur.parent as { parent?: unknown; id: string }
    if (cur?.id === ancestor.id) return true
  }
  return false
}

function blockEnd(nodeObj: NodeObj): number {
  const meta = nodeObj.metadata as NodeMeta | undefined
  if (!meta) return -1
  let end = meta.endLine
  for (const child of nodeObj.children ?? []) {
    const childEnd = blockEnd(child)
    if (childEnd > end) end = childEnd
  }
  return end
}

function commitMarkdown(next: string): boolean {
  if (next === store.markdown) return false
  lastInternalMarkdown = next
  store.setMarkdown(next)
  refreshMetadata()
  return true
}

function trySurgicalEdit(op: unknown): boolean {
  type OpAny = {
    name?: string
    type?: 'before' | 'after'
    obj?: NodeObj
    objs?: NodeObj[]
    toObj?: NodeObj
    origin?: unknown
  }
  const o = op as OpAny
  if (!o?.name) return false

  if (o.name === 'finishEdit') {
    const meta = o.obj?.metadata as NodeMeta | undefined
    if (!meta) return false
    const isRoot = !!mind && o.obj === mind.nodeData
    if (isRoot && meta.startLine < 0) {
      const forced: NodeMeta = { ...meta, kind: 'root' }
      if (typeof o.obj?.topic !== 'string') return false
      return commitMarkdown(editNodeText(store.markdown, forced, o.obj.topic))
    }
    if (meta.startLine < 0) return false
    if (typeof o.obj?.topic !== 'string') return false
    return commitMarkdown(editNodeText(store.markdown, meta, o.obj.topic))
  }

  if (o.name === 'removeNodes') {
    const metas = (o.objs ?? [])
      .map((n) => n.metadata as NodeMeta | undefined)
      .filter((m): m is NodeMeta => !!m && m.startLine >= 0)
    if (!metas.length) return false
    return commitMarkdown(removeNodes(store.markdown, metas))
  }

  if (o.name === 'addChild') {
    const child = o.obj
    if (!child) return false
    freshNodeId = child.id
    const parent = child.parent as NodeObj | undefined
    if (!parent) return false
    const parentMeta = parent.metadata as NodeMeta | undefined
    if (!parentMeta) return false
    if (parentMeta.kind !== 'root' && parentMeta.startLine < 0) return false
    const existingSibling = (parent.children ?? []).find((c) => {
      if (c.id === child.id) return false
      const m = c.metadata as NodeMeta | undefined
      return m?.kind === 'heading' || m?.kind === 'listItem'
    })
    const siblingMeta = existingSibling?.metadata as NodeMeta | undefined
    const text = child.topic || 'New Node'
    const pEnd = blockEnd(parent)
    return commitMarkdown(
      insertChild(
        store.markdown,
        parentMeta,
        pEnd,
        text,
        parent.expanded !== false,
        siblingMeta
      )
    )
  }

  if (o.name === 'insertSibling') {
    const sibling = o.obj
    if (!sibling) return false
    freshNodeId = sibling.id
    const parent = sibling.parent as NodeObj | undefined
    if (!parent || !parent.children) return false
    const idx = parent.children.findIndex((c) => c.id === sibling.id)
    if (idx < 0) return false
    const refIdx = o.type === 'before' ? idx + 1 : idx - 1
    const ref = parent.children[refIdx]
    const refMeta = ref?.metadata as NodeMeta | undefined
    if (!refMeta || refMeta.startLine < 0) return false
    const text = sibling.topic || 'New Node'
    const refEnd = blockEnd(ref)
    const parentMeta = parent.metadata as NodeMeta | undefined
    return commitMarkdown(
      insertSibling(store.markdown, refMeta, o.type ?? 'after', text, refEnd, parentMeta)
    )
  }

  if (o.name === 'insertParent') {
    const newParent = o.obj
    if (!newParent) return false
    freshNodeId = newParent.id
    const original = newParent.children?.[0]
    if (!original) return false
    const origMeta = original.metadata as NodeMeta | undefined
    if (!origMeta || origMeta.startLine < 0) return false
    const origEnd = blockEnd(original)
    const text = newParent.topic || 'New Node'
    return commitMarkdown(insertParentMd(store.markdown, origMeta, origEnd, text))
  }

  if (o.name === 'copyNode' || o.name === 'copyNodes') {
    const items =
      o.name === 'copyNode'
        ? o.obj
          ? [o.obj]
          : []
        : (o.objs ?? [])
    if (!items.length) return false
    const parent = items[0].parent as NodeObj | undefined
    if (!parent) return false
    const parentMeta = parent.metadata as NodeMeta | undefined
    if (!parentMeta) return false
    if (parentMeta.kind !== 'root' && parentMeta.startLine < 0) return false
    const existingSibling = (parent.children ?? []).find((c) => {
      if (items.some((it) => it.id === c.id)) return false
      const m = c.metadata as NodeMeta | undefined
      return m?.kind === 'heading' || m?.kind === 'listItem'
    })
    const siblingMeta = existingSibling?.metadata as NodeMeta | undefined
    let md = store.markdown
    let pEnd = blockEnd(parent)
    for (const item of items) {
      const before = md
      md = insertSubtree(md, parentMeta, pEnd, item, parent.expanded !== false, siblingMeta)
      if (md !== before) pEnd += md.split('\n').length - before.split('\n').length
    }
    return commitMarkdown(md)
  }

  if (o.name === 'moveUpNode' || o.name === 'moveDownNode') {
    const node = o.obj
    if (!node) return false
    const parent = node.parent as NodeObj | undefined
    if (!parent?.children) return false
    const meta = node.metadata as NodeMeta | undefined
    if (!meta || meta.startLine < 0) return false
    const idx = parent.children.findIndex((c) => c.id === node.id)
    if (idx < 0) return false
    const neighborIdx = o.name === 'moveUpNode' ? idx + 1 : idx - 1
    const neighbor = parent.children[neighborIdx]
    const neighborMeta = neighbor?.metadata as NodeMeta | undefined
    if (!neighborMeta) return false
    const targetLine = o.name === 'moveUpNode' ? neighborMeta.startLine : blockEnd(neighbor) + 1
    const effMeta: NodeMeta = { ...meta, endLine: blockEnd(node) }
    return commitMarkdown(
      moveBlock(store.markdown, effMeta, meta.indent ?? 0, null, targetLine)
    )
  }

  if (o.name === 'moveNodeIn' || o.name === 'moveNodeBefore' || o.name === 'moveNodeAfter') {
    const objs = o.objs ?? []
    const to = o.toObj
    if (!objs.length || !to) return false
    const toMeta = to.metadata as NodeMeta | undefined
    if (!toMeta) return false

    let md = store.markdown
    const movedNodes = objs.filter((n) => {
      const m = n.metadata as NodeMeta | undefined
      return !!m && m.startLine >= 0
    })
    if (!movedNodes.length) return false

    const sorted = [...movedNodes].sort((a, b) => {
      const aLine = (a.metadata as NodeMeta).startLine
      const bLine = (b.metadata as NodeMeta).startLine
      return bLine - aLine
    })

    const targetHasListChildren = (toNode: NodeObj) =>
      (toNode.children ?? []).some(
        (c) => (c.metadata as NodeMeta | undefined)?.kind === 'listItem'
      )
    const targetListChildIndent = (toNode: NodeObj): number => {
      const firstListChild = (toNode.children ?? []).find(
        (c) => (c.metadata as NodeMeta | undefined)?.kind === 'listItem'
      )
      const m = firstListChild?.metadata as NodeMeta | undefined
      return m?.indent ?? 0
    }

    for (const node of sorted) {
      const meta = node.metadata as NodeMeta
      const effMeta: NodeMeta = { ...meta, endLine: blockEnd(node) }
      let newIndent: number
      let newMarker: string | null = null
      let targetLine: number
      let headingBump = 0
      let convertHeadingToList = false

      if (o.name === 'moveNodeIn') {
        targetLine = blockEnd(to) + 1
        if (meta.kind === 'heading') {
          if (toMeta.kind === 'heading' && !targetHasListChildren(to)) {
            newIndent = 0
            headingBump = (toMeta.level ?? 1) + 1 - (meta.level ?? 1)
          } else if (toMeta.kind === 'heading' && targetHasListChildren(to)) {
            newIndent = targetListChildIndent(to)
            convertHeadingToList = true
          } else {
            newIndent = (toMeta.indent ?? 0) + 2
            convertHeadingToList = true
          }
        } else {
          newIndent = (toMeta.indent ?? 0) + (toMeta.kind === 'listItem' ? 2 : 0)
          newMarker = '- '
        }
      } else if (o.name === 'moveNodeBefore' || o.name === 'moveNodeAfter') {
        targetLine = o.name === 'moveNodeBefore' ? toMeta.startLine : blockEnd(to) + 1
        if (meta.kind === 'heading' && toMeta.kind === 'heading') {
          newIndent = 0
          headingBump = (toMeta.level ?? 1) - (meta.level ?? 1)
        } else if (meta.kind === 'heading' && toMeta.kind === 'listItem') {
          newIndent = toMeta.indent ?? 0
          convertHeadingToList = true
        } else {
          newIndent = toMeta.indent ?? 0
          newMarker = toMeta.kind === 'heading' ? (toMeta.marker ?? null) : '- '
        }
      } else {
        continue
      }

      md = moveBlock(md, effMeta, newIndent, newMarker, targetLine, {
        headingBump,
        convertHeadingToList,
      })
    }
    return commitMarkdown(md)
  }

  return false
}

function findSiblings(node: { parent?: { children?: { id: string }[] }; id: string }) {
  const parent = node.parent
  if (!parent?.children) return null
  const idx = parent.children.findIndex((n) => n.id === node.id)
  if (idx < 0) return null
  return { parent, idx, siblings: parent.children }
}

function isOnLeftSide(el: HTMLElement): boolean {
  return !!el.closest('.lhs')
}

function moveOut(current: NonNullable<MindElixirInstance['currentNode']>) {
  const nodeObj = current.nodeObj
  if (!nodeObj.parent?.parent) return
  const parentEl = MindElixir.E(nodeObj.parent.id)
  mind!.moveNodeAfter([current], parentEl)
}

function moveIn(current: NonNullable<MindElixirInstance['currentNode']>) {
  const nodeObj = current.nodeObj
  const info = findSiblings(nodeObj)
  if (!info) return
  const target = info.idx > 0 ? info.siblings[info.idx - 1] : info.siblings[info.idx + 1]
  if (!target) return
  const targetEl = MindElixir.E(target.id)
  mind!.moveNodeIn([current], targetEl)
}

function handleMoveHotkey(e: KeyboardEvent) {
  if (!(e.metaKey || e.ctrlKey)) return
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return
  if (!mind) return
  const target = e.target as HTMLElement
  if (target.id === 'input-box' || target.closest?.('#input-box')) return
  if (host.value?.querySelector('#input-box')) return
  const nodes = (mind.currentNodes?.length ? mind.currentNodes : mind.currentNode ? [mind.currentNode] : []) as Array<NonNullable<MindElixirInstance['currentNode']>>
  if (!nodes.length) return
  const firstObj = nodes[0].nodeObj
  if (!firstObj.parent) return
  if (nodes.length > 1) {
    const parentId = firstObj.parent.id
    if (!nodes.every((n) => (n.nodeObj.parent as { id: string } | undefined)?.id === parentId)) return
  }

  e.preventDefault()
  e.stopImmediatePropagation()

  const parent = firstObj.parent as NodeObj
  const siblings = parent.children ?? []
  const sortedNodes = [...nodes].sort(
    (a, b) =>
      siblings.findIndex((c) => c.id === a.nodeObj.id) -
      siblings.findIndex((c) => c.id === b.nodeObj.id)
  )

  if (e.key === 'ArrowUp') {
    const firstIdx = siblings.findIndex((c) => c.id === sortedNodes[0].nodeObj.id)
    if (firstIdx <= 0) return
    const prev = siblings[firstIdx - 1]
    const prevEl = MindElixir.E(prev.id)
    mind.moveNodeBefore(sortedNodes, prevEl)
    return
  }
  if (e.key === 'ArrowDown') {
    const lastIdx = siblings.findIndex(
      (c) => c.id === sortedNodes[sortedNodes.length - 1].nodeObj.id
    )
    if (lastIdx >= siblings.length - 1) return
    const next = siblings[lastIdx + 1]
    const nextEl = MindElixir.E(next.id)
    mind.moveNodeAfter(sortedNodes, nextEl)
    return
  }

  const onLeft = isOnLeftSide(sortedNodes[0] as unknown as HTMLElement)
  const goingIn = (e.key === 'ArrowRight' && !onLeft) || (e.key === 'ArrowLeft' && onLeft)
  if (goingIn) {
    const firstIdx = siblings.findIndex((c) => c.id === sortedNodes[0].nodeObj.id)
    const lastIdx = siblings.findIndex(
      (c) => c.id === sortedNodes[sortedNodes.length - 1].nodeObj.id
    )
    let into: { id: string } | undefined
    if (firstIdx > 0) into = siblings[firstIdx - 1]
    else if (lastIdx < siblings.length - 1) into = siblings[lastIdx + 1]
    if (!into) return
    mind.moveNodeIn(sortedNodes, MindElixir.E(into.id))
  } else {
    if (!parent.parent) return
    mind.moveNodeAfter(sortedNodes, MindElixir.E(parent.id))
  }
}

function findNearestNode(
  current: HTMLElement,
  direction: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'
): HTMLElement | null {
  if (!mind) return null
  const all = Array.from(mind.el.querySelectorAll<HTMLElement>('me-tpc'))
  const cur = current.getBoundingClientRect()
  const cx = cur.left + cur.width / 2
  const cy = cur.top + cur.height / 2
  let best: { el: HTMLElement; dist: number } | null = null
  for (const el of all) {
    if (el === current) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const ex = r.left + r.width / 2
    const ey = r.top + r.height / 2
    const dx = ex - cx
    const dy = ey - cy
    let primary = 0
    let lateral = 0
    if (direction === 'ArrowRight') {
      if (dx <= 0) continue
      primary = dx
      lateral = Math.abs(dy)
    } else if (direction === 'ArrowLeft') {
      if (dx >= 0) continue
      primary = -dx
      lateral = Math.abs(dy)
    } else if (direction === 'ArrowDown') {
      if (dy <= 0) continue
      primary = dy
      lateral = Math.abs(dx)
    } else {
      if (dy >= 0) continue
      primary = -dy
      lateral = Math.abs(dx)
    }
    if (lateral > primary * 2) continue
    const dist = primary + lateral * 0.5
    if (!best || dist < best.dist) best = { el, dist }
  }
  return best?.el ?? null
}

function findSiblingNode(node: NodeObj, direction: 'prev' | 'next'): NodeObj | null {
  const parent = node.parent
  if (!parent?.children) return null
  const idx = parent.children.findIndex((c) => c.id === node.id)
  if (idx < 0) return null
  const target = direction === 'prev' ? idx - 1 : idx + 1
  if (target < 0 || target >= parent.children.length) return null
  return parent.children[target]
}

function trySelectById(id: string): boolean {
  if (!mind) return false
  try {
    const el = MindElixir.E(id)
    if (el) {
      mind.selectNode(el)
      return true
    }
  } catch {
    /* not visible */
  }
  return false
}

function placeCaretAtEnd(el: HTMLElement) {
  const range = document.createRange()
  const sel = window.getSelection()
  if (!sel) return
  range.selectNodeContents(el)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
}

function toggleInlineFormat(prefix: string, suffix: string) {
  if (!mind) return
  const nodes = (mind.currentNodes?.length
    ? mind.currentNodes
    : mind.currentNode
      ? [mind.currentNode]
      : []) as Array<NonNullable<MindElixirInstance['currentNode']>>
  if (!nodes.length) return
  let md = store.markdown
  let changed = false
  for (const node of nodes) {
    const nodeObj = node.nodeObj as NodeObj & { dangerouslySetInnerHTML?: string }
    const meta = nodeObj.metadata as NodeMeta | undefined
    if (!meta || meta.startLine < 0) continue
    const body = (meta.rawBody ?? nodeObj.topic ?? '').trim()
    if (!body) continue
    const wrapped =
      body.startsWith(prefix) &&
      body.endsWith(suffix) &&
      body.length > prefix.length + suffix.length
    const newBody = wrapped
      ? body.slice(prefix.length, body.length - suffix.length)
      : `${prefix}${body}${suffix}`
    const next = editNodeText(md, meta, newBody)
    if (next === md) continue
    md = next
    changed = true
    nodeObj.topic = newBody
    delete nodeObj.dangerouslySetInnerHTML
    meta.rawBody = newBody
    const el = node as unknown as { text?: { innerHTML: string } }
    if (el.text) {
      el.text.innerHTML = inlineRenderer.renderInline(newBody).replace(/\n/g, '<br>')
    }
  }
  if (!changed) return
  commitMarkdown(md)
}

function handleTypeToEdit(e: KeyboardEvent) {
  if (!mind || !mind.currentNode) return
  const target = e.target as HTMLElement
  if (target.id === 'input-box' || target.closest?.('#input-box')) return
  if (host.value?.querySelector('#input-box')) return

  if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault()
    e.stopImmediatePropagation()
    if (e.shiftKey) store.redo()
    else store.undo()
    return
  }

  if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B')) {
    e.preventDefault()
    e.stopImmediatePropagation()
    toggleInlineFormat('**', '**')
    return
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === 'i' || e.key === 'I')) {
    e.preventDefault()
    e.stopImmediatePropagation()
    toggleInlineFormat('*', '*')
    return
  }

  if (e.key === 'Backspace') {
    e.preventDefault()
    e.stopImmediatePropagation()
    if (e.shiftKey) {
      const nodes = (mind.currentNodes?.length
        ? mind.currentNodes
        : [mind.currentNode]) as Array<NonNullable<MindElixirInstance['currentNode']>>
      mind.removeNodes(nodes)
    } else {
      mind.beginEdit(mind.currentNode)
    }
    return
  }

  if (e.key.length !== 1) return
  if (e.key === ' ') return
  if (e.ctrlKey || e.metaKey || e.altKey) return
  e.preventDefault()
  e.stopImmediatePropagation()
  const ch = e.key
  mind.beginEdit(mind.currentNode)
  setTimeout(() => {
    const inputBox = host.value?.querySelector<HTMLElement>('#input-box')
    if (!inputBox) return
    inputBox.textContent = ch
    placeCaretAtEnd(inputBox)
  }, 0)
}

function handleSpatialNav(e: KeyboardEvent) {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return
  if (!mind || !mind.currentNode) return
  const target = e.target as HTMLElement
  if (target.id === 'input-box' || target.closest?.('#input-box')) return
  if (host.value?.querySelector('#input-box')) return
  e.preventDefault()
  e.stopImmediatePropagation()

  const extend = e.shiftKey
  const cur = mind.currentNode
  const nodeObj = cur.nodeObj
  const dir = e.key as 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'

  const select = (id: string) => {
    if (!mind) return false
    try {
      const el = MindElixir.E(id)
      if (!el) return false
      if (extend) {
        mind.selection?.select(el as unknown as Parameters<NonNullable<MindElixirInstance['selection']>['select']>[0])
      } else {
        mind.selectNode(el)
      }
      return true
    } catch {
      return false
    }
  }

  if (dir === 'ArrowDown' || dir === 'ArrowUp') {
    const sibling = findSiblingNode(nodeObj, dir === 'ArrowDown' ? 'next' : 'prev')
    if (sibling && select(sibling.id)) return
  } else {
    const onLeft = isOnLeftSide(cur as unknown as HTMLElement)
    const goingIn = (dir === 'ArrowRight' && !onLeft) || (dir === 'ArrowLeft' && onLeft)
    if (goingIn) {
      if (nodeObj.expanded !== false && nodeObj.children?.length) {
        const remembered = lastChildMap.get(nodeObj.id)
        const targetNode = nodeObj.children.find((c) => c.id === remembered) ?? nodeObj.children[0]
        if (select(targetNode.id)) return
      }
    } else {
      const parent = nodeObj.parent as NodeObj | undefined
      if (parent && parent.parent && select(parent.id)) return
    }
  }

  const nearest = findNearestNode(cur as unknown as HTMLElement, dir)
  if (nearest) {
    const id = (nearest as unknown as { nodeObj?: { id: string } }).nodeObj?.id
    if (id) select(id)
  }
}

onMounted(() => {
  if (!host.value) return
  const isDark = document.documentElement.dataset.theme === 'dark'
  mind = new MindElixir({
    el: host.value,
    direction: MindElixir.RIGHT,
    draggable: true,
    allowUndo: false,
    theme: isDark ? MindElixir.DARK_THEME : MindElixir.THEME,
    before: {
      insertSibling: function (this: MindElixirInstance, _type, el) {
        const target = el ?? this.currentNode
        const meta = (target?.nodeObj as { metadata?: NodeMeta } | undefined)?.metadata
        return meta?.kind !== 'block'
      },
      addChild: function (this: MindElixirInstance, el) {
        const target = el ?? this.currentNode
        const meta = (target?.nodeObj as { metadata?: NodeMeta } | undefined)?.metadata
        return meta?.kind !== 'block'
      },
    },
    markdown: (text) => {
      if (!text.trim()) return '  '
      const html = inlineRenderer.renderInline(text).replace(/\n/g, '<br>')
      return html.replace(/<a\b([^>]*)>/gi, (match, attrs: string) => {
        if (/\btarget\s*=/i.test(attrs)) return match
        return `<a${attrs} target="_blank" rel="noopener noreferrer">`
      })
    },
    keypress: {
      Tab: (e) => {
        if (!mind) return
        if (e.shiftKey) mind.insertSibling('before')
        else mind.addChild()
      },
      Enter: (e) => {
        if (!mind) return
        if (e.shiftKey) mind.insertParent()
        else mind.insertSibling('after')
      },
      ' ': () => {
        if (!mind || !mind.currentNode) return
        mind.expandNode(mind.currentNode)
      },
      F1: () => fitToView(),
    },
  })
  mind.init(markdownToMind(store.markdown))
  for (const delay of [0, 50, 150, 400, 800]) {
    setTimeout(() => requestAnimationFrame(fitToView), delay)
  }
  const centerBtn = mind.el.querySelector<HTMLElement>('#toCenter')
  if (centerBtn) {
    centerBtn.onclick = fitToView
  }
  const dirButtons: [string, () => void][] = [
    ['#tbltl', () => mind?.initLeft()],
    ['#tbltr', () => mind?.initRight()],
    ['#tblts', () => mind?.initSide()],
  ]
  for (const [sel, run] of dirButtons) {
    const btn = mind.el.querySelector<HTMLElement>(sel)
    if (!btn) continue
    btn.onclick = () => {
      run()
      requestAnimationFrame(fitToView)
    }
  }
  const reportSelection = (nodeObjs: NodeObj[]) => {
    const last = nodeObjs[nodeObjs.length - 1]
    if (last?.parent) lastChildMap.set((last.parent as NodeObj).id, last.id)
    const meta = last?.metadata as NodeMeta | undefined
    if (!meta || meta.startLine < 0) return
    if (store.cursorLine === meta.startLine && store.cursorSource === 'mindmap') return
    store.setCursorLine(meta.startLine, 'mindmap')
  }
  mind.bus.addListener('selectNodes', reportSelection)
  mind.bus.addListener('selectNewNode', (nodeObj) => reportSelection([nodeObj]))

  mind.bus.addListener('operation', (op) => {
    if (op.name !== 'beginEdit') return
    const inputBox = host.value?.querySelector('#input-box') as HTMLElement | null
    if (!inputBox) return
    const nodeObj = op.obj
    const original = nodeObj.topic
    const editingEl = (() => {
      try {
        return MindElixir.E(nodeObj.id)
      } catch {
        return null
      }
    })()
    const isFresh = !!creatingNode || freshNodeId === nodeObj.id
    const opKind = creatingNode || null
    freshNodeId = null
    let escaped = false
    const onKeydown = (e: KeyboardEvent) => {
      if (!(e.target instanceof HTMLElement)) return
      if (!e.target.closest('#input-box')) return
      if (e.key === 'Escape') escaped = true
    }
    document.addEventListener('keydown', onKeydown, { capture: true })
    const handleBlur = () => {
      document.removeEventListener('keydown', onKeydown, true)
      if (editingEl) editingEl.style.visibility = ''
      if (isFresh && escaped) {
        if (opKind === 'insertParent') {
          requestAnimationFrame(() => {
            store.undo()
          })
          return
        }
        requestAnimationFrame(() => {
          if (!mind) return
          try {
            const el = MindElixir.E(nodeObj.id)
            if (el) mind.removeNodes([el])
          } catch {
            /* missing */
          }
        })
        return
      }
      setTimeout(() => {
        const text = (inputBox.innerText ?? '').trim()
        if (text !== '') return
        if (nodeObj.topic === '') return
        nodeObj.topic = ''
        if (editingEl?.text) editingEl.text.innerHTML = '\u00a0\u00a0'
        ;(mind?.bus.fire as (event: string, payload: unknown) => void)('operation', {
          name: 'finishEdit',
          obj: nodeObj,
          origin: original,
        })
      }, 0)
    }
    inputBox.addEventListener('blur', handleBlur, { once: true })
  })

  mind.bus.addListener('expandNode', (nodeObj) => {
    if (!mind) return
    const saved = preExpandSelection
    preExpandSelection = null
    const meta = (nodeObj as { metadata?: NodeMeta }).metadata
    if (meta && meta.kind !== 'root' && meta.startLine >= 0) {
      const next = setFold(store.markdown, meta, nodeObj.expanded === false)
      if (next !== store.markdown) {
        lastInternalMarkdown = next
        store.setMarkdown(next)
        queueMicrotask(refreshMetadata)
      }
    }
    const savedNode = saved?.nodeObj as { id: string; parent?: unknown } | undefined
    if (!savedNode) return
    if (nodeObj.expanded === false && isDescendant(savedNode, nodeObj)) {
      try {
        const el = MindElixir.E(nodeObj.id)
        if (el) mind.selectNode(el)
      } catch {
        /* node detached */
      }
      return
    }
    try {
      const el = MindElixir.E(savedNode.id)
      if (el) mind.selectNode(el)
    } catch {
      /* original node hidden */
    }
  })

  mind.bus.addListener('operation', (op) => {
    if (op.name === 'beginEdit') {
      const el = MindElixir.E(op.obj.id)
      if (el) el.style.visibility = 'hidden'
      return
    }
    const handled = trySurgicalEdit(op)
    if (handled) return
    const mutationOps = new Set([
      'addChild',
      'insertSibling',
      'insertParent',
      'removeNodes',
      'moveUpNode',
      'moveDownNode',
      'moveNodeIn',
      'moveNodeBefore',
      'moveNodeAfter',
      'copyNode',
      'copyNodes',
      'reshapeNode',
    ])
    if (op?.name && mutationOps.has(op.name as string)) {
      store.setError(`Markdown not updated for "${op.name}" — mindmap may be out of sync`)
    }
    // No surgical handler — skip markdown update rather than reformatting everything.
    // Next surgical op will re-sync from the (possibly stale) markdown side.
  })
  mind.container.addEventListener('keydown', handleMoveHotkey, { capture: true })
  mind.container.addEventListener('keydown', handleSpatialNav, { capture: true })
  mind.container.addEventListener('keydown', handleTypeToEdit, { capture: true })

  const parseTranslate = (transform: string) => {
    const m = transform.match(/translate(?:3d)?\(([-\d.]+)(?:px)?\s*,\s*([-\d.]+)(?:px)?/)
    if (!m) return { x: 0, y: 0 }
    return { x: parseFloat(m[1]), y: parseFloat(m[2]) }
  }
  const origScale = mind.scale.bind(mind)
  mind.scale = function (scaleVal, offset) {
    if (!mind) return origScale(scaleVal, offset)
    scaleVal = Math.min(8, Math.max(0.05, scaleVal))
    const cRect = mind.container.getBoundingClientRect()
    const anchorX = offset ? offset.x - cRect.left : cRect.width / 2
    const anchorY = offset ? offset.y - cRect.top : cRect.height / 2
    const t = parseTranslate(mind.map.style.transform)
    const oldScale = mind.scaleVal || 1
    const localX = (anchorX - t.x) / oldScale
    const localY = (anchorY - t.y) / oldScale
    const dx = anchorX - localX * scaleVal
    const dy = anchorY - localY * scaleVal
    mind.scaleVal = scaleVal
    mind.map.style.transformOrigin = '0 0'
    mind.map.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${scaleVal})`
    mind.bus.fire('scale', scaleVal)
  }

  const origMove = mind.move.bind(mind)
  mind.move = function (dx, dy, smooth) {
    if (!mind) return origMove(dx, dy, smooth)
    const cRect = mind.container.getBoundingClientRect()
    const nRect = mind.nodes.getBoundingClientRect()
    const minOverlap = 60
    if (dx > 0 && nRect.left + dx > cRect.right - minOverlap) {
      dx = Math.max(0, cRect.right - minOverlap - nRect.left)
    } else if (dx < 0 && nRect.right + dx < cRect.left + minOverlap) {
      dx = Math.min(0, cRect.left + minOverlap - nRect.right)
    }
    if (dy > 0 && nRect.top + dy > cRect.bottom - minOverlap) {
      dy = Math.max(0, cRect.bottom - minOverlap - nRect.top)
    } else if (dy < 0 && nRect.bottom + dy < cRect.top + minOverlap) {
      dy = Math.min(0, cRect.top + minOverlap - nRect.bottom)
    }
    return origMove(dx, dy, smooth)
  }

  const origBeginEdit = mind.beginEdit.bind(mind)
  mind.beginEdit = function (el) {
    const nodeEle = el ?? this.currentNode
    if (!nodeEle) return Promise.resolve()
    const nodeObj = nodeEle.nodeObj as NodeObj & { dangerouslySetInnerHTML?: string }
    if (nodeObj.dangerouslySetInnerHTML) {
      const meta = nodeObj.metadata as NodeMeta | undefined
      const raw = meta?.rawBody ?? nodeObj.topic ?? ''
      nodeObj.topic = raw
      delete nodeObj.dangerouslySetInnerHTML
    }
    return origBeginEdit(nodeEle)
  }
  const origInsertSibling = mind.insertSibling.bind(mind)
  mind.insertSibling = async function (type, el, node) {
    creatingNode = 'insertSibling'
    try {
      return await origInsertSibling(type, el, node)
    } finally {
      creatingNode = false
    }
  }
  const origInsertParent = mind.insertParent.bind(mind)
  mind.insertParent = async function (el, node) {
    creatingNode = 'insertParent'
    try {
      return await origInsertParent(el, node)
    } finally {
      creatingNode = false
    }
  }
  const origAddChild = mind.addChild.bind(mind)
  mind.addChild = async function (el, node) {
    creatingNode = 'addChild'
    try {
      return await origAddChild(el, node)
    } finally {
      creatingNode = false
    }
  }

  const origRemoveNodes = mind.removeNodes.bind(mind)
  mind.removeNodes = async function (tpcs) {
    let nextId: string | null = null
    if (tpcs?.length) {
      const last = tpcs[tpcs.length - 1]
      const parent = last.nodeObj.parent as NodeObj | undefined
      const removedIds = new Set(tpcs.map((t) => t.nodeObj.id))
      if (parent?.children) {
        const lastIdx = parent.children.findIndex((c) => c.id === last.nodeObj.id)
        const remaining = parent.children.filter((c) => !removedIds.has(c.id))
        const after = remaining.find((c) => parent.children!.indexOf(c) > lastIdx)
        const before = [...remaining].reverse().find((c) => parent.children!.indexOf(c) < lastIdx)
        if (after) nextId = after.id
        else if (before) nextId = before.id
        else if (parent.parent) nextId = parent.id
      }
    }
    await origRemoveNodes(tpcs)
    if (nextId && mind) {
      try {
        const el = MindElixir.E(nextId)
        if (el) mind.selectNode(el)
      } catch {
        /* node not found */
      }
    }
  }

  let suppressClear = false
  let preExpandSelection: { id: string; nodeObj: unknown } | null = null
  mind.container.addEventListener(
    'pointerdown',
    (e) => {
      const t = e.target as HTMLElement
      const topicEl = t.closest('me-tpc') as HTMLElement | null
      const onTopic = !!topicEl
      const onExpander = t.tagName === 'ME-EPD'
      const onUi = !!t.closest('.mind-elixir-toolbar, #input-box, .context-menu')
      if (onExpander) {
        const cur = mind!.currentNode?.nodeObj
        preExpandSelection = cur ? { id: cur.id, nodeObj: cur } : null
        return
      }
      if (onTopic && e.button === 0 && mind) {
        if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
          e.stopImmediatePropagation()
          e.preventDefault()
          mind.selection?.select(topicEl as Parameters<NonNullable<MindElixirInstance['selection']>['select']>[0])
          return
        }
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
          const nodes = mind.currentNodes ?? []
          if (nodes.length > 1 && nodes.some((n) => n === topicEl)) {
            e.stopImmediatePropagation()
            e.preventDefault()
            mind.selectNode(topicEl as Parameters<MindElixirInstance['selectNode']>[0])
            return
          }
        }
      }
      if (onTopic || onUi) return
      suppressClear = true
      setTimeout(() => {
        suppressClear = false
      }, 0)
    },
    { capture: true }
  )
  const origClear = mind.clearSelection.bind(mind)
  mind.clearSelection = function () {
    if (suppressClear) {
      mind!.unselectSummary()
      mind!.unselectArrow()
      return
    }
    origClear()
  }
  resizeObserver = new ResizeObserver(scheduleRecenter)
  resizeObserver.observe(host.value)

  themeObserver = new MutationObserver(() => {
    if (!mind) return
    const dark = document.documentElement.dataset.theme === 'dark'
    mind.changeTheme(dark ? MindElixir.DARK_THEME : MindElixir.THEME)
    requestAnimationFrame(() => fitToView())
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

  let relayoutTimer: number | null = null
  const relayout = () => {
    if (relayoutTimer) window.clearTimeout(relayoutTimer)
    relayoutTimer = window.setTimeout(() => {
      relayoutTimer = null
      mind?.linkDiv()
    }, 50)
  }
  host.value.addEventListener(
    'load',
    (e) => {
      if (e.target instanceof HTMLImageElement) relayout()
    },
    { capture: true }
  )
})

onBeforeUnmount(() => {
  if (refreshTimer) window.clearTimeout(refreshTimer)
  if (recenterTimer) window.clearTimeout(recenterTimer)
  resizeObserver?.disconnect()
  resizeObserver = null
  themeObserver?.disconnect()
  themeObserver = null
  mind?.destroy()
  mind = null
})

watch(
  () => store.markdown,
  (md) => {
    if (md === lastInternalMarkdown) {
      lastInternalMarkdown = null
      return
    }
    scheduleRefresh()
  }
)

function findNodeByLine(node: NodeObj, line: number): NodeObj | null {
  const meta = node.metadata as NodeMeta | undefined
  let match: NodeObj | null = null
  if (meta && meta.startLine >= 0 && line >= meta.startLine && line <= meta.endLine) {
    match = node
  }
  for (const child of node.children ?? []) {
    const sub = findNodeByLine(child, line)
    if (sub) {
      const subMeta = sub.metadata as NodeMeta | undefined
      const matchMeta = match?.metadata as NodeMeta | undefined
      if (!match || (subMeta && matchMeta && subMeta.startLine > matchMeta.startLine)) match = sub
    }
  }
  return match
}

watch(
  () => store.cursorLine,
  (line) => {
    if (!mind) return
    if (store.cursorSource !== 'editor') return
    const root = mind.getData().nodeData
    const target = findNodeByLine(root, line)
    if (!target) return
    if (mind.currentNode?.nodeObj.id === target.id) return
    try {
      const el = MindElixir.E(target.id)
      if (el) mind.selectNode(el)
    } catch {
      /* hidden under fold */
    }
  }
)

let themeObserver: MutationObserver | null = null

watch(
  () => store.viewMode,
  async () => {
    await nextTick()
    requestAnimationFrame(() => {
      if (!mind || !host.value) return
      if (host.value.clientWidth === 0) return
      fitToView()
    })
  }
)
</script>

<template>
  <div ref="host" class="mindmap"></div>
</template>

<style>
.mindmap {
  position: relative;
  height: 100%;
  width: 100%;
  background: #fafafa;
}
.mindmap me-tpc,
.mindmap me-tpc *,
.mindmap #input-box {
  white-space: pre-wrap;
}
.mindmap me-tpc {
  min-width: 1.5em !important;
  min-height: 1.2em !important;
  box-sizing: border-box;
}
.mindmap me-tpc svg {
  fill: currentColor;
}
.mindmap me-tpc > .text:empty::before {
  content: '\00a0';
}
.mindmap me-tpc[style*="opacity: 0"],
.mindmap me-tpc[style*="opacity:0"] {
  visibility: hidden !important;
}
</style>
