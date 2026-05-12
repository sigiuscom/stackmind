<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, undo, redo } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'
import { useDocumentStore } from '@/stores/document'

const store = useDocumentStore()
const host = ref<HTMLDivElement | null>(null)
let view: EditorView | null = null
let suppress = false
const themeCompartment = new Compartment()

function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? oneDark : []
}

function createView(initial: string) {
  if (!host.value) return
  const state = EditorState.create({
    doc: initial,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      history(),
      bracketMatching(),
      markdown(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      themeCompartment.of(currentTheme()),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (!view) return
        if (update.docChanged && !suppress) {
          store.setMarkdown(update.state.doc.toString())
        }
        if (update.selectionSet || update.docChanged) {
          const line = update.state.doc.lineAt(update.state.selection.main.head).number - 1
          if (!suppress && line !== store.cursorLine) {
            store.setCursorLine(line, 'editor')
          }
        }
      }),
    ],
  })
  view = new EditorView({ state, parent: host.value })
  store.registerHistory(
    () => (view ? undo({ state: view.state, dispatch: view.dispatch.bind(view) }) : false),
    () => (view ? redo({ state: view.state, dispatch: view.dispatch.bind(view) }) : false)
  )
}

onMounted(() => createView(store.markdown))
onBeforeUnmount(() => view?.destroy())

watch(
  () => store.markdown,
  (next) => {
    if (!view) return
    const current = view.state.doc.toString()
    if (current === next) return
    suppress = true
    view.dispatch({ changes: { from: 0, to: current.length, insert: next } })
    suppress = false
  }
)

let themeObserver: MutationObserver | null = null
onMounted(() => {
  themeObserver = new MutationObserver(() => {
    if (!view) return
    view.dispatch({ effects: themeCompartment.reconfigure(currentTheme()) })
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
})
onBeforeUnmount(() => {
  themeObserver?.disconnect()
  themeObserver = null
})

watch(
  () => store.cursorLine,
  (line) => {
    if (!view) return
    if (store.cursorSource === 'editor') return
    if (line < 0 || line >= view.state.doc.lines) return
    const lineInfo = view.state.doc.line(line + 1)
    suppress = true
    view.dispatch({
      selection: { anchor: lineInfo.from, head: lineInfo.from },
      effects: EditorView.scrollIntoView(lineInfo.from, { y: 'center' }),
    })
    suppress = false
  }
)
</script>

<template>
  <div ref="host" class="editor"></div>
</template>

<style>
.editor {
  height: 100%;
  overflow: hidden;
}
.editor .cm-editor {
  height: 100%;
  font-size: 14px;
}
.editor .cm-scroller {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.editor .cm-activeLine {
  background: var(--active-line);
}
.editor .cm-activeLineGutter {
  background: var(--active-line-gutter);
}
html[data-theme='dark'] .editor .cm-activeLine {
  background: var(--active-line);
}
</style>
