const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'))
const packageInfo = readJson('package.json')
const lockInfo = readJson('package-lock.json')
const releaseNotes = readJson('src/data/release-notes.json')
const errors = []

if (lockInfo.version !== packageInfo.version) {
  errors.push(`package-lock.json version ${lockInfo.version} does not match package.json ${packageInfo.version}`)
}
if (lockInfo.packages?.['']?.version !== packageInfo.version) {
  errors.push(`package-lock.json root version does not match package.json ${packageInfo.version}`)
}
if (!Array.isArray(releaseNotes) || !releaseNotes.length) {
  errors.push('src/data/release-notes.json must contain at least one release')
} else {
  if (releaseNotes[0].version !== packageInfo.version) {
    errors.push(`latest release note ${releaseNotes[0].version} does not match package.json ${packageInfo.version}`)
  }
  const versions = new Set()
  for (const release of releaseNotes) {
    if (!release.version || versions.has(release.version)) errors.push(`invalid or duplicate release version: ${release.version || '(empty)'}`)
    versions.add(release.version)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(release.date || '')) errors.push(`invalid release date for ${release.version}`)
    if (!Array.isArray(release.sections) || release.sections.some((section) => !section.title || !Array.isArray(section.items))) {
      errors.push(`invalid release sections for ${release.version}`)
    }
  }
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join('\n'))
  process.exitCode = 1
} else {
  console.log(`version check passed: ${packageInfo.version}`)
}
