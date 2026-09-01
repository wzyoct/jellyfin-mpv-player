const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
for (const directory of ['dist', 'dist-electron']) {
  fs.rmSync(path.join(root, directory), { recursive: true, force: true })
}
