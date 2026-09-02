# Jellyfin MPV Player 架构说明

## 数据边界

渲染进程只通过 `window.jellyfin` 调用媒体领域接口。Electron 主进程负责鉴权、响应校验和 IPC 接线；`PlaybackManager` 单独拥有活动播放会话、MPV 子进程、临时网关、递增快照版本和清理流程。渲染进程不接触令牌，也不拼接媒体地址。连接入口必须是 MediaWarp 根地址，登录先校验 `/MediaWarp/version`（>=0.2.4），再校验 Jellyfin 10.11.x；所有 API、图片、PlaybackInfo 和媒体请求使用同一 Base URL。

播放器的启动、停止和控制命令经过管理器生命周期队列串行执行；MPV 生命周期事件与会话命令继续经过会话事件链串行处理。播放阶段只由播放生命周期驱动，`syncError` 只表示 Jellyfin 状态上报失败，控制命令错误会返回调用方而不会污染活动会话状态。

## 播放链路

播放器通过 MediaWarp 发送 POST PlaybackInfo，并使用 MPV DeviceProfile。电视剧会将完整逻辑目录立即写入 MPV M3U，仅按当前集解析 PlaybackInfo，播放成功后单次预热下一集；未预热条目在被选中时按需解析。媒体源的 `DirectStreamUrl`、`TranscodingUrl`、`DeliveryUrl` 和 `DeliveryMethod` 是唯一播放路由来源，禁止读取 `.strm` 文本猜测网盘地址。

首页继续观看专用调用 `/Users/{userId}/Items/Resume`，固定携带 `Limit=100`、`Recursive=true`、`MediaTypes=Video`、用户数据和卡片/图片字段。客户端按 `UserData.LastPlayedDate` 稳定降序排列；Episode 按 `SeriesId` 聚合并保留最近播放单集，电影及缺少 `SeriesId` 的项目按自身 ID 去重，时间缺失、无效或相同时保留服务端原始相对顺序。播放后只在服务端确认同步且项目已返回时提升对应媒体或剧集；刷新错误保留原列表并显示刷新失败通知。该流程不再调用 `Items?Filters=IsResumable`。

每个播放会话启动一个绑定 `127.0.0.1` 的临时网关。每个逻辑条目只有一个本地能力 URL，资源解析器单飞并缓存成功结果；网关向服务端请求时附加 Jellyfin 鉴权，遇到无需专用请求头的 MediaWarp 302 时把重定向交给 MPV，跨域请求不携带 Jellyfin Token。网关同时处理外置字幕、Range、If-Range 和需要专用请求头的资源，最多跟随 10 次重定向；MPV 主动取消不会记为 502。

## 轨道与进度

Jellyfin 的 Stream Index 在 MPV `track-list` 的 `ff-index` 中匹配，分别设置 `aid` 和 `sid`。字幕选择不变量是：外挂简中、外挂其他中文、服务端默认外挂、第一条外挂；无外挂时才选择内嵌简中、内嵌其他中文、服务端默认内嵌，否则关闭。`DeliveryMethod=Encode` 等无独立轨道的烧录字幕被排除。起播集严格校验显式轨道索引和外挂/内嵌类别，后续集只在同类别内依次按语言与编码、标题与编码、语言、标题匹配，失败后执行该集默认规则；显式关闭字幕是会话级偏好。打开详情时只展示默认选择，只有实际改选或关闭才形成显式偏好。

外挂字幕按当前媒体源生成标准 Jellyfin 字幕接口 `Videos/{itemId}/{mediaSourceId}/Subtitles/{index}/0/Stream.{format}`，再经携带 Jellyfin 鉴权的本地网关交给 MPV `sub-add <url> select`；不直接依赖 STRM 场景下可能不完整的 `DeliveryUrl`。STRM 媒体源如果返回 Windows 可访问的 `.strm` 路径，则也会优先查找同目录同名字幕或目录中唯一的字幕文件，并沿 `本地文件路径 → MPV sub-add <path> select` 挂载。用户在详情页选择的本地字幕优先级更高。内嵌字幕继续使用 MPV `track-list` 的 `ff-index` 映射 `sid`。缺少服务器字幕地址、网关或自动字幕 `sub-add` 失败时显式设置 `sid=no` 并继续无字幕播放，避免误显示内嵌字幕；用户显式选择的服务器或本地字幕加载失败都会抛出带片名的可见错误，不静默改选其他字幕。PlaybackInfo 使用 60 秒独立超时，Playing、Progress 和 Stopped 请求统一由主进程发送，并在日志中只记录脱敏的媒体源、路由类型、准备阶段、耗时和状态码。

## 配置与发布

1.0.0 使用独立的 Jellyfin MPV Player 配置目录，不迁移旧配置。版本号的唯一来源是 `package.json` 和 `src/data/release-notes.json`；`CHANGELOG.md` 与 Windows 发布说明由脚本生成。
