const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const releaseNotes = JSON.parse(fs.readFileSync(path.join(root, 'src/data/release-notes.json'), 'utf8'))

const lines = ['# Changelog', '']
for (const release of releaseNotes) {
  lines.push(`## ${release.version} - ${release.date}`, '')
  if (release.summary) lines.push(release.summary, '')
  for (const section of release.sections) {
    lines.push(`### ${section.title}`, '')
    for (const item of section.items) lines.push(`- ${item}`)
    lines.push('')
  }
}

fs.writeFileSync(path.join(root, 'CHANGELOG.md'), `${lines.join('\n').trimEnd()}\n`, 'utf8')
console.log(`synced CHANGELOG.md from ${releaseNotes.length} releases`)
