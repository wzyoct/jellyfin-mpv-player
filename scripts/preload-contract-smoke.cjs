const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')
const preloadPath = path.join(root, 'dist-electron', 'electron', 'preload.js')
const source = fs.readFileSync(preloadPath, 'utf8')

assert.doesNotMatch(source, /require\(["']\.?\.?[\\/]/, 'preload must not require local modules in Electron sandbox mode')

const calls = []
let exposedApi
let pendingError
const ipcRenderer = {
  invoke: (...args) => {
    calls.push(args)
    if (pendingError) {
      const error = pendingError
      pendingError = undefined
      return Promise.reject(error)
    }
    return Promise.resolve({ valid: true })
  },
  on: () => undefined,
  removeListener: () => undefined,
  send: () => undefined,
}
const sandbox = {
  Error,
  Promise,
  String,
  require: (moduleName) => {
    assert.equal(moduleName, 'electron', 'preload may only require Electron in sandbox mode')
    return {
      contextBridge: {
        exposeInMainWorld: (name, api) => {
          assert.equal(name, 'emby')
          exposedApi = api
        },
      },
      ipcRenderer,
    }
  },
  window: { addEventListener: () => undefined },
}

vm.runInNewContext(source, sandbox, { filename: preloadPath })

const expectedMethods = [
  'getSettings',
  'saveSettings',
  'login',
  'logout',
  'getViews',
  'getItems',
  'getMovieRecommendations',
  'getItem',
  'getPlaybackInfo',
  'getNextUp',
  'getSeriesEpisodes',
  'getImage',
  'getFullScreen',
  'setFullScreen',
  'onFullScreenChanged',
  'validateMpvPath',
  'testMpvPath',
  'openLogDirectory',
  'playbackStart',
  'playbackCommand',
  'getPlaybackSnapshot',
  'onPlaybackChanged',
]
assert.ok(exposedApi, 'preload must expose window.emby')
for (const method of expectedMethods) assert.equal(typeof exposedApi[method], 'function', `missing preload API method: ${method}`)

async function run() {
  await exposedApi.validateMpvPath('C:\\green\\mpv\\mpv.exe')
  assert.deepEqual(calls.at(-1), ['mpv:validate', 'C:\\green\\mpv\\mpv.exe'])

  await exposedApi.getFullScreen()
  assert.deepEqual(calls.at(-1), ['window:get-full-screen'])
  await exposedApi.setFullScreen(true)
  assert.deepEqual(calls.at(-1), ['window:set-full-screen', true])

  pendingError = new Error("Error invoking remote method 'mpv:validate': Error: MPV IPC 参数无效")
  await assert.rejects(exposedApi.validateMpvPath(), /MPV IPC 参数无效/)
  console.log('Preload contract smoke test passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
