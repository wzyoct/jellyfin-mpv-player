const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const releaseRoot = path.join(root, 'release')
const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const releaseNotes = JSON.parse(fs.readFileSync(path.join(root, 'src/data/release-notes.json'), 'utf8'))
const version = packageInfo.version
const release = releaseNotes.find((item) => item.version === version)
const releaseDate = release?.date || new Date().toISOString().slice(0, 10)
const historyDirectory = path.join(releaseRoot, '历史版本')
const internalDirectory = path.join(releaseRoot, '构建内部文件')
const rawDirectory = path.join(releaseRoot, 'build')
const stagingDirectory = path.join(rawDirectory, 'win-unpacked')
const infoDirectory = path.join(releaseRoot, '发布信息')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const builderCommand = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder')

function run(command, args) {
  if (process.platform === 'win32') {
    const commandLine = [command, ...args].map((value) => {
      const text = String(value)
      return /[\s"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
    }).join(' ')
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], { cwd: root, stdio: 'inherit', shell: false })
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status || 1)
    return
  }
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true })
}

function uniqueDirectory(directory, name) {
  let candidate = path.join(directory, name)
  let suffix = 2
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${name}-${suffix}`)
    suffix += 1
  }
  return candidate
}

function detectVersion(source, entryName) {
  const match = entryName.match(/\d+\.\d+\.\d+/)
  if (match) return match[0]
  if (!fs.statSync(source).isFile()) return undefined
  try {
    return fs.readFileSync(source, 'utf8').match(/v(\d+\.\d+\.\d+)/)?.[1]
  } catch {
    return undefined
  }
}

function moveToArchive(source, directory) {
  ensureDirectory(directory)
  fs.renameSync(source, uniqueDirectory(directory, path.basename(source)))
}

function archiveExistingOutput() {
  ensureDirectory(historyDirectory)
  ensureDirectory(internalDirectory)
  ensureDirectory(infoDirectory)
  if (!fs.existsSync(releaseRoot)) return

  for (const entry of fs.readdirSync(releaseRoot, { withFileTypes: true })) {
    const source = path.join(releaseRoot, entry.name)
    if (entry.name === 'data' || entry.name === '历史版本' || entry.name === '构建内部文件') continue
    const versionHint = detectVersion(source, entry.name) || '0.7.0'
    const isRuntime = entry.name === 'Ember Player.exe'
      || entry.name === 'resources'
      || entry.name === 'locales'
      || /\.(dll|pak|bin|dat|json)$/.test(entry.name)
    if (isRuntime) moveToArchive(source, path.join(internalDirectory, '旧运行文件', versionHint))
    else moveToArchive(source, path.join(historyDirectory, versionHint))
  }
}

function writeTextFile(filePath, content) {
  ensureDirectory(path.dirname(filePath))
  fs.writeFileSync(filePath, `\uFEFF${content.trimEnd()}\n`, 'utf8')
}

function formatReleaseNotes(note) {
  const lines = [`Ember Player v${note.version} 更新记录`, `日期：${note.date}`, '']
  if (note.summary) lines.push(note.summary, '')
  for (const section of note.sections) {
    lines.push(`【${section.title}】`)
    for (const item of section.items) lines.push(`- ${item}`)
    lines.push('')
  }
  return lines.join('\n')
}

function writeGuides() {
  if (!release) throw new Error(`找不到 ${version} 的更新记录`)
  writeTextFile(path.join(releaseRoot, '00-启动说明.txt'), `
Ember Player Windows 便携版启动说明
当前版本：v${version}
发布日期：${releaseDate}

启动方式：
1. 保持本文件与“Ember Player.exe”位于同一个 release 文件夹。
2. 双击“Ember Player.exe”即可启动，无需安装、无需解压。
3. 登录配置、缓存和运行数据保存在同目录的 data 文件夹。

播放媒体前，请在 Ember Player 设置中确认 MPV 路径有效。
MPV 默认使用 C:\\green\\mpv\\mpv.exe；便携版不会把 MPV 打包进应用。
不要移动、删除或改名 resources、locales、DLL、PAK 文件。
`)
  writeTextFile(path.join(infoDirectory, '03-更新记录.txt'), formatReleaseNotes(release))
}

function runtimeFiles(directory) {
  const files = []
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.name === 'data' || entry.name === '历史版本' || entry.name === '构建内部文件' || entry.name === '发布信息') continue
      if (entry.isDirectory()) visit(fullPath)
      else files.push(fullPath)
    }
  }
  visit(directory)
  return files.sort()
}

function writeChecksums() {
  const files = runtimeFiles(releaseRoot)
  const lines = [`Ember Player v${version} 运行文件 SHA256 校验值`, `生成日期：${releaseDate}`, '明确排除：data 文件夹（便携配置、令牌和缓存）', '']
  for (const file of files) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    lines.push(`${hash}  ${path.relative(releaseRoot, file)}`)
  }
  writeTextFile(path.join(infoDirectory, '04-文件校验值-SHA256.txt'), lines.join('\n'))
}

function copyRuntime() {
  if (!fs.existsSync(stagingDirectory)) throw new Error(`没有找到解包构建目录：${stagingDirectory}`)
  for (const entry of fs.readdirSync(stagingDirectory, { withFileTypes: true })) {
    const source = path.join(stagingDirectory, entry.name)
    const target = path.join(releaseRoot, entry.name)
    fs.cpSync(source, target, { recursive: true, force: true })
  }
  const executable = path.join(releaseRoot, 'Ember Player.exe')
  if (!fs.existsSync(executable)) throw new Error(`便携入口不存在：${executable}`)
}

run(npmCommand, ['run', 'release:check'])
run(npmCommand, ['test'])
run(npmCommand, ['run', 'test:contract'])
run(npmCommand, ['run', 'build'])

ensureDirectory(releaseRoot)
archiveExistingOutput()
ensureDirectory(rawDirectory)
run(builderCommand, ['--win', '--dir'])
copyRuntime()
writeGuides()
writeChecksums()

const internalVersionDirectory = uniqueDirectory(internalDirectory, version)
fs.renameSync(rawDirectory, internalVersionDirectory)
console.log(`Windows 便携发布包已整理完成：${releaseRoot}`)
