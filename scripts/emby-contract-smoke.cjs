const assert = require('node:assert/strict')
const { EmbyClient } = require('../dist-electron/electron/emby.js')

let responseBody = null
let lastUrl = ''
const originalFetch = global.fetch

global.fetch = async (url) => {
  lastUrl = String(url)
  return new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function run() {
  const client = new EmbyClient('http://127.0.0.1:8096', 'token', 'user')

  responseBody = {
    Items: [{ Id: 'view-1', Name: '电影', CollectionType: 'movies' }],
    TotalRecordCount: 1,
  }
  const views = await client.getViews()
  assert.deepEqual(views, responseBody.Items)
  assert.match(lastUrl, /\/emby\/Users\/user\/Views$/)

  responseBody = {
    Items: [{ Id: 'movie-1', Name: '测试电影', Type: 'Movie' }],
    TotalRecordCount: 1,
  }
  const items = await client.getItems({ parentId: 'view-1', includeItemTypes: 'Movie' })
  assert.deepEqual(items.Items, responseBody.Items)
  const query = new URL(lastUrl).searchParams
  assert.equal(query.get('ParentId'), 'view-1')
  assert.equal(query.get('IncludeItemTypes'), 'Movie')

  responseBody = { Items: [] }
  await assert.rejects(() => client.getViews(), /缺少 Items 或 TotalRecordCount/)
  console.log('Emby contract smoke test passed')
}

run()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    global.fetch = originalFetch
  })
