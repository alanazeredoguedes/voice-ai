# Arquitetura Base — Electron + Vue + FastAPI

> Documento extraído do projeto Monuv Onvif LAB.  
> Use como blueprint para novos projetos desktop com backend Python.

---

## 1. Stack Técnica

| Camada | Tecnologia | Versão |
|--------|-----------|--------|
| **Desktop shell** | Electron | 39 |
| **Build tool** | electron-vite | 5 |
| **UI framework** | Vue 3 + TypeScript | — |
| **Estilização** | Tailwind CSS | 3 |
| **Estado** | Pinia | 4 |
| **HTTP client** | Axios | 1.20 |
| **Backend** | FastAPI + uvicorn | 0.115 / 0.30 |
| **Banco** | SQLite (aiosqlite) | async |
| **Validação** | Pydantic | v2 |
| **Build distribuição** | electron-builder | — |

---

## 2. Estrutura de Diretórios

```
projeto/
├── frontend/                        # Tudo do Electron + Vue
│   ├── src/
│   │   ├── main/
│   │   │   └── index.ts             # Electron main process (spawn Python, tray, janela)
│   │   ├── preload/
│   │   │   ├── index.ts             # contextBridge (IPC bridge)
│   │   │   └── index.d.ts           # Tipos do window.api exposto
│   │   └── renderer/
│   │       ├── index.html           # HTML base (CSP headers aqui)
│   │       └── src/
│   │           ├── main.ts          # Bootstrap: createApp + Pinia + mount
│   │           ├── App.vue          # Root: layout + navegação entre views
│   │           ├── api/
│   │           │   └── index.ts     # Axios config + todos os endpoints
│   │           ├── stores/
│   │           │   └── <recurso>.ts # Pinia store por domínio
│   │           ├── types/
│   │           │   └── index.ts     # Interfaces TypeScript centralizadas
│   │           └── components/      # Componentes Vue por feature
│   │
│   ├── build/                       # Assets de build
│   │   ├── icon.png                 # 512×512 px — fonte para todos os ícones
│   │   ├── icon.ico                 # Windows (gerado pelo electron-builder)
│   │   ├── icon.icns                # macOS (gerado pelo electron-builder)
│   │   └── entitlements.mac.plist   # Permissões macOS (câmera, mic, etc.)
│   ├── resources/                   # Recursos extras (ex: FFmpeg binário)
│   ├── scripts/
│   │   └── after-build.js           # Script pós-build (ex: wrapper .sh para AppImage)
│   ├── electron.vite.config.ts      # Config Vite (proxy dev, aliases)
│   ├── electron-builder.yml         # Config build por plataforma
│   ├── tsconfig.json                # Composite TypeScript root
│   ├── tsconfig.node.json           # TS para main + preload (Node target)
│   ├── tsconfig.web.json            # TS para renderer (browser target)
│   └── package.json
│
├── backend/                         # FastAPI Python
│   ├── main.py                      # App FastAPI: CORS, lifespan, routers
│   ├── database.py                  # Init SQLite, get_db(), write_log()
│   ├── models.py                    # Pydantic schemas (In/Out por domínio)
│   ├── routes/
│   │   ├── <recurso>.py             # Router por domínio (CRUD)
│   │   ├── <acao>.py                # Router de ações (operações complexas)
│   │   └── logs.py                  # GET/POST/DELETE /logs
│   ├── services/
│   │   └── <servico>.py             # Lógica de negócio isolada
│   ├── requirements.txt
│   └── cameras.db                   # SQLite (criado automaticamente)
│
└── builds/                          # Output dos builds (gerado pelo electron-builder)
```

---

## 3. Electron Main Process

**Arquivo:** `frontend/src/main/index.ts`

### 3.1 Ciclo de vida completo

```typescript
app.whenReady()
  ├─ [produção] freePort(PORTA)          // mata processo na porta com fuser -k
  ├─ [produção] startPython()            // spawn binário de resources/
  ├─ [dev]      waitForBackend()         // assume backend já rodando (dev.sh)
  ├─ createWindow()
  └─ createTray()

app.on('before-quit')
  └─ pythonProcess.kill()               // derruba backend junto com o app

app.on('window-all-closed')
  └─ // vazio — app continua vivo na bandeja do sistema
```

### 3.2 Spawn do Python

```typescript
// DESENVOLVIMENTO — usa venv local
const pythonProcess = spawn(
  '../backend/venv/bin/python',
  ['../backend/main.py'],
  { env: { ...process.env, PORTA_VAR: '18432' } }
)

// PRODUÇÃO — usa binário compilado (PyInstaller) em resources/
const backendBin = path.join(process.resourcesPath, 'backend-server')
const pythonProcess = spawn(backendBin, [], {
  env: {
    ...process.env,
    MEU_APP_DATA_DIR: app.getPath('userData'),   // diretório de dados do usuário
    MEU_APP_EXTRA_PATH: path.join(process.resourcesPath, 'extra-binary')
  }
})
```

### 3.3 Health check com retry

```typescript
async function waitForBackend(maxRetries = 20, intervalMs = 500): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch('http://127.0.0.1:18432/health')
      if (res.ok) return
    } catch {}
    await new Promise(r => setTimeout(r, intervalMs))
  }
  dialog.showErrorBox('Erro', 'Backend não respondeu. Verifique os logs.')
  app.quit()
}
```

### 3.4 Single instance lock (produção)

```typescript
if (!app.isPackaged) {
  // dev: ignora (facilita múltiplas instâncias para teste)
} else {
  const lock = app.requestSingleInstanceLock()
  if (!lock) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      mainWindow?.show()
      mainWindow?.focus()
    })
  }
}
```

### 3.5 Configuração da janela

```typescript
const mainWindow = new BrowserWindow({
  width: 1664,
  height: 936,
  minWidth: 800,
  minHeight: 500,
  show: false,              // não mostra até estar pronto
  autoHideMenuBar: true,
  webPreferences: {
    preload: join(__dirname, '../preload/index.mjs'),
    sandbox: false,         // necessário para child_process no preload
  }
})

mainWindow.once('ready-to-show', () => mainWindow.show())

// Links externos abrem no browser do sistema
mainWindow.webContents.setWindowOpenHandler(({ url }) => {
  shell.openExternal(url)
  return { action: 'deny' }
})
```

---

## 4. System Tray (Minimizar para Bandeja)

```typescript
let isQuitting = false

function createTray() {
  // Ícone 16×16 gerado programaticamente (sem depender de arquivo de ícone separado)
  const iconBuffer = Buffer.from(/* pixel data 16×16 RGBA */)
  const trayIcon = nativeImage.createFromBuffer(iconBuffer, { width: 16, height: 16 })
  const tray = new Tray(trayIcon)

  // Menu contextual
  const menu = Menu.buildFromTemplate([
    {
      label: 'Abrir',
      click: () => { mainWindow?.show(); mainWindow?.focus() }
    },
    {
      label: 'Sair',
      click: () => { isQuitting = true; app.quit() }
    }
  ])
  tray.setContextMenu(menu)

  // Clique simples: toggle visibilidade
  tray.on('click', () => {
    if (mainWindow?.isVisible()) mainWindow.hide()
    else { mainWindow?.show(); mainWindow?.focus() }
  })
}

// Fechar janela → esconde (não sai)
mainWindow.on('close', (event) => {
  if (!isQuitting) {
    event.preventDefault()
    mainWindow?.hide()
  }
})
```

---

## 5. Preload e IPC

**Arquivo:** `frontend/src/preload/index.ts`

```typescript
import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Expõe APIs seguras para o renderer
contextBridge.exposeInMainWorld('electron', electronAPI)

// API customizada (adicione aqui channels específicos do app)
const api = {
  // exemplo: openFile: () => ipcRenderer.invoke('dialog:openFile')
}
contextBridge.exposeInMainWorld('api', api)
```

```typescript
// main/index.ts — handlers no main process
ipcMain.handle('dialog:openFile', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({})
  return canceled ? null : filePaths[0]
})
```

**Decisão arquitetural:** A maioria da comunicação app↔backend usa HTTP REST (não IPC). IPC fica reservado para operações que só o main process pode fazer (diálogos nativos, acesso ao FS, etc.).

---

## 6. Vue App (Renderer)

### 6.1 Bootstrap

```typescript
// src/renderer/src/main.ts
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'

createApp(App)
  .use(createPinia())
  .mount('#app')
```

### 6.2 Navegação sem router

```typescript
// App.vue — navegação simples por ref (sem vue-router)
type View = 'home' | 'dashboard' | 'settings' | 'logs'
const currentView = ref<View>('home')

// No template:
// <HomePage v-if="currentView === 'home'" />
// <DashboardPage v-else-if="currentView === 'dashboard'" />
```

Use `vue-router` quando houver rotas com parâmetros, guards de autenticação ou histórico de navegação. Para 3-6 views sem necessidades complexas, o `ref` é suficiente.

### 6.3 Pinia Store Pattern

```typescript
// stores/items.ts
import { defineStore } from 'pinia'
import { api } from '../api'
import type { Item } from '../types'

export const useItemsStore = defineStore('items', () => {
  const items = ref<Item[]>([])
  const selected = ref<Item | null>(null)
  const loading = ref(false)
  const logs = ref<LogEntry[]>([])     // log local em memória (max 500)

  async function fetchAll() {
    loading.value = true
    try {
      items.value = await api.getItems()
    } finally {
      loading.value = false
    }
  }

  function addLog(level: 'info' | 'success' | 'error', message: string) {
    logs.value.unshift({ timestamp: new Date().toISOString(), level, message })
    if (logs.value.length > 500) logs.value.pop()
  }

  return { items, selected, loading, logs, fetchAll, addLog }
})
```

### 6.4 Axios — detecção automática de ambiente

```typescript
// api/index.ts
import axios from 'axios'

// file:// = produção (Electron carregando arquivo local)
// http:// = dev (Vite dev server com proxy)
const baseURL = window.location.protocol === 'file:'
  ? 'http://127.0.0.1:18432'
  : '/api'                           // Vite proxy redireciona para :18432

const http = axios.create({ baseURL })

export const api = {
  // CRUD
  getItems: () => http.get<Item[]>('/items').then(r => r.data),
  createItem: (body: ItemIn) => http.post<Item>('/items', body).then(r => r.data),
  updateItem: (id: number, body: Partial<ItemIn>) =>
    http.put<Item>(`/items/${id}`, body).then(r => r.data),
  deleteItem: (id: number) => http.delete(`/items/${id}`),

  // Ações específicas
  runAction: (id: number, action: string) =>
    http.post(`/items/${id}/actions/${action}`).then(r => r.data),
}
```

### 6.5 Tipos centralizados

```typescript
// types/index.ts — defina todos os tipos aqui, importe de outros arquivos
export interface Item {
  id: number
  name: string
  host: string
  port: number
  created_at?: string
}

export interface ItemIn {
  name: string
  host: string
  port?: number          // default no backend
}

export interface LogEntry {
  timestamp: string
  level: 'info' | 'success' | 'error'
  message: string
}
```

---

## 7. Build Multi-plataforma

### 7.1 Scripts do package.json

```json
{
  "scripts": {
    "dev": "ELECTRON_DISABLE_SANDBOX=1 electron-vite dev",
    "build": "vue-tsc --noEmit && electron-vite build",
    "build:win": "npm run build && electron-builder --win",
    "build:mac": "npm run build && electron-builder --mac",
    "build:linux": "npm run build && electron-builder --linux",
    "build:appimage": "npm run build && electron-builder --linux AppImage"
  }
}
```

### 7.2 electron-builder.yml

```yaml
appId: com.suaempresa.seu-app
productName: Seu App
directories:
  buildResources: build      # icons, entitlements
  output: ../builds

# Inclui o backend compilado em resources/
extraResources:
  - from: ../backend/dist/backend-server  # binário PyInstaller
    to: backend-server

files:
  - '!**/.vscode'
  - '!src/**'
  - '!*.config.*'
  - '!tsconfig*'
asarUnpack:
  - resources/**             # binários devem ficar fora do asar (precisam ser executáveis)

win:
  executableName: seu-app
  target:
    - target: nsis           # instalador
    - target: portable       # .exe portátil

nsis:
  artifactName: ${productName}-Setup-${version}.${ext}
  createDesktopShortcut: always

linux:
  executableName: seu-app
  category: Utility
  target:
    - target: AppImage
    - target: deb
  maintainer: suaempresa

mac:
  target: dmg
  entitlementsInherit: build/entitlements.mac.plist
  # notarize: false  # descomente para não notarizar em dev

# Script pós-build (opcional) — útil para AppImage no Linux sem libfuse2
afterAllArtifactBuild: scripts/after-build.js
```

### 7.3 Script pós-build para AppImage (`scripts/after-build.js`)

```javascript
// Cria wrapper .sh que usa APPIMAGE_EXTRACT_AND_RUN=1
// Necessário em sistemas sem libfuse2 (Ubuntu 22+ por padrão)
const fs = require('fs')
const path = require('path')

module.exports = async function(buildResult) {
  const appImages = buildResult.artifactPaths.filter(p => p.endsWith('.AppImage'))
  for (const appImage of appImages) {
    const wrapperPath = appImage.replace('.AppImage', '.sh')
    fs.writeFileSync(wrapperPath,
      `#!/bin/bash\nAPPIMAGE_EXTRACT_AND_RUN=1 "${path.basename(appImage)}" "$@"\n`,
      { mode: 0o755 }
    )
  }
}
```

### 7.4 Ícones necessários

```
build/
├── icon.png      # 512×512 px, RGBA — fonte para todas as plataformas
├── icon.ico      # Windows — electron-builder converte automaticamente do .png
└── icon.icns     # macOS — electron-builder converte automaticamente do .png
```

O `electron-builder` converte o `icon.png` para os formatos corretos em cada plataforma. Mantenha sempre o `.png` como fonte de verdade.

### 7.5 electron.vite.config.ts

```typescript
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [vue()],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    server: {
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:18432',
          rewrite: (path) => path.replace(/^\/api/, '')
        }
      }
    }
  }
})
```

---

## 8. Backend FastAPI

### 8.1 Estrutura do app (`main.py`)

```python
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from database import init_db
from routes import items, logs   # importe seus routers aqui

@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()              # cria tabelas na inicialização
    yield
    # cleanup aqui se necessário

app = FastAPI(lifespan=lifespan)

# CORS aberto — seguro porque só localhost acessa
app.add_middleware(CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(items.router)
app.include_router(logs.router)

@app.get("/health")
async def health():
    return {"status": "ok"}

if __name__ == "__main__":
    port = int(os.environ.get("APP_PORT", 18432))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
```

### 8.2 Banco de dados (`database.py`)

```python
import aiosqlite
import os

# Em produção (AppImage/exe), usa diretório de dados passado pelo Electron
# Em dev, usa ./app.db local
def get_db_path() -> str:
    data_dir = os.environ.get("MEU_APP_DATA_DIR")
    if data_dir:
        return os.path.join(data_dir, "app.db")
    return "./app.db"

async def get_db():
    async with aiosqlite.connect(get_db_path()) as db:
        db.row_factory = aiosqlite.Row
        yield db

async def init_db():
    async with aiosqlite.connect(get_db_path()) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                level TEXT DEFAULT 'info',
                category TEXT DEFAULT 'app',
                message TEXT NOT NULL
            )
        """)
        await db.commit()
```

### 8.3 Modelos Pydantic (`models.py`)

```python
from pydantic import BaseModel
from datetime import datetime
from typing import Optional

class ItemIn(BaseModel):
    name: str
    description: str = ""

class ItemOut(BaseModel):
    id: int
    name: str
    description: str
    created_at: Optional[datetime] = None

class LogOut(BaseModel):
    id: int
    timestamp: datetime
    level: str
    category: str
    message: str
```

### 8.4 Padrão de Router (`routes/items.py`)

```python
from fastapi import APIRouter, Depends, HTTPException
from database import get_db
from models import ItemIn, ItemOut

router = APIRouter(prefix="/items", tags=["items"])

@router.get("", response_model=list[ItemOut])
async def list_items(db=Depends(get_db)):
    rows = await db.execute("SELECT * FROM items ORDER BY created_at DESC")
    return await rows.fetchall()

@router.post("", response_model=ItemOut, status_code=201)
async def create_item(body: ItemIn, db=Depends(get_db)):
    cur = await db.execute(
        "INSERT INTO items (name, description) VALUES (?, ?)",
        (body.name, body.description)
    )
    await db.commit()
    row = await (await db.execute("SELECT * FROM items WHERE id=?", (cur.lastrowid,))).fetchone()
    return row

@router.put("/{item_id}", response_model=ItemOut)
async def update_item(item_id: int, body: ItemIn, db=Depends(get_db)):
    await db.execute(
        "UPDATE items SET name=?, description=? WHERE id=?",
        (body.name, body.description, item_id)
    )
    await db.commit()
    row = await (await db.execute("SELECT * FROM items WHERE id=?", (item_id,))).fetchone()
    if not row:
        raise HTTPException(404, "Item não encontrado")
    return row

@router.delete("/{item_id}", status_code=204)
async def delete_item(item_id: int, db=Depends(get_db)):
    await db.execute("DELETE FROM items WHERE id=?", (item_id,))
    await db.commit()
```

### 8.5 Padrão de Ações (operações complexas)

Para operações que não são CRUD simples (ex: conectar em serviço externo, processamento assíncrono):

```python
# routes/actions.py
@router.post("/{item_id}/actions/{action_name}")
async def run_action(item_id: int, action_name: str, db=Depends(get_db)):
    row = await get_item_or_404(item_id, db)
    
    if action_name == "ping":
        result = await my_service.ping(row["host"])
    elif action_name == "fetch-data":
        result = await my_service.fetch_data(row)
    else:
        raise HTTPException(404, f"Ação '{action_name}' não existe")
    
    return result
```

### 8.6 requirements.txt

```
fastapi==0.115.0
uvicorn[standard]==0.30.6
aiosqlite==0.20.0
pydantic==2.9.2
httpx==0.28.1          # HTTP client async (para chamar APIs externas)
```

---

## 9. Fluxo de Dados

```
┌─────────────────────────────────────────────────────────┐
│                    Electron (Desktop)                    │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │                Vue Renderer                       │  │
│  │                                                   │  │
│  │  Component  →  Pinia Store  →  Axios (api/)      │  │
│  │                                    │              │  │
│  │                              file:// → :18432     │  │
│  │                              /api   → proxy Vite  │  │
│  └──────────────────────────────────────────────────┘  │
│                           │                             │
│              [contextBridge — IPC mínimo]               │
│                           │                             │
│  ┌────────────────────────▼─────────────────────────┐  │
│  │              Electron Main Process                │  │
│  │                                                   │  │
│  │  spawn() → Python Backend                        │  │
│  │  Tray, Dialog, FS (via IPC handlers)             │  │
│  └────────────────────────┬─────────────────────────┘  │
└───────────────────────────┼─────────────────────────────┘
                            │ HTTP REST :18432
          ┌─────────────────▼────────────────────┐
          │          FastAPI Backend              │
          │                                       │
          │  routes/  →  services/  →  SQLite    │
          │              ↓                        │
          │         APIs Externas / Protocolos   │
          └───────────────────────────────────────┘
```

---

## 10. Decisões Arquiteturais

| Decisão | Motivo | Alternativa |
|---------|--------|-------------|
| **HTTP em vez de IPC** | Backend Python não fala IPC Electron nativamente. HTTP é universal, testável no browser/curl, e permite isolar o backend facilmente | IPC via stdin/stdout (mais complexo, harder to debug) |
| **SQLite** | Deploy single-file, zero config, suficiente para dados locais de desktop app | PostgreSQL (overkill para local), JSON files (sem transações) |
| **Pinia em vez de Vuex** | Composition API nativo, tipagem TypeScript superior, API mais simples | Vuex 4 (legado), Zustand (não Vue) |
| **Sem vue-router (apps simples)** | Elimina uma dependência, navegação simples com ref é suficiente para 3-6 views | vue-router (necessário quando há parâmetros de rota ou guards de auth) |
| **sandbox: false** | `child_process` no preload requer desabilitar sandbox do Chromium | Mover spawn para main via IPC (mais correto mas mais verboso) |
| **`show: false` na janela** | Evita flash de tela branca enquanto backend carrega | `show: true` (flickering desagradável) |
| **Port cleanup antes do spawn** | AppImage no Linux pode deixar processo zombie que bloqueia a porta | Tentar porta diferente (mais complexo, confuso pro usuário) |
| **Binário PyInstaller em resources/** | Distribui app sem precisar Python instalado no usuário | Instalar Python junto (pesado, conflita com versões do usuário) |
| **`window-all-closed` vazio** | App vive na bandeja, não deve sair quando janela fecha | Sair ao fechar (comportamento tradicional, sem tray) |
| **CORS `*` no backend** | Só localhost acessa, sem risco real de CSRF. Simplifica config. | Origins específicos (necessário se backend fosse público) |

---

## 11. Scripts de Desenvolvimento

### dev.sh (raiz do projeto)

```bash
#!/bin/bash
# Inicia backend e frontend em paralelo
cd backend && ./venv/bin/python main.py &
BACKEND_PID=$!

cd frontend && npm run dev

kill $BACKEND_PID
```

### Compilar backend para distribuição (PyInstaller)

```bash
cd backend
pip install pyinstaller
pyinstaller --onefile --name backend-server main.py
# Binário gerado em: dist/backend-server (Linux/Mac) ou dist/backend-server.exe (Windows)
```

---

## 12. Checklist para Novo Projeto

- [ ] `npm create @quick-start/electron@latest` (electron-vite template com Vue+TS)
- [ ] Instalar: `pinia axios tailwindcss`
- [ ] Criar `backend/` com FastAPI + aiosqlite
- [ ] Copiar padrão `main/index.ts` (spawn, health check, tray, single instance)
- [ ] Copiar `preload/index.ts` (contextBridge)
- [ ] Criar `api/index.ts` com detecção `file://` vs dev proxy
- [ ] Configurar proxy em `electron.vite.config.ts` (`/api → :PORTA`)
- [ ] Criar ícone 512×512 em `build/icon.png`
- [ ] Configurar `electron-builder.yml` com appId e targets
- [ ] Definir env vars que Electron passa para o backend (`DATA_DIR`, etc.)
- [ ] Criar `requirements.txt` e `venv`
- [ ] Testar: `npm run dev` (com backend manual) e `npm run build:linux`
