const { renameSync, writeFileSync, chmodSync } = require('fs')
const { join } = require('path')

exports.default = async function (context) {
  if (context.electronPlatformName !== 'linux') return

  const bin = join(context.appOutDir, 'voice-ai')
  const orig = join(context.appOutDir, 'voice-ai.bin')

  renameSync(bin, orig)
  writeFileSync(bin, `#!/bin/bash\nexec "$(dirname "$0")/voice-ai.bin" --no-sandbox "$@"\n`)
  chmodSync(bin, 0o755)
  console.log('  • injected --no-sandbox wrapper into voice-ai')
}
