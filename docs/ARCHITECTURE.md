# Jellyfin MPV Player 架构说明

## 数据边界

渲染进程只通过 `window.jellyfin` 调用媒体领域接口。Electron 主进程负责鉴权、响应校验、播放协商、MPV IPC 和进度上报；渲染进程不接触令牌，也不拼接媒体地址。连接入口必须是 MediaWarp 根地址，登录先校验 `/MediaWarp/version`（>=0.2.4），再校验 Jellyfin 10.11.x；所有 API、图片、PlaybackInfo 和媒体请求使用同一 Base URL。

## 播放链路

播放器通过 MediaWarp 发送 POST PlaybackInfo，并使用 MPV DeviceProfile。电视剧会将完整逻辑目录立即写入 MPV M3U，仅按当前集解析 PlaybackInfo，播放成功后单次预热下一集；未预热条目在被选中时按需解析。媒体源的 `DirectStreamUrl`、`TranscodingUrl`、`DeliveryUrl` 和 `DeliveryMethod` 是唯一播放路由来源，禁止读取 `.strm` 文本猜测网盘地址。

每个播放会话启动一个绑定 `127.0.0.1` 的临时网关。每个逻辑条目只有一个本地能力 URL，资源解析器单飞并缓存成功结果；网关向服务端请求时附加 Jellyfin 鉴权，遇到无需专用请求头的 MediaWarp 302 时把重定向交给 MPV，跨域请求不携带 Jellyfin Token。网关同时处理外置字幕、Range、If-Range 和需要专用请求头的资源，最多跟随 10 次重定向；MPV 主动取消不会记为 502。

## 轨道与进度

Jellyfin 的 Stream Index 在 MPV `track-list` 的 `ff-index` 中匹配，分别设置 `aid` 和 `sid`。起播集严格校验显式轨道索引，后续集优先按语言、标题和编码匹配，再回到每集默认轨道；关闭字幕是会话级偏好。PlaybackInfo 使用 60 秒独立超时，Playing、Progress 和 Stopped 请求统一由主进程发送，并在日志中只记录脱敏的媒体源、路由类型、准备阶段、耗时和状态码。

## 配置与发布

1.0.0 使用独立的 Jellyfin MPV Player 配置目录，不迁移旧配置。版本号的唯一来源是 `package.json` 和 `src/data/release-notes.json`；`CHANGELOG.md` 与 Windows 发布说明由脚本生成。
