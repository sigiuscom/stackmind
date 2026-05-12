import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export type ViewMode = 'editor' | 'split' | 'mindmap'
export type Theme = 'light' | 'dark' | 'auto'

const STORAGE_KEY = 'stackmind:document'
const DEFAULT_MARKDOWN = `# stackmind

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

interface PersistedState {
  markdown: string
  viewMode: ViewMode
  splitRatio: number
  theme: Theme
}

function load(): PersistedState {
  const defaults: PersistedState = {
    markdown: DEFAULT_MARKDOWN,
    viewMode: 'split',
    splitRatio: 0.5,
    theme: 'auto',
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    return {
      markdown: parsed.markdown ?? defaults.markdown,
      viewMode: parsed.viewMode ?? defaults.viewMode,
      splitRatio: typeof parsed.splitRatio === 'number' ? parsed.splitRatio : defaults.splitRatio,
      theme: parsed.theme ?? defaults.theme,
    }
  } catch {
    return defaults
  }
}

export const useDocumentStore = defineStore('document', () => {
  const initial = load()
  const markdown = ref(initial.markdown)
  const viewMode = ref<ViewMode>(initial.viewMode)
  const splitRatio = ref(initial.splitRatio)
  const theme = ref<Theme>(initial.theme)
  const cursorLine = ref(0)
  const cursorSource = ref<'editor' | 'mindmap' | null>(null)
  const undoHandler = ref<(() => boolean) | null>(null)
  const redoHandler = ref<(() => boolean) | null>(null)

  watch(
    [markdown, viewMode, splitRatio, theme],
    ([md, mode, ratio, th]) => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ markdown: md, viewMode: mode, splitRatio: ratio, theme: th })
      )
    },
    { flush: 'post' }
  )

  function setMarkdown(value: string) {
    if (markdown.value !== value) markdown.value = value
  }

  function setViewMode(mode: ViewMode) {
    viewMode.value = mode
  }

  function setSplitRatio(value: number) {
    splitRatio.value = Math.min(0.9, Math.max(0.1, value))
  }

  function setTheme(value: Theme) {
    theme.value = value
  }

  function setCursorLine(line: number, source: 'editor' | 'mindmap') {
    cursorLine.value = line
    cursorSource.value = source
  }

  function registerHistory(undoFn: () => boolean, redoFn: () => boolean) {
    undoHandler.value = undoFn
    redoHandler.value = redoFn
  }

  function undo() {
    return undoHandler.value?.() ?? false
  }
  function redo() {
    return redoHandler.value?.() ?? false
  }

  return {
    markdown,
    viewMode,
    splitRatio,
    theme,
    cursorLine,
    cursorSource,
    setMarkdown,
    setViewMode,
    setSplitRatio,
    setTheme,
    setCursorLine,
    registerHistory,
    undo,
    redo,
  }
})
