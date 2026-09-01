# Jellyfin MPV Player 架构说明

## 数据边界

渲染进程只通过 `window.jellyfin` 调用 Jellyfin 领域接口。Electron 主进程负责鉴权、响应校验、播放协商、MPV IPC 和进度上报；渲染进程不接触令牌，也不拼接媒体地址。

## 播放链路

播放器向 Jellyfin 或 MediaWarp 发送 POST PlaybackInfo，并使用 MPV DeviceProfile。媒体源的 `DirectStreamUrl`、`TranscodingUrl`、`DeliveryUrl` 和 `DeliveryMethod` 是唯一播放路由来源，禁止读取 `.strm` 文本猜测网盘地址。

每个播放会话启动一个绑定 `127.0.0.1` 的临时网关。MPV 使用一次性本地能力 URL，网关向服务端请求时附加 Jellyfin 鉴权；遇到 MediaWarp 302 时把重定向交给 MPV，跨域请求不携带 Jellyfin Token。网关同时处理外置字幕、Range 和需要专用请求头的资源。

## 轨道与进度

Jellyfin 的 Stream Index 在 MPV `track-list` 的 `ff-index` 中匹配，分别设置 `aid` 和 `sid`。PlaybackInfo、Playing、Progress 和 Stopped 请求统一由主进程发送，并在日志中只记录脱敏的媒体源、路由类型和状态码。

## 配置与发布

1.0.0 使用独立的 Jellyfin MPV Player 配置目录，不迁移旧配置。版本号的唯一来源是 `package.json` 和 `src/data/release-notes.json`；`CHANGELOG.md` 与 Windows 发布说明由脚本生成。
