import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'

const app = createApp(App)
app.config.errorHandler = (err, _instance, info) => {
  console.error('[stackmind] vue error', info, err)
}
window.addEventListener('error', (e) => {
  console.error('[stackmind] window error', e.error ?? e.message)
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('[stackmind] unhandled rejection', e.reason)
})
app.use(createPinia())
app.mount('#app')
