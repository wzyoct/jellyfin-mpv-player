const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const releaseRoot = path.join(root, 'release')
const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const releaseNotes = JSON.parse(fs.readFileSync(path.join(root, 'src/data/release-notes.json'), 'utf8'))
const version = packageInfo.version
const releaseDate = releaseNotes.find((release) => release.version === version)?.date || new Date().toISOString().slice(0, 10)
const currentDirectory = releaseRoot
const historyDirectory = path.join(releaseRoot, '历史版本')
const internalDirectory = path.join(releaseRoot, '构建内部文件')
const rawDirectory = path.join(releaseRoot, 'build')
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

function moveEntry(source, destinationDirectory) {
  ensureDirectory(destinationDirectory)
  const destination = uniqueDirectory(destinationDirectory, path.basename(source))
  fs.renameSync(source, destination)
}

function detectVersion(source, entryName) {
  const nameMatch = entryName.match(/\d+\.\d+\.\d+/)
  if (nameMatch) return nameMatch[0]
  if (!fs.statSync(source).isFile()) return undefined

  try {
    const content = fs.readFileSync(source, 'utf8')
    return content.match(/v(\d+\.\d+\.\d+)/)?.[1]
  } catch {
    return undefined
  }
}

function archiveExistingOutput() {
  ensureDirectory(historyDirectory)
  ensureDirectory(internalDirectory)

  for (const entry of fs.readdirSync(releaseRoot, { withFileTypes: true })) {
    const source = path.join(releaseRoot, entry.name)
    if (entry.name === '历史版本' || entry.name === '构建内部文件') continue

    const isKnownBuilderOutput = entry.name === 'build'
      || entry.name === 'win-unpacked'
      || entry.name === 'builder-debug.yml'
      || entry.name === 'latest.yml'
      || entry.name.startsWith('当前版本-Ember Player')
      || entry.name.startsWith('Ember Player')
    const isKnownReleaseFile = entry.name === '00-先看这里-启动说明.txt'
      || entry.name === '03-更新记录.txt'
      || entry.name === '04-文件校验值-SHA256.txt'
      || /^01-.*Setup-\d+\.\d+\.\d+\.exe$/.test(entry.name)
      || /^02-.*-\d+\.\d+\.\d+\.zip$/.test(entry.name)
    if (!isKnownBuilderOutput && !isKnownReleaseFile) {
      console.warn(`保留未识别的 release 文件：${entry.name}`)
      continue
    }

    const entryVersion = detectVersion(source, entry.name)
    if (entryVersion === version && isKnownReleaseFile) continue
    if (entry.isDirectory() && entry.name.startsWith('当前版本-Ember Player')) {
      const destination = path.join(historyDirectory, entryVersion || '未标记版本')
      ensureDirectory(path.dirname(destination))
      fs.renameSync(source, uniqueDirectory(path.dirname(destination), path.basename(destination)))
    } else if (entryVersion && isKnownReleaseFile) {
      moveEntry(source, path.join(historyDirectory, entryVersion))
    } else {
      moveEntry(source, path.join(internalDirectory, '历史构建'))
    }
  }
}

function writeTextFile(filePath, content) {
  fs.writeFileSync(filePath, `\uFEFF${content.trimEnd()}\n`, 'utf8')
}

function formatReleaseNotes(release) {
  const lines = [`Ember Player v${release.version} 更新记录`, `日期：${release.date}`, '']
  if (release.summary) lines.push(release.summary, '')
  for (const section of release.sections) {
    lines.push(`【${section.title}】`)
    for (const item of section.items) lines.push(`- ${item}`)
    lines.push('')
  }
  return lines.join('\n')
}

function writeGuides() {
  const release = releaseNotes.find((item) => item.version === version)
  if (!release) throw new Error(`找不到 ${version} 的更新记录`)

  writeTextFile(path.join(releaseRoot, '00-先看这里-启动说明.txt'), `
Ember Player Windows 启动说明
当前版本：v${version}
发布日期：${releaseDate}

推荐启动方式：
1. 打开本文件所在的 release 文件夹。
2. 双击“01-双击安装（推荐）-Ember Player Setup-${version}.exe”。
3. 安装完成后，从桌面或开始菜单双击 Ember Player 启动。

免安装方式：
1. 双击“02-免安装绿色版-Ember Player-${version}.zip”。
2. 将压缩包解压到一个独立文件夹。
3. 双击解压文件夹中的“Ember Player.exe”。

不要打开 .blockmap、.yml、win-unpacked 或构建内部文件。
播放媒体前，请在 Ember Player 设置中确认 MPV 路径有效。
`)
  writeTextFile(path.join(currentDirectory, '03-更新记录.txt'), formatReleaseNotes(release))
}

function writeChecksums(files) {
  const lines = [`Ember Player v${version} SHA256 校验值`, `生成日期：${releaseDate}`, '']
  for (const file of files) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    lines.push(`${hash}  ${path.basename(file)}`)
  }
  writeTextFile(path.join(currentDirectory, '04-文件校验值-SHA256.txt'), lines.join('\n'))
}

run(npmCommand, ['run', 'release:check'])
run(npmCommand, ['run', 'test:subtitle'])
run(npmCommand, ['run', 'test:contract'])
run(npmCommand, ['run', 'build'])

ensureDirectory(releaseRoot)
archiveExistingOutput()
ensureDirectory(currentDirectory)
ensureDirectory(rawDirectory)
run(builderCommand, ['--win', 'nsis', 'zip'])

const setupSource = path.join(rawDirectory, `Ember Player Setup ${version}.exe`)
const zipSource = path.join(rawDirectory, `Ember Player-${version}-win.zip`)
if (!fs.existsSync(setupSource) || !fs.existsSync(zipSource)) {
  throw new Error(`没有找到 ${version} 的安装包或绿色版压缩包，请检查 ${rawDirectory}`)
}

const setupTarget = path.join(currentDirectory, `01-双击安装（推荐）-Ember Player Setup-${version}.exe`)
const zipTarget = path.join(currentDirectory, `02-免安装绿色版-Ember Player-${version}.zip`)
fs.copyFileSync(setupSource, setupTarget)
fs.copyFileSync(zipSource, zipTarget)
writeGuides()
writeChecksums([setupTarget, zipTarget])

const internalVersionDirectory = uniqueDirectory(internalDirectory, version)
fs.renameSync(rawDirectory, internalVersionDirectory)

console.log(`Windows 发布包已整理完成：${currentDirectory}`)
