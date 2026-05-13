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

// ---------------------------------------------------------------------------
// New extended cases (added to lock down expected behaviour). Some of these
// may fail – that's intentional, they capture intent.
// ---------------------------------------------------------------------------

describe('editNodeText edge cases', () => {
  test('rename to empty string keeps the prefix line', () => {
    const root = parse(WELCOME)
    const node = byTopic(root, 'Welcome')
    const next = editNodeText(WELCOME, node.metadata as NodeMeta, '')
    const lines = next.split('\n')
    // Line should still have the "## " prefix even with empty body
    expect(lines[2].startsWith('## ')).toBe(true)
  })

  test('rename to empty string for a list item keeps "- " prefix', () => {
    const root = parse(WELCOME)
    const node = byTopic(root, '`inline code`')
    const meta = node.metadata as NodeMeta
    const next = editNodeText(WELCOME, meta, '')
    const lines = next.split('\n')
    // The original line should now be just `- ` (prefix preserved)
    expect(lines[meta.startLine].startsWith('- ')).toBe(true)
  })

  test('rename adds inline markdown verbatim', () => {
    const root = parse(WELCOME)
    const node = byTopic(root, 'Welcome')
    const next = editNodeText(WELCOME, node.metadata as NodeMeta, '**bold name**')
    expect(next.split('\n')[2]).toBe('## **bold name**')
  })

  test('rename a list item whose body has fold suffix preserves the suffix', () => {
    const md = `# Root

## Section

- item one <!-- markmap: fold -->
  - child
`
    const root = parse(md)
    const node = byTopic(root, 'item one')
    const next = editNodeText(md, node.metadata as NodeMeta, 'renamed item')
    const lines = next.split('\n')
    const renamed = lines.find((l) => l.includes('renamed item'))
    expect(renamed).toBeDefined()
    expect(renamed!.includes('<!-- markmap: fold -->')).toBe(true)
  })

  test('rename a heading deeper than H6 stays clamped at H6', () => {
    // Simulate a heading that would be H7 conceptually – markdown can't go beyond H6 anyway
    const md = `# Root

## A

### B

#### C

##### D

###### E
`
    const root = parse(md)
    const node = byTopic(root, 'E')
    const meta = node.metadata as NodeMeta
    // sanity: meta.level should be 6
    expect(meta.level).toBe(6)
    const next = editNodeText(md, meta, 'E renamed')
    const lines = next.split('\n')
    const idx = lines.findIndex((l) => l.includes('E renamed'))
    expect(lines[idx].startsWith('###### ')).toBe(true)
    expect(lines[idx].startsWith('####### ')).toBe(false)
  })

  test('rename with multi-line newText splits list item with hard-break continuation', () => {
    const root = parse(WELCOME)
    const node = byTopic(root, '`inline code`')
    const next = editNodeText(WELCOME, node.metadata as NodeMeta, 'first\nsecond')
    const lines = next.split('\n')
    // expect the first line to end with `\` (hard break)
    const firstIdx = lines.findIndex((l) => l.endsWith('first\\'))
    expect(firstIdx).toBeGreaterThan(0)
    // second line should be indented continuation
    expect(lines[firstIdx + 1]).toBe('  second')
  })

  test('rename a heading with multi-line newText keeps only first line', () => {
    const root = parse(WELCOME)
    const node = byTopic(root, 'Welcome')
    const next = editNodeText(WELCOME, node.metadata as NodeMeta, 'first\nsecond')
    const lines = next.split('\n')
    expect(lines[2]).toBe('## first')
    // No `second` floating in markdown immediately after
    expect(lines[3]).not.toBe('second')
  })
})

describe('removeNodes batch', () => {
  test('remove two non-adjacent list items at once, siblings remain', () => {
    const root = parse(WELCOME)
    const a = byTopic(root, '`inline code`')
    const b = byTopic(root, 'Long items wrap automatically inside the node')
    const next = removeNodes(WELCOME, [
      a.metadata as NodeMeta,
      b.metadata as NodeMeta,
    ])
    expect(next.includes('- `inline code`')).toBe(false)
    expect(next.includes('Long items wrap')).toBe(false)
    // surrounding siblings
    expect(next.includes('- [x] task checkboxes')).toBe(true)
    expect(next.includes('- [Hyperlinks](https://markmap.js.org/) open in a new tab')).toBe(true)
    expect(next.includes('- Multi-line items \\')).toBe(true)
  })

  test('remove last child of a heading section leaves the heading intact', () => {
    const md = `# Root

## Section

- only child
`
    const root = parse(md)
    const node = byTopic(root, 'only child')
    const next = removeNodes(md, [node.metadata as NodeMeta])
    expect(next.includes('## Section')).toBe(true)
    expect(next.includes('only child')).toBe(false)
  })

  test('remove a heading and its descendants in one call, next heading takes over', () => {
    const root = parse(WELCOME)
    const node = byTopic(root, 'Markdown features')
    const meta = { ...(node.metadata as NodeMeta), endLine: blockEnd(node) }
    const next = removeNodes(WELCOME, [meta])
    expect(next.includes('## Markdown features')).toBe(false)
    expect(next.includes('### Inline formatting')).toBe(false)
    expect(next.includes('### Folding')).toBe(false)
    // next H2 still present
    expect(next.includes('## Mindmap shortcuts')).toBe(true)
  })
})

describe('insertChild flavors', () => {
  test('root has no children — addChild appends a heading without throwing', () => {
    const md = `# title only
`
    const root = parse(md)
    const parentMeta = root.metadata as NodeMeta
    const next = insertChild(md, parentMeta, blockEnd(root), 'newchild', true, undefined)
    const lines = next.split('\n').filter((l) => l.length > 0)
    // Should append an H2 (child of H1) at end
    expect(lines[lines.length - 1]).toBe('## newchild')
  })

  test('parent is folded — adding a child preserves fold suffix on parent line', () => {
    const md = `# Root

## Folded <!-- markmap: fold -->

- existing child
`
    const root = parse(md)
    const parent = byTopic(root, 'Folded')
    const parentMeta = parent.metadata as NodeMeta
    const firstChild = parent.children?.[0]
    const next = insertChild(
      md,
      parentMeta,
      blockEnd(parent),
      'extra',
      false,
      firstChild?.metadata as NodeMeta | undefined
    )
    const lines = next.split('\n')
    // parent line still has fold marker exactly once
    const parentLine = lines[parentMeta.startLine]
    expect(parentLine.includes('<!-- markmap: fold -->')).toBe(true)
    const occurrences = (parentLine.match(/<!--\s*markmap:\s*fold\s*-->/g) ?? []).length
    expect(occurrences).toBe(1)
    // new child appears
    expect(lines.some((l) => l === '- extra')).toBe(true)
  })

  test('sibling reference uses ordered marker — new child gets ordered marker too', () => {
    const md = `# Root

## Lists

- group
  1. one
  2. two
`
    const root = parse(md)
    const parent = byTopic(root, 'group')
    const parentMeta = parent.metadata as NodeMeta
    const firstChild = parent.children?.[0]
    const next = insertChild(
      md,
      parentMeta,
      blockEnd(parent),
      'three',
      true,
      firstChild?.metadata as NodeMeta | undefined
    )
    const lines = next.split('\n')
    const idx = lines.findIndex((l) => l.includes('three'))
    // Should use ordered marker `1.` or `2.` (same family) and indent 2
    expect(lines[idx]).toMatch(/^ {2}\d+[.)] three$/)
  })
})

describe('insertSibling edge cases', () => {
  test('insert before a folded heading — fold suffix stays on original line only', () => {
    const md = `# Root

## Welcome <!-- markmap: fold -->

- item
`
    const root = parse(md)
    const ref = byTopic(root, 'Welcome')
    const refMeta = ref.metadata as NodeMeta
    const next = insertSibling(md, refMeta, 'before', 'Intro', blockEnd(ref))
    const lines = next.split('\n')
    const introIdx = lines.findIndex((l) => l === '## Intro')
    expect(introIdx).toBeGreaterThan(0)
    // The new sibling line has no fold suffix
    expect(lines[introIdx].includes('<!-- markmap: fold -->')).toBe(false)
    // The original "Welcome" line still has fold suffix
    expect(lines.some((l) => l === '## Welcome <!-- markmap: fold -->')).toBe(true)
  })

  test('insert after last child of root — appears at end of markdown', () => {
    const root = parse(WELCOME)
    const lastChild = root.children?.[root.children.length - 1]
    if (!lastChild) throw new Error('root has no children')
    const refMeta = lastChild.metadata as NodeMeta
    const next = insertSibling(
      WELCOME,
      refMeta,
      'after',
      'Final',
      blockEnd(lastChild)
    )
    const lines = next.split('\n').filter((l) => l.length > 0)
    // last meaningful line should be the new sibling (heading at same level)
    expect(lines[lines.length - 1]).toBe('## Final')
  })

  test('insert sibling of an ordered-list item keeps indent and preserves ordered marker', () => {
    const md = `# Root

## Lists

1. one
2. two
`
    const root = parse(md)
    const ref = byTopic(root, 'one')
    const refMeta = ref.metadata as NodeMeta
    const next = insertSibling(md, refMeta, 'after', 'one-and-a-half', blockEnd(ref))
    const lines = next.split('\n')
    const newIdx = lines.findIndex((l) => l.includes('one-and-a-half'))
    expect(newIdx).toBeGreaterThan(0)
    expect(lines[newIdx].startsWith(' '.repeat(refMeta.indent ?? 0))).toBe(true)
    expect(lines[newIdx]).toMatch(/^\d+[.)] one-and-a-half$/)
  })
})

describe('insertParent edge cases', () => {
  test('wrap a node already at H6 — descendant H6 stays clamped at H6', () => {
    const md = `# Root

## A

### B

#### C

##### D

###### E
`
    const root = parse(md)
    const target = byTopic(root, 'D')
    const meta = target.metadata as NodeMeta
    const next = insertParent(md, meta, blockEnd(target), 'Wrapper')
    const lines = next.split('\n')
    // Wrapper should be at level 5 (same as D)
    expect(lines.some((l) => l === '##### Wrapper')).toBe(true)
    // D would bump to ###### (level 6)
    expect(lines.some((l) => l === '###### D')).toBe(true)
    // E was already ###### — must stay ###### (clamp)
    expect(lines.filter((l) => l === '###### E').length).toBe(1)
    // Must NOT produce a fake "####### E" (7 hashes)
    expect(lines.some((l) => l.startsWith('####### '))).toBe(false)
  })

  test('wrap a list item with nested list — every nested level gets +2 indent', () => {
    const md = `# Root

## Section

- top
  - mid
    - leaf
`
    const root = parse(md)
    const target = byTopic(root, 'top')
    const meta = target.metadata as NodeMeta
    const next = insertParent(md, meta, blockEnd(target), 'Group')
    const lines = next.split('\n')
    const idx = lines.findIndex((l) => l === '- Group')
    expect(idx).toBeGreaterThan(0)
    expect(lines[idx + 1]).toBe('  - top')
    expect(lines[idx + 2]).toBe('    - mid')
    expect(lines[idx + 3]).toBe('      - leaf')
  })

  test('wrap a heading whose section contains a code block — code block stays intact', () => {
    const md = `# Root

## Section

\`\`\`js
const x = 1
function f() {
  return x
}
\`\`\`
`
    const root = parse(md)
    const target = byTopic(root, 'Section')
    const meta = target.metadata as NodeMeta
    const next = insertParent(md, meta, blockEnd(target), 'Wrapper')
    // Code block content must appear verbatim
    expect(next.includes('```js')).toBe(true)
    expect(next.includes('const x = 1')).toBe(true)
    expect(next.includes('function f() {')).toBe(true)
    expect(next.includes('  return x')).toBe(true)
    expect(next.includes('```')).toBe(true)
  })
})

describe('moveBlock / move ops — kind × kind', () => {
  test('heading → heading at same level, position before — no level bump', () => {
    const md = `# Root

## A

text-a

## B

text-b
`
    const root = parse(md)
    const from = byTopic(root, 'B')
    const to = byTopic(root, 'A')
    const fromMeta = { ...(from.metadata as NodeMeta), endLine: blockEnd(from) }
    const toMeta = to.metadata as NodeMeta
    const next = moveBlock(md, fromMeta, 0, null, toMeta.startLine, {
      headingBump: 0,
    })
    const lines = next.split('\n')
    // B should now precede A and stay as H2
    const bIdx = lines.findIndex((l) => l === '## B')
    const aIdx = lines.findIndex((l) => l === '## A')
    expect(bIdx).toBeGreaterThanOrEqual(0)
    expect(aIdx).toBeGreaterThan(bIdx)
  })

  test('heading H3 → heading H2 with heading children — explicit headingBump of +0 keeps H3', () => {
    const md = `# Root

## Outer

### existing-child

## Source

### Source.child
`
    const root = parse(md)
    const from = byTopic(root, 'Source')
    const to = byTopic(root, 'Outer')
    const fromMeta = { ...(from.metadata as NodeMeta), endLine: blockEnd(from) }
    const toEnd = blockEnd(to)
    // wanted bump = (to.level + 1) - from.level = (2 + 1) - 2 = +1 — Source becomes H3
    const next = moveBlock(md, fromMeta, 0, null, toEnd + 1, {
      headingBump: ((to.metadata as NodeMeta).level ?? 2) + 1 - ((from.metadata as NodeMeta).level ?? 2),
    })
    const lines = next.split('\n')
    expect(lines.some((l) => l === '### Source')).toBe(true)
    // child of Source bumps from H3 -> H4
    expect(lines.some((l) => l === '#### Source.child')).toBe(true)
  })

  test('heading H3 → list item — convertHeadingToList nests headings with depth-aware indent', () => {
    const md = `# Root

## Section

- target

## Holder

### Source

#### Sub
`
    const root = parse(md)
    const from = byTopic(root, 'Source')
    const to = byTopic(root, 'target')
    const fromMeta = { ...(from.metadata as NodeMeta), endLine: blockEnd(from) }
    const toEnd = blockEnd(to)
    const next = moveBlock(md, fromMeta, ((to.metadata as NodeMeta).indent ?? 0) + 2, null, toEnd + 1, {
      convertHeadingToList: true,
    })
    const lines = next.split('\n')
    // Source becomes a list item at target.indent+2 == 2
    expect(lines.some((l) => l === '  - Source')).toBe(true)
    // Sub (was H4 = Source.level+1) gets one extra +2 indent
    expect(lines.some((l) => l === '    - Sub')).toBe(true)
  })

  test('list-item → list-item — bump indent by +2', () => {
    const md = `# Root

## Section

- target
- source
`
    const root = parse(md)
    const from = byTopic(root, 'source')
    const to = byTopic(root, 'target')
    const fromMeta = { ...(from.metadata as NodeMeta), endLine: blockEnd(from) }
    const toEnd = blockEnd(to)
    const next = moveBlock(md, fromMeta, ((to.metadata as NodeMeta).indent ?? 0) + 2, null, toEnd + 1)
    const lines = next.split('\n')
    expect(lines.some((l) => l === '  - source')).toBe(true)
    // target still at indent 0
    expect(lines.some((l) => l === '- target')).toBe(true)
  })

  test('list-item → list-item with deep children — children retain depth offset', () => {
    const md = `# Root

## Section

- target
- source
  - mid
    - leaf
`
    const root = parse(md)
    const from = byTopic(root, 'source')
    const to = byTopic(root, 'target')
    const fromMeta = { ...(from.metadata as NodeMeta), endLine: blockEnd(from) }
    const toEnd = blockEnd(to)
    const next = moveBlock(md, fromMeta, ((to.metadata as NodeMeta).indent ?? 0) + 2, null, toEnd + 1)
    const lines = next.split('\n')
    // source +2 indent, children of source keep their relative depth
    expect(lines.some((l) => l === '  - source')).toBe(true)
    expect(lines.some((l) => l === '    - mid')).toBe(true)
    expect(lines.some((l) => l === '      - leaf')).toBe(true)
  })

  test('list-item → heading sibling after (moveOut) — heading marker reapplied, nested list flattens', () => {
    const md = `# Root

## Mindmap shortcuts

### Editing

- \`Tab\` — add child
- Navigation
  - Arrow keys — move to nearest
  - \`Shift\` + Arrows — extend selection
`
    const root = parse(md)
    const navigation = byTopic(root, 'Navigation')
    const editing = byTopic(root, 'Editing')
    const fromMeta = { ...(navigation.metadata as NodeMeta), endLine: blockEnd(navigation) }
    const editingMeta = editing.metadata as NodeMeta
    const next = moveBlock(
      md,
      fromMeta,
      0,
      editingMeta.marker ?? '### ',
      blockEnd(editing) + 1,
      { convertListToHeading: true }
    )
    const lines = next.split('\n')
    // Navigation now a heading at level of Editing
    expect(lines.some((l) => l === '### Navigation')).toBe(true)
    // Children of the original `- Navigation` flatten to indent 0
    expect(lines.some((l) => l === '- Arrow keys — move to nearest')).toBe(true)
    expect(lines.some((l) => l === '- `Shift` + Arrows — extend selection')).toBe(true)
    // No leftover indented `  - Arrow keys`
    expect(lines.some((l) => l.startsWith('  - Arrow keys'))).toBe(false)
  })
})

describe('setFold idempotency', () => {
  test('calling setFold(true) twice does not duplicate the comment', () => {
    const root = parse(WELCOME)
    const node = byTopic(root, 'Folding')
    const meta = node.metadata as NodeMeta
    const once = setFold(WELCOME, meta, true)
    const twice = setFold(once, meta, true)
    expect(twice).toBe(once)
    const line = twice.split('\n')[meta.startLine]
    const occurrences = (line.match(/<!--\s*markmap:\s*fold\s*-->/g) ?? []).length
    expect(occurrences).toBe(1)
  })

  test('calling setFold(false) on an unfolded line is a no-op', () => {
    const root = parse(WELCOME)
    const node = byTopic(root, 'Folding')
    const meta = node.metadata as NodeMeta
    const same = setFold(WELCOME, meta, false)
    expect(same).toBe(WELCOME)
  })

  test('setFold adds suffix correctly when body has inline code', () => {
    const md = `# Root

## Section

- item with \`inline code\` here
`
    const root = parse(md)
    const node = byTopic(root, 'item with `inline code` here')
    const meta = node.metadata as NodeMeta
    const next = setFold(md, meta, true)
    const line = next.split('\n')[meta.startLine]
    expect(line.endsWith('<!-- markmap: fold -->')).toBe(true)
    // Inline code stays intact
    expect(line.includes('`inline code`')).toBe(true)
    // Only one fold marker
    const occurrences = (line.match(/<!--\s*markmap:\s*fold\s*-->/g) ?? []).length
    expect(occurrences).toBe(1)
  })
})

describe('insertSubtree (copy) variants', () => {
  test('copy a list item with multi-level descendants — all levels appear at correct indents', () => {
    const md = `# Root

## Section

- alpha
  - beta
    - gamma
- target
`
    const root = parse(md)
    const src = byTopic(root, 'alpha')
    // Build NodeLike preserving children topics
    function clone(n: NodeObj): { topic: string; children: ReturnType<typeof clone>[] } {
      return {
        topic: n.topic ?? '',
        children: (n.children ?? []).map((c) => clone(c)),
      }
    }
    const cloned = clone(src)
    const target = byTopic(root, 'target')
    const parentMeta = target.metadata as NodeMeta
    const next = insertSubtree(md, parentMeta, blockEnd(target), cloned, true, undefined)
    const lines = next.split('\n')
    // The copy should land as a child of `target`, so base indent = 2
    const aIdx = lines.findIndex((l, i) => l === '  - alpha' && i > 0 && lines.indexOf('- target') < i)
    expect(aIdx).toBeGreaterThan(0)
    expect(lines[aIdx + 1]).toBe('    - beta')
    expect(lines[aIdx + 2]).toBe('      - gamma')
  })

  test('copy a heading subtree under a list-context parent — heading becomes list item', () => {
    const md = `# Root

## Outer

### SourceHeading

#### SourceSub

## Bucket

- target
`
    const root = parse(md)
    const src = byTopic(root, 'SourceHeading')
    function clone(n: NodeObj): { topic: string; children: ReturnType<typeof clone>[] } {
      return {
        topic: n.topic ?? '',
        children: (n.children ?? []).map((c) => clone(c)),
      }
    }
    const cloned = clone(src)
    const target = byTopic(root, 'target')
    const parentMeta = target.metadata as NodeMeta
    const next = insertSubtree(md, parentMeta, blockEnd(target), cloned, true, undefined)
    const lines = next.split('\n')
    // Inside list context, even the formerly-heading SourceHeading becomes a list item
    // at parent.indent+2 = 2
    expect(lines.some((l) => l === '  - SourceHeading')).toBe(true)
    // Nested SourceSub becomes deeper list item at 4 spaces
    expect(lines.some((l) => l === '    - SourceSub')).toBe(true)
    // No new headings introduced
    expect(lines.some((l) => l === '### SourceHeading' && lines.lastIndexOf('### SourceHeading') > lines.indexOf('- target'))).toBe(false)
  })

  test('copy preserves fold suffix on nodes that had expanded:false', () => {
    const md = `# Root

## Section

- target
`
    const root = parse(md)
    const target = byTopic(root, 'target')
    const parentMeta = target.metadata as NodeMeta
    const cloned = {
      topic: 'copied',
      expanded: false,
      children: [{ topic: 'inner', expanded: false, children: [] }],
    }
    const next = insertSubtree(md, parentMeta, blockEnd(target), cloned, true, undefined)
    const lines = next.split('\n')
    // The copy should include `- copied <!-- markmap: fold -->`
    expect(lines.some((l) => l === '  - copied <!-- markmap: fold -->')).toBe(true)
    expect(lines.some((l) => l === '    - inner <!-- markmap: fold -->')).toBe(true)
  })
})
