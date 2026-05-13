import { describe, test, expect } from 'vitest'
import type { NodeObj } from 'mind-elixir'
import { markdownToMind } from '@/utils/md2mind'
import type { NodeMeta } from '@/utils/md2mind'
import {
  editNodeText,
  insertChild,
  insertParent,
  insertSibling,
  insertSubtree,
  moveBlock,
  removeNodes,
  setFold,
} from '@/utils/surgical'

const WELCOME = `# stackmind

## Welcome

- **A markdown editor with a live mindmap preview.**
- Edit on either side — they stay in sync.

## Markdown features

### Inline formatting

- **bold**, *italic*, ~~strikethrough~~, ==highlight==
- \`inline code\`
- [x] task checkboxes
- [Hyperlinks](https://markmap.js.org/) open in a new tab
- Long items wrap automatically inside the node
- Multi-line items \\
  continue on the next line
- Ordered lists
  1. one
  2. two

### Folding

- Toggle a branch with the \`+/-\` on the node
- Or press \`Space\` on a selected node
- Add \`<!-- markmap: fold -->\` to keep a branch collapsed in markdown

## Mindmap shortcuts

### Editing

- \`Tab\` — add child
- \`Shift\` + \`Tab\` — insert sibling before
- \`Enter\` — insert sibling after
- \`Shift\` + \`Enter\` — insert parent
- \`Backspace\` — edit current node
- \`Shift\` + \`Backspace\` — delete node
- Type any letter to start replacing the node text
- \`Esc\` — cancel the current edit (also removes a freshly created node)
- \`Cmd\`/\`Ctrl\` + \`B\` — toggle **bold** on selected nodes
- \`Cmd\`/\`Ctrl\` + \`I\` — toggle *italic* on selected nodes

### Navigation

- Arrow keys — move to the nearest node (within branch first, then spatially)
- \`Shift\` + Arrows — extend selection to multiple nodes
- \`Shift\` + click — add/remove a node from the selection
- Click on a node already in multi-selection — collapse selection to that node
- \`Cmd\`/\`Ctrl\` + Arrows — move the node (or whole selection if siblings) up / down / in / out
- \`F1\` or the target icon — fit the whole map into view
- \`Cmd\`/\`Ctrl\` + \`Z\` / \`Shift\` + \`Z\` — undo / redo

## Layout

- The toolbar on the right toggles editor-only / split / mindmap-only
- Drag the vertical divider in split view to resize
- The whole document is stored in your browser's local storage
`

function findNode(root: NodeObj, predicate: (n: NodeObj) => boolean): NodeObj | null {
  if (predicate(root)) return root
  for (const child of root.children ?? []) {
    const f = findNode(child, predicate)
    if (f) return f
  }
  return null
}

function byTopic(root: NodeObj, topic: string): NodeObj {
  const found = findNode(root, (n) => (n.topic ?? '').trim() === topic)
  if (!found) throw new Error(`no node with topic "${topic}"`)
  return found
}

function blockEnd(node: NodeObj): number {
  const meta = node.metadata as NodeMeta | undefined
  if (!meta) return -1
  let end = meta.endLine
  for (const child of node.children ?? []) {
    const childEnd = blockEnd(child)
    if (childEnd > end) end = childEnd
  }
  return end
}

function parse(markdown: string) {
  return markdownToMind(markdown).nodeData
}

describe('editNodeText (rename)', () => {
  test('rename H2 heading "Welcome"', () => {
    const root = parse(WELCOME)
    const node = byTopic(root, 'Welcome')
    const next = editNodeText(WELCOME, node.metadata as NodeMeta, 'Greetings')
    expect(next.split('\n')[2]).toBe('## Greetings')
  })

  test('rename root H1 "stackmind"', () => {
    const root = parse(WELCOME)
    const next = editNodeText(WELCOME, root.metadata as NodeMeta, 'mindly')
    expect(next.split('\n')[0]).toBe('# mindly')
  })

  test('rename list item preserves following children', () => {
    const root = parse(WELCOME)
    const ordered = byTopic(root, 'Ordered lists')
    const next = editNodeText(WELCOME, ordered.metadata as NodeMeta, 'Numbered items')
    const lines = next.split('\n')
    const idx = lines.findIndex((l) => l.startsWith('- Numbered items'))
    expect(idx).toBeGreaterThan(0)
    expect(lines[idx + 1]).toBe('  1. one')
    expect(lines[idx + 2]).toBe('  2. two')
  })
})

describe('removeNodes', () => {
  test('remove a list item without touching siblings', () => {
    const root = parse(WELCOME)
    const node = byTopic(root, '`inline code`')
    const next = removeNodes(WELCOME, [node.metadata as NodeMeta])
    expect(next.includes('- `inline code`')).toBe(false)
    expect(next.includes('- **bold**, *italic*, ~~strikethrough~~, ==highlight==')).toBe(true)
    expect(next.includes('- [x] task checkboxes')).toBe(true)
  })

  test('remove a list item with nested children removes whole block', () => {
    const root = parse(WELCOME)
    const node = byTopic(root, 'Ordered lists')
    const meta = { ...(node.metadata as NodeMeta), endLine: blockEnd(node) }
    const next = removeNodes(WELCOME, [meta])
    expect(next.includes('Ordered lists')).toBe(false)
    expect(next.includes('1. one')).toBe(false)
    expect(next.includes('2. two')).toBe(false)
  })

  test('remove a heading section', () => {
    const root = parse(WELCOME)
    const node = byTopic(root, 'Folding')
    const meta = { ...(node.metadata as NodeMeta), endLine: blockEnd(node) }
    const next = removeNodes(WELCOME, [meta])
    expect(next.includes('### Folding')).toBe(false)
    expect(next.includes('Toggle a branch')).toBe(false)
    // siblings still there
    expect(next.includes('### Inline formatting')).toBe(true)
  })
})

describe('insertChild / addChild', () => {
  test('add child to a list item with existing children copies marker style', () => {
    const root = parse(WELCOME)
    const parent = byTopic(root, 'Ordered lists')
    const parentMeta = parent.metadata as NodeMeta
    const firstChild = parent.children?.[0]
    const next = insertChild(
      WELCOME,
      parentMeta,
      blockEnd(parent),
      'three',
      true,
      firstChild?.metadata as NodeMeta | undefined
    )
    const lines = next.split('\n')
    const insertIdx = lines.findIndex((l) => l.includes('three'))
    // child of `- Ordered lists` should be indented 2 with same marker style
    expect(lines[insertIdx]).toMatch(/^ {2}(?:- |\d+[.)] )three$/)
  })

  test('add child to a heading-only parent without list children creates list item', () => {
    const root = parse(WELCOME)
    const parent = byTopic(root, 'Folding')
    const parentMeta = parent.metadata as NodeMeta
    const firstChild = parent.children?.find(
      (c) => (c.metadata as NodeMeta | undefined)?.kind !== 'block'
    )
    const next = insertChild(
      WELCOME,
      parentMeta,
      blockEnd(parent),
      'new tip',
      true,
      firstChild?.metadata as NodeMeta | undefined
    )
    expect(next.split('\n').some((l) => l === '- new tip')).toBe(true)
  })

  test('add child to H1 root inserts a heading sibling at end', () => {
    const root = parse(WELCOME)
    const parentMeta = root.metadata as NodeMeta
    const firstChild = root.children?.[0]
    const next = insertChild(
      WELCOME,
      parentMeta,
      blockEnd(root),
      'Extras',
      true,
      firstChild?.metadata as NodeMeta | undefined
    )
    const lines = next.split('\n').filter((l) => l.length > 0)
    expect(lines[lines.length - 1]).toBe('## Extras')
  })
})

describe('insertSibling', () => {
  test('insert heading sibling before another heading', () => {
    const root = parse(WELCOME)
    const ref = byTopic(root, 'Welcome')
    const refMeta = ref.metadata as NodeMeta
    const next = insertSibling(WELCOME, refMeta, 'before', 'Intro', blockEnd(ref))
    const lines = next.split('\n')
    const newIdx = lines.findIndex((l) => l === '## Intro')
    expect(newIdx).toBeGreaterThan(0)
    expect(lines[newIdx + 1]).toBe('## Welcome')
  })

  test('insert list sibling after a parent with children skips the whole subtree', () => {
    const root = parse(WELCOME)
    const ref = byTopic(root, 'Ordered lists')
    const refMeta = ref.metadata as NodeMeta
    const next = insertSibling(WELCOME, refMeta, 'after', 'three', blockEnd(ref))
    const lines = next.split('\n')
    const refIdx = lines.findIndex((l) => l.startsWith('- Ordered lists'))
    const newIdx = lines.findIndex((l) => l === '- three')
    expect(newIdx).toBeGreaterThan(refIdx)
    // siblings of Ordered list (its nested 1./2.) stay attached
    expect(lines[refIdx + 1]).toBe('  1. one')
    expect(lines[refIdx + 2]).toBe('  2. two')
  })
})

describe('insertParent', () => {
  test('wrap a heading bumps headings inside the block', () => {
    const root = parse(WELCOME)
    const target = byTopic(root, 'Mindmap shortcuts')
    const meta = target.metadata as NodeMeta
    const next = insertParent(WELCOME, meta, blockEnd(target), 'Reference')
    const lines = next.split('\n')
    const wrapIdx = lines.findIndex((l) => l === '## Reference')
    expect(wrapIdx).toBeGreaterThan(0)
    expect(lines[wrapIdx + 1]).toBe('### Mindmap shortcuts')
    // Editing was ### now ####
    expect(lines.some((l) => l === '#### Editing')).toBe(true)
    expect(lines.some((l) => l === '#### Navigation')).toBe(true)
  })

  test('wrap a list item bumps indent in nested children', () => {
    const root = parse(WELCOME)
    const target = byTopic(root, 'Ordered lists')
    const meta = target.metadata as NodeMeta
    const next = insertParent(WELCOME, meta, blockEnd(target), 'Group')
    const lines = next.split('\n')
    const wrapIdx = lines.findIndex((l) => l === '- Group')
    expect(wrapIdx).toBeGreaterThan(0)
    expect(lines[wrapIdx + 1]).toBe('  - Ordered lists')
    expect(lines[wrapIdx + 2]).toBe('    1. one')
    expect(lines[wrapIdx + 3]).toBe('    2. two')
  })
})

describe('setFold (expand/collapse)', () => {
  test('fold a heading appends comment', () => {
    const root = parse(WELCOME)
    const node = byTopic(root, 'Folding')
    const meta = node.metadata as NodeMeta
    const next = setFold(WELCOME, meta, true)
    const line = next.split('\n')[meta.startLine]
    expect(line.includes('<!-- markmap: fold -->')).toBe(true)
  })

  test('unfold drops comment idempotently', () => {
    const root = parse(WELCOME)
    const node = byTopic(root, 'Folding')
    const meta = node.metadata as NodeMeta
    const folded = setFold(WELCOME, meta, true)
    const unfolded = setFold(folded, meta, false)
    expect(unfolded).toBe(WELCOME)
  })
})

describe('moveBlock', () => {
  test('move heading INTO sibling heading bumps levels in block', () => {
    const root = parse(WELCOME)
    const from = byTopic(root, 'Mindmap shortcuts')
    const to = byTopic(root, 'Markdown features')
    const fromMeta = { ...(from.metadata as NodeMeta), endLine: blockEnd(from) }
    const toEnd = blockEnd(to)
    const next = moveBlock(WELCOME, fromMeta, 0, null, toEnd + 1, {
      headingBump:
        ((to.metadata as NodeMeta).level ?? 1) + 1 - ((from.metadata as NodeMeta).level ?? 1),
    })
    const lines = next.split('\n')
    expect(lines.some((l) => l === '### Mindmap shortcuts')).toBe(true)
    expect(lines.some((l) => l === '#### Editing')).toBe(true)
    expect(lines.some((l) => l === '#### Navigation')).toBe(true)
    // list children stay flat
    expect(lines.some((l) => l === '- `Tab` — add child')).toBe(true)
  })

  test('move heading INTO target with list children converts heading to list', () => {
    const root = parse(WELCOME)
    const from = byTopic(root, 'Navigation')
    const to = byTopic(root, 'Inline formatting') // its children are list items
    const fromMeta = { ...(from.metadata as NodeMeta), endLine: blockEnd(from) }
    const toEnd = blockEnd(to)
    const next = moveBlock(WELCOME, fromMeta, 0, null, toEnd + 1, {
      convertHeadingToList: true,
    })
    const lines = next.split('\n')
    expect(lines.some((l) => l === '- Navigation')).toBe(true)
    // Navigation's children list items should be nested by 2
    expect(
      lines.some(
        (l) =>
          l ===
          '  - Arrow keys — move to the nearest node (within branch first, then spatially)'
      )
    ).toBe(true)
  })
})

describe('moveBlock list → heading roundtrip', () => {
  test('moveOut converts list-item back to heading and flattens nested children', () => {
    // Setup: markdown after Cmd+→ already applied (Navigation now `- Navigation` inside Editing list context)
    const after = `# stackmind

## Mindmap shortcuts

### Editing

- \`Tab\` — add child
- \`Shift\` + \`Tab\` — insert sibling before
- \`Enter\` — insert sibling after
- \`Shift\` + \`Enter\` — insert parent
- \`Backspace\` — edit current node
- \`Shift\` + \`Backspace\` — delete node
- Type any letter to start replacing the node text
- \`Esc\` — cancel the current edit (also removes a freshly created node)
- \`Cmd\`/\`Ctrl\` + \`B\` — toggle **bold** on selected nodes
- \`Cmd\`/\`Ctrl\` + \`I\` — toggle *italic* on selected nodes
- Navigation
  - Arrow keys — move to the nearest node
  - \`Shift\` + Arrows — extend selection
  - \`Cmd\`/\`Ctrl\` + Arrows — move the node
`
    const root = parse(after)
    const navigation = byTopic(root, 'Navigation')
    const editing = byTopic(root, 'Editing')
    const fromMeta = { ...(navigation.metadata as NodeMeta), endLine: blockEnd(navigation) }
    const editingMeta = editing.metadata as NodeMeta
    const next = moveBlock(after, fromMeta, 0, editingMeta.marker ?? '### ', blockEnd(editing) + 1, {
      convertListToHeading: true,
    })
    const lines = next.split('\n')
    // Navigation should now be heading at same level as Editing
    expect(lines.some((l) => l === '### Navigation')).toBe(true)
    // children should be flattened (indent=0)
    expect(lines.some((l) => l === '- Arrow keys — move to the nearest node')).toBe(true)
    expect(lines.some((l) => l === '- `Shift` + Arrows — extend selection')).toBe(true)
    // no leftover indented child of removed `- Navigation`
    expect(lines.some((l) => l.startsWith('  - Arrow keys'))).toBe(false)
  })
})

describe('insertSubtree (copy)', () => {
  test('copy a heading subtree into root creates heading children', () => {
    const root = parse(WELCOME)
    const src = byTopic(root, 'Folding')
    // simulate copy: pass src node as a NodeLike (with topic + children only)
    const cloned: { topic: string; children: { topic: string }[] } = {
      topic: src.topic ?? '',
      children: (src.children ?? []).map((c) => ({ topic: c.topic ?? '' })),
    }
    const parentMeta = root.metadata as NodeMeta
    const firstSibling = root.children?.[0]
    const next = insertSubtree(
      WELCOME,
      parentMeta,
      blockEnd(root),
      cloned,
      true,
      firstSibling?.metadata as NodeMeta | undefined
    )
    // Should append a new H2 named "Folding" at end
    const lines = next.split('\n').filter((l) => l.length > 0)
    const lastFolding = lines.lastIndexOf('## Folding')
    expect(lastFolding).toBeGreaterThanOrEqual(0)
  })
})
