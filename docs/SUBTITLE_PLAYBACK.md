# 字幕播放链路

## STRM 外挂字幕

播放信息解析后按以下顺序选择字幕：用户禁用、用户明确选择的 Jellyfin 字幕、Jellyfin 外挂默认轨道、Jellyfin 内嵌默认轨道、STRM 同目录同名或唯一 sidecar、无字幕。服务器返回了可选字幕轨道时，sidecar 不会覆盖服务器轨道。

Jellyfin 外挂字幕使用标准接口：

`/Videos/{itemId}/{mediaSourceId}/Subtitles/{index}/0/Stream.{codec}`

缺失 codec 时使用 `srt`。应用通过本地播放网关代理该地址，并只在网关到 Jellyfin 的请求中附加 Authorization。MPV 永远只看到本地网关地址，因此不会接收服务器本地路径或令牌。

## MPV 激活

媒体触发 `file-loaded` 后，PlaybackEntry 的单飞激活流程注册网关并执行一次 `sub-add <gateway-url> select Stream`。`select` 负责立即选择新增轨道；随后读取 `track-list` 和 `sid`，必要时按新增轨道的 MPV id 显式设置 `sid`。内嵌字幕不执行 `sub-add`，而是将 Jellyfin 的 FFmpeg stream index 映射到 MPV track id。

字幕阶段日志使用 `subtitle-route-resolved`、`subtitle-gateway-registered`、`subtitle-add-start`、`subtitle-add-complete`、`subtitle-selected` 和 `subtitle-failed`。日志只记录轨道、格式、状态和是否存在 DeliveryUrl，不记录 Authorization、令牌或完整敏感 URL。

自动字幕失败时执行一次 `sid=no` 并继续播放；用户明确选择的字幕失败则保留原始错误并终止当前启动。MPV IPC 已断开或进程退出后不发送清理命令，失败条目也不会标记为 loaded。

## 参考经验

Jellyfin STRM 外部字幕可能返回不可访问的服务器路径，因此客户端应使用上述标准字幕接口。`embyToLocalPlayer` 的经验是对外部字幕使用标准接口回退，并将内嵌字幕映射为 MPV 的 `sid`。Nimbus.Player 仅作为产品行为和功能范围参考，本项目不依赖其公开仓库实现。
