const assert = require('node:assert/strict')
const { JellyfinClient } = require('../dist-electron/electron/jellyfinClient.js')

let responseBody = null
let lastUrl = ''
let lastInit = null
const originalFetch = global.fetch
const identity = { name: 'Jellyfin Server', version: '10.11.11' }

global.fetch = async (url, init) => {
  lastUrl = String(url)
  lastInit = init
  if (lastUrl.endsWith('/MediaWarp/version')) {
    return new Response(JSON.stringify({ app_version: '0.2.4' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (lastUrl.endsWith('/System/Info/Public')) {
    return new Response(JSON.stringify({ ProductName: 'Jellyfin Server', ServerName: 'Smoke Jellyfin', Version: '10.11.11' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return new Response(JSON.stringify(responseBody), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function run() {
  const inspected = await JellyfinClient.inspect('http://127.0.0.1:9000')
  assert.equal(inspected.mediaWarpVersion, '0.2.4')
  assert.equal(inspected.identity.version, '10.11.11')
  const client = new JellyfinClient(inspected.baseUrl, 'token', 'user', identity)
  responseBody = { Items: [{ Id: 'view-1', Name: '电影', CollectionType: 'movies' }], TotalRecordCount: 1 }
  assert.deepEqual(await client.getViews(), responseBody.Items)
  assert.match(lastUrl, /\/Users\/user\/Views$/)
  assert.match(lastInit.headers.get('Authorization'), /Token="token"/)

  responseBody = { MediaSources: [{ Id: 'source-1', SupportsDirectPlay: true }] }
  await client.getPlaybackInfo('movie-1', { mediaSourceId: 'source-1', audioStreamIndex: 1, subtitleStreamIndex: 2, startTimeTicks: 40 })
  assert.match(lastUrl, /\/Items\/movie-1\/PlaybackInfo$/)
  assert.equal(lastInit.method, 'POST')
  const playbackBody = JSON.parse(lastInit.body)
  assert.equal(playbackBody.UserId, 'user')
  assert.equal(playbackBody.MediaSourceId, 'source-1')
  assert.equal(playbackBody.AudioStreamIndex, 1)
  assert.equal(playbackBody.SubtitleStreamIndex, 2)
  assert.equal(playbackBody.StartTimeTicks, 40)
  assert.deepEqual(playbackBody.DeviceProfile.DirectPlayProfiles, [{ Type: 'Video' }, { Type: 'Audio' }])
  assert.equal('Container' in playbackBody.DeviceProfile.DirectPlayProfiles[0], false)
  assert.equal('VideoCodec' in playbackBody.DeviceProfile.DirectPlayProfiles[0], false)
  assert.equal('AudioCodec' in playbackBody.DeviceProfile.DirectPlayProfiles[0], false)

  responseBody = { Items: [{ Id: 'episode-1', Name: '第一集', Type: 'Episode' }], TotalRecordCount: 1 }
  assert.deepEqual((await client.getSeriesEpisodes('series-1')).map((item) => item.Id), ['episode-1'])
  assert.match(lastUrl, /\/Shows\/series-1\/Episodes\?/)

  const streamUrl = client.buildStreamUrl('movie-1', { Id: 'source-1', DirectStreamUrl: 'http://127.0.0.1:8096/Videos/movie-1/stream?Static=true&api_key=route-token' }, { playSessionId: 'session-1' })
  assert.equal(new URL(streamUrl).searchParams.get('api_key'), 'route-token')
  assert.equal(new URL(streamUrl).searchParams.get('PlaySessionId'), 'session-1')
  console.log('Jellyfin client contract smoke test passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  global.fetch = originalFetch
})
