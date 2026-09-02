const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const releaseRoot = path.join(root, 'release')
const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const releaseNotes = JSON.parse(fs.readFileSync(path.join(root, 'src/data/release-notes.json'), 'utf8'))
const version = packageInfo.version
const release = releaseNotes.find((item) => item.version === version)
const releaseDate = release?.date || new Date().toISOString().slice(0, 10)
const archiveName = `Jellyfin-MPV-Player-v${version}-win-x64.zip`
const checksumName = `${archiveName}.sha256`
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
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
    return
  }
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true })
}

function writeTextFile(filePath, content) {
  ensureDirectory(path.dirname(filePath))
  fs.writeFileSync(filePath, `\uFEFF${content.trimEnd()}\n`, 'utf8')
}

function formatReleaseNotes(note) {
  const lines = [`Jellyfin MPV Player v${note.version} 更新记录`, `日期：${note.date}`, '']
  if (note.summary) lines.push(note.summary, '')
  for (const section of note.sections) {
    lines.push(`【${section.title}】`)
    for (const item of section.items) lines.push(`- ${item}`)
    lines.push('')
  }
  return lines.join('\n')
}

function writeGuides(directory) {
  if (!release) throw new Error(`找不到 ${version} 的更新记录`)
  writeTextFile(path.join(directory, '00-启动说明.txt'), `
Jellyfin MPV Player Windows 便携版启动说明
当前版本：v${version}
发布日期：${releaseDate}

启动方式：
1. 解压本 ZIP，并双击“Jellyfin MPV Player.exe”即可启动，无需安装。
2. 在设置中填写你自己的 MPV 完整路径，例如 C:\\tools\\mpv\\mpv.exe。
3. 登录配置、缓存和运行数据保存在应用目录的 data 文件夹。

播放器不会附带 MPV 或 MPV 配置。请分别下载官方 MPV 和 portable_config 配置包。
不要移动、删除或改名 resources、locales、DLL、PAK 文件。
`)
  writeTextFile(path.join(directory, '发布信息', '03-更新记录.txt'), formatReleaseNotes(release))
}

function copyDirectoryContents(sourceDirectory, targetDirectory) {
  ensureDirectory(targetDirectory)
  for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
    const source = path.join(sourceDirectory, entry.name)
    const target = path.join(targetDirectory, entry.name)
    fs.cpSync(source, target, { recursive: true, force: true })
  }
}

function copyRuntime(stagingDirectory, archiveDirectory) {
  if (!fs.existsSync(stagingDirectory)) throw new Error(`没有找到解包构建目录：${stagingDirectory}`)
  copyDirectoryContents(stagingDirectory, archiveDirectory)
  const executable = path.join(archiveDirectory, 'Jellyfin MPV Player.exe')
  if (!fs.existsSync(executable)) throw new Error(`便携入口不存在：${executable}`)
}

function quotePowerShell(value) {
  return `'${value.replace(/'/g, "''")}'`
}

function createZip(sourceDirectory, archivePath) {
  if (process.platform !== 'win32') throw new Error('Windows ZIP 发布流程只能在 Windows 上运行')
  if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath)
  const command = `Compress-Archive -Path ${quotePowerShell(path.join(sourceDirectory, '*'))} -DestinationPath ${quotePowerShell(archivePath)} -CompressionLevel Optimal`
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { cwd: root, stdio: 'inherit', shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Compress-Archive failed with exit code ${result.status}`)
  if (!fs.existsSync(archivePath)) throw new Error(`ZIP 文件未生成：${archivePath}`)
}

function writeZipChecksum(archivePath, checksumPath) {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex')
  fs.writeFileSync(checksumPath, `${hash}  ${path.basename(archivePath)}\n`, 'utf8')
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jellyfin-mpv-player-release-'))
const builderOutput = path.join(temporaryRoot, 'builder')
const archiveDirectory = path.join(temporaryRoot, 'portable')
const stagingDirectory = path.join(builderOutput, 'win-unpacked')
const archivePath = path.join(releaseRoot, archiveName)
const checksumPath = path.join(releaseRoot, checksumName)

try {
  run(npmCommand, ['run', 'release:check'])
  run(npmCommand, ['run', 'test:coverage'])
  run(npmCommand, ['run', 'test:contract'])
  run(npmCommand, ['run', 'build'])
  ensureDirectory(releaseRoot)
  run(builderCommand, ['--win', '--dir', `--config.directories.output=${builderOutput}`])
  copyRuntime(stagingDirectory, archiveDirectory)
  writeGuides(archiveDirectory)
  createZip(archiveDirectory, archivePath)
  writeZipChecksum(archivePath, checksumPath)
  console.log(`Windows 便携发布 ZIP 已生成：${archivePath}`)
  console.log(`SHA256 校验文件已生成：${checksumPath}`)
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}
