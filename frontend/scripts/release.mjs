/**
 * Publica uma nova versão: a GitHub gera o AppImage (Linux) e o .exe (Windows) e cria a release.
 *
 *   npm run release              1.1.0 -> 1.1.1  (correção)
 *   npm run release -- minor     1.1.0 -> 1.2.0  (novidade)
 *   npm run release -- major     1.1.0 -> 2.0.0
 *   npm run release -- 1.4.0     versão exata
 *
 * O que faz: confere se está tudo certo (main, sem alterações pendentes, igual à GitHub, typecheck ok),
 * sobe a versão no package.json, cria o commit "Versão X" e a tag vX e envia para a GitHub.
 * O envio da tag dispara o workflow .github/workflows/release.yml.
 */
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const frontend = join(dirname(fileURLToPath(import.meta.url)), '..')
const sh = (cmd, opts = {}) => (execSync(cmd, { cwd: frontend, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts }) ?? '').trim()
const fail = (msg) => {
  console.error(`\n✗ ${msg}\n`)
  process.exit(1)
}

const bump = process.argv[2] ?? 'patch'
if (!/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(bump)) fail(`Use: npm run release [-- patch|minor|major|X.Y.Z] (recebido: ${bump})`)

// 1. conferências
if (sh('git rev-parse --abbrev-ref HEAD') !== 'main') fail('Faça a release a partir da branch main.')
if (sh('git status --porcelain')) fail('Há alterações não commitadas. Faça o commit (e o push) antes da release.')
console.log('→ conferindo com a GitHub...')
sh('git fetch origin main --tags')
if (sh('git rev-list --count HEAD..origin/main') !== '0') fail('A GitHub tem commits que você não tem. Rode "git pull" primeiro.')
console.log('→ conferindo o código (typecheck)...')
try {
  sh('npm run typecheck', { stdio: 'inherit' })
} catch {
  fail('O typecheck falhou. Corrija antes de publicar.')
}

// 2. nova versão
const before = JSON.parse(readFileSync(join(frontend, 'package.json'), 'utf8')).version
sh(`npm version ${bump} --no-git-tag-version`)
const version = JSON.parse(readFileSync(join(frontend, 'package.json'), 'utf8')).version
const tag = `v${version}`
if (sh(`git tag --list ${tag}`)) {
  sh('git checkout -- package.json package-lock.json')
  fail(`A versão ${tag} já existe. Use outra versão.`)
}

// 3. commit, tag e envio
sh('git add package.json package-lock.json')
sh(`git commit -q -m "Versão ${version}"`)
sh(`git tag -a ${tag} -m "Versão ${version}"`)
console.log(`→ enviando ${tag} para a GitHub...`)
sh(`git push --atomic origin main ${tag}`, { stdio: 'inherit' })

const repo = sh('git remote get-url origin').replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '')
console.log(`
✓ Versão ${before} → ${version} enviada.
  A GitHub está gerando o AppImage e o .exe (uns 10 minutos).
  Acompanhe: ${repo}/actions
  Release:   ${repo}/releases/tag/${tag}
`)
