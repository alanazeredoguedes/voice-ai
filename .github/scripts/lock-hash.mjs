// Hash do frontend/package-lock.json SEM o campo "version" do próprio app.
// O npm run release sobe essa versão no lockfile a cada release; com o hash do arquivo inteiro, a chave do cache do
// node_modules mudaria em toda release e o cache nunca seria reaproveitado. Só as dependências devem contar.
import { createHash } from 'crypto'
import { readFileSync } from 'fs'

const lock = JSON.parse(readFileSync('frontend/package-lock.json', 'utf8'))
delete lock.version
if (lock.packages && lock.packages['']) delete lock.packages[''].version
console.log(createHash('sha256').update(JSON.stringify(lock)).digest('hex'))
