const assert = require('node:assert/strict')
const { EmbyClient } = require('../dist-electron/electron/emby.js')

let responseBody = null
let lastUrl = ''
let lastInit = null
const originalFetch = global.fetch

global.fetch = async (url, init) => {
  lastUrl = String(url)
  lastInit = init
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
  assert.match(lastInit.headers.get('X-Emby-Authorization'), /DeviceId="ember-player"/)

  responseBody = {
    Items: [{ Id: 'movie-1', Name: '测试电影', Type: 'Movie' }],
    TotalRecordCount: 1,
  }
  const items = await client.getItems({ parentId: 'view-1', includeItemTypes: 'Movie' })
  assert.deepEqual(items.Items, responseBody.Items)
  const query = new URL(lastUrl).searchParams
  assert.equal(query.get('ParentId'), 'view-1')
  assert.equal(query.get('IncludeItemTypes'), 'Movie')

  responseBody = [{
    Items: [{ Id: 'recommendation-1', Name: '推荐电影', Type: 'Movie' }],
    RecommendationType: 'SimilarToRecentlyPlayed',
  }]
  const recommendations = await client.getMovieRecommendations()
  assert.deepEqual(recommendations, responseBody)
  assert.match(lastUrl, /\/emby\/Movies\/Recommendations\?/)

  responseBody = {
    Items: [{ Id: 'next-1', Name: '下一集', Type: 'Episode', SeriesId: 'series-1' }],
    TotalRecordCount: 1,
  }
  const nextUp = await client.getNextUp('series-1')
  assert.deepEqual(nextUp.Items, responseBody.Items)
  assert.equal(new URL(lastUrl).searchParams.get('SeriesId'), 'series-1')

  responseBody = {
    Items: [{ Id: 'episode-1', Name: '第一集', Type: 'Episode', ParentBackdropItemId: 'season-1', ParentBackdropImageTags: ['season-backdrop'] }],
    TotalRecordCount: 1,
  }
  const episodes = await client.getSeriesEpisodes('series-1')
  assert.deepEqual(episodes, responseBody.Items)
  assert.match(lastUrl, /\/emby\/Shows\/series-1\/Episodes\?/)
  assert.equal(new URL(lastUrl).searchParams.get('IncludeItemTypes'), 'Episode')
  assert.equal(new URL(lastUrl).searchParams.get('EnableImageTypes'), 'Primary,Backdrop,Thumb')

  responseBody = { Id: 'episode-1', Name: '第一集', Type: 'Episode', ParentBackdropItemId: 'season-1', ParentBackdropImageTags: ['season-backdrop'] }
  const detailed = await client.getItem('episode-1')
  assert.deepEqual(detailed, responseBody)
  assert.equal(new URL(lastUrl).searchParams.get('EnableImageTypes'), 'Primary,Backdrop,Thumb')

  responseBody = {
    Items: [{ Id: 'resume-1', Name: '续播电影', Type: 'Movie' }],
    TotalRecordCount: 1,
  }
  await client.getItems({ includeItemTypes: 'Movie,Episode', filters: 'IsResumable', sortBy: 'DatePlayed' })
  assert.equal(new URL(lastUrl).searchParams.get('Filters'), 'IsResumable')

  await client.reportProgress({ ItemId: 'resume-1', PositionTicks: 12_000_000, IsPaused: false, QueueableMediaTypes: ['Video'] })
  const progressPayload = JSON.parse(lastInit.body)
  assert.equal(progressPayload.PositionTicks, 12_000_000)
  assert.equal(progressPayload.QueueableMediaTypes[0], 'Video')

  await client.reportPlaying({ ItemId: 'resume-1', PositionTicks: 12_000_000 })
  assert.equal(JSON.parse(lastInit.body).EventName, undefined)
  await client.reportStopped({ ItemId: 'resume-1', PositionTicks: 12_000_000 })
  assert.equal(JSON.parse(lastInit.body).EventName, undefined)

  const streamUrl = client.buildStreamUrl('resume-1', { Id: 'source-1' }, { playSessionId: 'session-1' })
  assert.equal(new URL(streamUrl).searchParams.get('PlaySessionId'), 'session-1')

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
