// App instalado usa a porta 18450; o dev usa 18451, para os dois poderem rodar ao mesmo tempo
// sem um usar o backend do outro.
export const BACKEND_PORT = import.meta.env.DEV ? 18451 : 18450
export const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`
