<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watchEffect } from 'vue'
import Toolbar from '@/components/Toolbar.vue'
import Editor from '@/components/Editor.vue'
import MindMap from '@/components/MindMap.vue'
import { useDocumentStore } from '@/stores/document'

const store = useDocumentStore()
const appRef = ref<HTMLDivElement | null>(null)

const systemDark = ref(false)
const mq = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null
const onMqChange = (e: MediaQueryListEvent) => {
  systemDark.value = e.matches
}
onMounted(() => {
  if (mq) {
    systemDark.value = mq.matches
    mq.addEventListener('change', onMqChange)
  }
})
onBeforeUnmount(() => {
  mq?.removeEventListener('change', onMqChange)
})

const effectiveTheme = computed<'light' | 'dark'>(() => {
  if (store.theme === 'light') return 'light'
  if (store.theme === 'dark') return 'dark'
  return systemDark.value ? 'dark' : 'light'
})

watchEffect(() => {
  document.documentElement.dataset.theme = effectiveTheme.value
})

const rootClass = computed(() => `app app--${store.viewMode}`)
const editorStyle = computed(() => {
  if (store.viewMode === 'mindmap') return { display: 'none' }
  if (store.viewMode === 'editor') return { flex: '1 1 0' }
  return { flex: `${store.splitRatio} 1 0` }
})
const mindmapStyle = computed(() => {
  if (store.viewMode === 'editor') return { display: 'none' }
  if (store.viewMode === 'mindmap') return { flex: '1 1 0' }
  return { flex: `${1 - store.splitRatio} 1 0` }
})
const dividerHidden = computed(() => store.viewMode !== 'split')

let dragStartX = 0
let dragStartRatio = 0
let availableWidth = 0

function onDragStart(e: PointerEvent) {
  if (store.viewMode !== 'split') return
  if (!appRef.value) return
  const toolbarWidth = appRef.value.querySelector<HTMLElement>('.toolbar')?.offsetWidth ?? 0
  availableWidth = appRef.value.clientWidth - toolbarWidth
  if (availableWidth <= 0) return
  dragStartX = e.clientX
  dragStartRatio = store.splitRatio
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

function onDragMove(e: PointerEvent) {
  if (!availableWidth) return
  const dx = e.clientX - dragStartX
  store.setSplitRatio(dragStartRatio + dx / availableWidth)
}

function onDragEnd(e: PointerEvent) {
  if (!availableWidth) return
  availableWidth = 0
  ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}
</script>

<template>
  <div ref="appRef" :class="rootClass">
    <div v-if="store.errorMessage" class="app__toast" @click="store.setError(null)">
      <span>{{ store.errorMessage }}</span>
      <button type="button" class="app__toast-close" aria-label="Dismiss">×</button>
    </div>
    <div class="app__editor" :style="editorStyle"><Editor /></div>
    <div
      v-if="!dividerHidden"
      class="app__divider"
      @pointerdown="onDragStart"
      @pointermove="onDragMove"
      @pointerup="onDragEnd"
      @pointercancel="onDragEnd"
    ></div>
    <div class="app__mindmap" :style="mindmapStyle"><MindMap /></div>
    <Toolbar />
  </div>
</template>

<style>
:root {
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  color-scheme: light;
  --bg: #ffffff;
  --fg: #222222;
  --toolbar-bg: #f5f5f5;
  --toolbar-border: #e0e0e0;
  --toolbar-icon: #555;
  --toolbar-icon-hover: #222;
  --toolbar-hover: #e6e6e6;
  --toolbar-active: #1976d2;
  --toolbar-active-bg: #e3f2fd;
  --divider-bg: #e0e0e0;
  --divider-hover: #1976d2;
  --mindmap-bg: #fafafa;
  --active-line: #e3f2fd;
  --active-line-gutter: #bbdefb;
}
html[data-theme='dark'] {
  color-scheme: dark;
  --bg: #1e1e1e;
  --fg: #d4d4d4;
  --toolbar-bg: #252526;
  --toolbar-border: #333;
  --toolbar-icon: #b0b0b0;
  --toolbar-icon-hover: #fff;
  --toolbar-hover: #333;
  --toolbar-active: #64b5f6;
  --toolbar-active-bg: #1c3a52;
  --divider-bg: #333;
  --divider-hover: #64b5f6;
  --mindmap-bg: #1e1e1e;
  --active-line: #1a2a4a;
  --active-line-gutter: #25406b;
}
html, body, #app {
  margin: 0;
  padding: 0;
  height: 100%;
  width: 100%;
  overflow: hidden;
  background: var(--bg);
  color: var(--fg);
}
.app {
  display: flex;
  flex-direction: row;
  height: 100vh;
  width: 100vw;
}
.app__editor,
.app__mindmap {
  min-width: 0;
  height: 100%;
  overflow: hidden;
}
.app__toast {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  background: #c62828;
  color: #fff;
  padding: 10px 16px 10px 18px;
  border-radius: 6px;
  font-size: 13px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  display: flex;
  align-items: center;
  gap: 12px;
  z-index: 1000;
  cursor: pointer;
  max-width: 80vw;
}
.app__toast-close {
  background: transparent;
  border: none;
  color: #fff;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}
.app__divider {
  flex: 0 0 6px;
  background: var(--divider-bg);
  cursor: col-resize;
  position: relative;
  transition: background 120ms;
}
.app__divider:hover,
.app__divider:active {
  background: var(--divider-hover);
}
</style>
