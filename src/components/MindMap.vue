<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import MindElixir from 'mind-elixir'
import type { MindElixirInstance, NodeObj } from 'mind-elixir'
import 'mind-elixir/style'
import { useDocumentStore } from '@/stores/document'
import { markdownToMind } from '@/utils/md2mind'
import type { NodeMeta } from '@/utils/md2mind'
import { mindToMarkdown } from '@/utils/mind2md'
import {
  editNodeText,
  insertChild,
  insertSibling,
  moveBlock,
  removeNodes,
  setFold,
} from '@/utils/surgical'

const store = useDocumentStore()
const host = ref<HTMLDivElement | null>(null)
let mind: MindElixirInstance | null = null
let lastInternalMarkdown: string | null = null
const lastChildMap = new Map<string, string>()
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
  const hostEl = host.value!
  const editorEl = hostEl.closest('.app')?.querySelector<HTMLElement>('.app__editor')
  console.log('[fitToView]', {
    cw, ch, nw, nh,
    hostWidth: hostEl.clientWidth,
    parentWidth: hostEl.parentElement?.clientWidth,
    appWidth: hostEl.closest('.app')?.clientWidth,
    appClass: hostEl.closest('.app')?.className,
    viewMode: store.viewMode,
    editorDisplay: editorEl?.style.display,
    editorWidth: editorEl?.clientWidth,
    editorComputedDisplay: editorEl ? getComputedStyle(editorEl).display : '?',
  })
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
    if (!meta || meta.startLine < 0) return false
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
    return commitMarkdown(
      moveBlock(store.markdown, meta, meta.indent ?? 0, null, targetLine)
    )
  }

  if (o.name === 'moveNodeIn' || o.name === 'moveNodeBefore' || o.name === 'moveNodeAfter') {
    const objs = o.objs ?? []
    const to = o.toObj
    if (!objs.length || !to) return false
    const toMeta = to.metadata as NodeMeta | undefined
    if (!toMeta) return false

    let md = store.markdown
    const movedMetas = objs
      .map((n) => n.metadata as NodeMeta | undefined)
      .filter((m): m is NodeMeta => !!m && m.startLine >= 0)
    if (!movedMetas.length) return false

    const sorted = [...movedMetas].sort((a, b) => b.startLine - a.startLine)
    for (const meta of sorted) {
      let newIndent: number
      let newMarker: string | null = null
      let targetLine: number
      if (o.name === 'moveNodeIn') {
        newIndent = (toMeta.indent ?? 0) + (toMeta.kind === 'listItem' ? 2 : 0)
        targetLine = blockEnd(to) + 1
        newMarker = '- '
      } else if (o.name === 'moveNodeBefore') {
        newIndent = toMeta.indent ?? 0
        targetLine = toMeta.startLine
        newMarker = toMeta.kind === 'heading' ? (toMeta.marker ?? null) : '- '
      } else {
        newIndent = toMeta.indent ?? 0
        targetLine = blockEnd(to) + 1
        newMarker = toMeta.kind === 'heading' ? (toMeta.marker ?? null) : '- '
      }
      md = moveBlock(md, meta, newIndent, newMarker, targetLine)
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
  const current = mind.currentNode
  if (!current) return
  const nodeObj = current.nodeObj
  if (!nodeObj.parent) return

  e.preventDefault()
  e.stopImmediatePropagation()

  if (e.key === 'ArrowUp') return mind.moveUpNode(current)
  if (e.key === 'ArrowDown') return mind.moveDownNode(current)

  const onLeft = isOnLeftSide(current as unknown as HTMLElement)
  const goingIn = (e.key === 'ArrowRight' && !onLeft) || (e.key === 'ArrowLeft' && onLeft)
  if (goingIn) moveIn(current)
  else moveOut(current)
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

  if (e.key === 'Backspace') {
    e.preventDefault()
    e.stopImmediatePropagation()
    if (e.shiftKey) {
      mind.removeNodes([mind.currentNode])
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
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return
  if (!mind || !mind.currentNode) return
  e.preventDefault()
  e.stopImmediatePropagation()

  const cur = mind.currentNode
  const nodeObj = cur.nodeObj
  const dir = e.key as 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'

  if (dir === 'ArrowDown' || dir === 'ArrowUp') {
    const sibling = findSiblingNode(nodeObj, dir === 'ArrowDown' ? 'next' : 'prev')
    if (sibling && trySelectById(sibling.id)) return
  } else {
    const onLeft = isOnLeftSide(cur as unknown as HTMLElement)
    const goingIn = (dir === 'ArrowRight' && !onLeft) || (dir === 'ArrowLeft' && onLeft)
    if (goingIn) {
      if (nodeObj.expanded !== false && nodeObj.children?.length) {
        const remembered = lastChildMap.get(nodeObj.id)
        const target = nodeObj.children.find((c) => c.id === remembered) ?? nodeObj.children[0]
        if (trySelectById(target.id)) return
      }
    } else {
      const parent = nodeObj.parent as NodeObj | undefined
      if (parent && parent.parent && trySelectById(parent.id)) return
    }
  }

  const target = findNearestNode(cur as unknown as HTMLElement, dir)
  if (target) mind.selectNode(target as Parameters<MindElixirInstance['selectNode']>[0])
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
      const html = text.replace(/\n/g, '<br>')
      return html.trim() === '' ? '  ' : html
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
  requestAnimationFrame(() => {
    fitToView()
    setTimeout(fitToView, 200)
  })
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
    const handleBlur = () => {
      if (editingEl) editingEl.style.visibility = ''
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
    if (trySurgicalEdit(op)) return
    // No surgical handler — skip markdown update rather than reformatting everything.
    // Next surgical op will re-sync from the (possibly stale) markdown side.
  })
  mind.container.addEventListener('keydown', handleMoveHotkey, { capture: true })
  mind.container.addEventListener('keydown', handleSpatialNav, { capture: true })
  mind.container.addEventListener('keydown', handleTypeToEdit, { capture: true })

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
      const onTopic = !!t.closest('me-tpc')
      const onExpander = t.tagName === 'ME-EPD'
      const onUi = !!t.closest('.mind-elixir-toolbar, #input-box, .context-menu')
      if (onExpander) {
        const cur = mind!.currentNode?.nodeObj
        preExpandSelection = cur ? { id: cur.id, nodeObj: cur } : null
        return
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
