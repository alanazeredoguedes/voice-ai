// Mesmos casos do backend (backend/tests/fixtures/rich_text_cases.json): o texto falado (plain)
// calculado na tela tem que ser igual ao do backend, senão o destaque da fala sai no lugar errado.
// Rodar: node frontend/tests/richText.test.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { toPlain, normalize, buildDoc } from '../src/renderer/src/utils/richText.ts'

const here = dirname(fileURLToPath(import.meta.url))
const cases = JSON.parse(readFileSync(join(here, '../../backend/tests/fixtures/rich_text_cases.json'), 'utf8'))
let fails = 0

for (const c of cases) {
  const got = toPlain(normalize(c.md))
  if (got !== c.plain) {
    fails++
    console.log(`FALHOU ${c.name}\n  esperado: ${JSON.stringify(c.plain)}\n  veio:     ${JSON.stringify(got)}`)
  }
}

const long =
  'Aaah, agora entendi! Você está falando dos **amiibo** em *Tears of the Kingdom*.\n\n' +
  'Os amiibo são figuras NFC da Nintendo.\n[[media:g1]]\n' +
  '## Para que servem os amiibo?\nQuando você utiliza um amiibo compatível, pode receber:\n' +
  '- **Baús:** com armas, materiais e outros itens.\n- **Comidas:** cogumelos e peixes.\n\n' +
  '### Como usar no jogo?\n1. Abra o menu de habilidades.\n2. Selecione a habilidade **amiibo**.\n' +
  '3. Aproxime o amiibo do controle.\n\n| Amiibo | Recompensa |\n|---|---|\n| Link | Tecido |\n' +
  '**Importante:** veja (https://nintendo.com) e o [guia](https://x.com/a) também. Fim.'

for (const md of [...cases.map((c) => c.md), long]) {
  const final = toPlain(md)
  for (let k = 0; k <= md.length; k++) {
    const p = toPlain(md.slice(0, k), true)
    if (!final.startsWith(p)) {
      fails++
      console.log(`INSTÁVEL em ${k}: ${JSON.stringify(md.slice(0, k))}\n  parcial: ${JSON.stringify(p)}`)
      break
    }
  }
  // cada trecho da tela tem que apontar para o mesmo texto no plain
  const doc = buildDoc(md)
  const runs = []
  for (const b of doc.blocks) {
    if (b.type === 'p' || b.type === 'h') runs.push(...b.runs)
    if (b.type === 'list') for (const it of b.items) runs.push(...(it.marker ? [it.marker] : []), ...it.runs)
    // células de tabela não são faladas (não têm posição no plain)
  }
  for (const r of runs) {
    if (r.o === undefined || doc.plain.slice(r.o, r.o + r.text.length) !== r.text) {
      fails++
      console.log(`POSIÇÃO errada: ${JSON.stringify(r)}`)
      break
    }
  }
}

console.log(fails ? `${fails} falha(s)` : 'OK')
process.exit(fails ? 1 : 0)
