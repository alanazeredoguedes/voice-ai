import { createApp } from 'vue'
import { createPinia } from 'pinia'
import Overlay from './overlay/Overlay.vue'
import './style.css'
import { connect } from './api/ws'

const pinia = createPinia()
const app = createApp(Overlay)
app.use(pinia)
app.mount('#overlay-app')

connect()
