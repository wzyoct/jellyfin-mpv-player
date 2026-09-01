const fs = require('node:fs')
const path = require('node:path')

fs.rmSync(path.resolve(__dirname, '..', 'dist-electron'), { recursive: true, force: true })
