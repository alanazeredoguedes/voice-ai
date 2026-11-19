import { createApp } from 'vue'
import { createPinia } from 'pinia'
import Overlay from './overlay/Overlay.vue'
import './style.css'
import { connect } from './api/ws'
import { errText, installErrorHandlers, setSyslogSource, syslog } from './utils/syslog'

setSyslogSource('overlay')
installErrorHandlers()

const pinia = createPinia()
const app = createApp(Overlay)
app.use(pinia)
app.config.errorHandler = (err, _inst, info) => syslog('error', 'erro', `erro no indicador (${info}): ${errText(err)}`)
app.mount('#overlay-app')
syslog('info', 'overlay', 'indicador (overlay) carregado')

connect()
