<script setup lang="ts">
import { useDocumentStore } from '@/stores/document'
import type { Theme, ViewMode } from '@/stores/document'

const store = useDocumentStore()

const modes: { value: ViewMode; label: string }[] = [
  { value: 'mindmap', label: 'Mindmap only' },
  { value: 'split', label: 'Split view' },
  { value: 'editor', label: 'Markdown only' },
]

const themeCycle: Record<Theme, Theme> = {
  auto: 'light',
  light: 'dark',
  dark: 'auto',
}
function cycleTheme() {
  store.setTheme(themeCycle[store.theme])
}
</script>

<template>
  <nav class="toolbar" aria-label="View mode">
    <div class="toolbar__top">
      <button
        v-for="m in modes"
        :key="m.value"
        type="button"
        class="toolbar__btn"
        :class="{ 'toolbar__btn--active': store.viewMode === m.value }"
        :title="m.label"
        :aria-pressed="store.viewMode === m.value"
        @click="store.setViewMode(m.value)"
      >
        <svg v-if="m.value === 'editor'" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="9 18 3 12 9 6" />
          <polyline points="15 6 21 12 15 18" />
        </svg>
        <svg v-else-if="m.value === 'split'" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5" />
          <line x1="12" y1="4" x2="12" y2="20" stroke="currentColor" stroke-width="1.5" />
        </svg>
        <svg v-else viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="1.5" />
          <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.5" />
        </svg>
      </button>
    </div>
    <div class="toolbar__bottom">
      <button
        type="button"
        class="toolbar__btn"
        :title="`Theme: ${store.theme}`"
        @click="cycleTheme"
      >
        <svg v-if="store.theme === 'light'" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
        <svg v-else-if="store.theme === 'dark'" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79Z" />
        </svg>
        <svg v-else viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3 A9 9 0 0 0 12 21 Z" fill="currentColor" stroke="none" />
        </svg>
      </button>
      <a
        class="toolbar__btn"
        href="https://github.com/kvaps/stackmind"
        target="_blank"
        rel="noopener noreferrer"
        title="View on GitHub"
        aria-label="View on GitHub"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">
          <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.57.1.78-.25.78-.55v-2.13c-3.2.7-3.87-1.36-3.87-1.36-.52-1.34-1.27-1.69-1.27-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.76 2.68 1.25 3.34.96.1-.74.4-1.25.72-1.54-2.55-.29-5.23-1.28-5.23-5.7 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18.92-.26 1.91-.39 2.9-.39s1.98.13 2.9.39c2.21-1.49 3.18-1.18 3.18-1.18.62 1.58.23 2.75.11 3.04.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.41-5.25 5.69.41.36.78 1.07.78 2.16v3.21c0 .31.21.66.79.55C20.21 21.38 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z"/>
        </svg>
      </a>
    </div>
  </nav>
</template>

<style>
.toolbar {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 12px 6px;
  background: var(--toolbar-bg, #f5f5f5);
  border-left: 1px solid var(--toolbar-border, #e0e0e0);
}
.toolbar__top, .toolbar__bottom {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.toolbar__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--toolbar-icon, #555);
  border-radius: 4px;
  cursor: pointer;
  text-decoration: none;
  transition: background 120ms, color 120ms;
}
.toolbar__btn:hover {
  background: var(--toolbar-hover, #e6e6e6);
  color: var(--toolbar-icon-hover, #222);
}
.toolbar__btn--active {
  color: var(--toolbar-active, #1976d2);
  background: var(--toolbar-active-bg, #e3f2fd);
}
</style>
