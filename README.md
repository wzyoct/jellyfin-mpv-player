# Jellyfin MPV Player

Jellyfin MPV Player 是一个非官方的 Windows x64 Jellyfin 桌面客户端，使用 MPV 负责媒体播放。

## 使用前提

- Windows 10 或 Windows 11（64 位）
- Jellyfin 10.11.x
- MediaWarp 0.2.4 或更高版本
- MPV 0.41 或更高版本

播放器通过 MediaWarp 访问 Jellyfin，不附带 MPV 程序，也不附带 MPV 配置。稳定版请从 [Latest Release](https://github.com/wzyoct/jellyfin-mpv-player/releases/latest) 下载，发行包名称为 `Jellyfin-MPV-Player-v<版本>-win-x64.zip`。

## 安装

需要分别准备以下三部分：

1. 从 Latest Release 下载 `Jellyfin-MPV-Player-v<版本>-win-x64.zip`，解压到任意目录。
2. 从 [MPV 官方安装页](https://mpv.io/installation/) 下载 Windows MPV，并记下 `mpv.exe` 的完整路径。
3. 从独立的 [mpv-config Releases](https://github.com/wzyoct/mpv-config/releases) 下载 `mpv-portable-config-v1.0.0.zip`，将 ZIP 顶层的 `portable_config/` 解压到 `mpv.exe` 同目录。
4. 启动 `Jellyfin MPV Player.exe`，在设置中填写你自己的 MPV 完整路径，然后连接经过 MediaWarp 的 Jellyfin 地址。

播放器的登录数据、缓存和日志只保存在解压目录的 `data/` 中。`data/` 不属于发行 ZIP，也不应提交到 Git。

未配置 Windows 代码签名证书，首次启动时 SmartScreen 可能显示未知发布者提示；请先核对 Release 中的 SHA256 文件。

## 兼容性与轨道规则

继续观看使用 Jellyfin 的 `/Users/{userId}/Items/Resume` 端点，要求服务端或 MediaWarp 插件支持该标准接口；播放器不再调用旧的 `IsResumable` 过滤器。播放器按 `UserData.LastPlayedDate` 稳定降序排列；同一剧集按 `SeriesId` 聚合并保留最近播放单集，电影及缺少 `SeriesId` 的项目按自身 ID 去重。时间缺失、无效或相同时保留服务端原始相对顺序。

字幕默认优先级为：外挂简中、外挂其他中文、服务端默认外挂、第一条外挂；只有没有外挂时才按内嵌简中、内嵌其他中文、服务端默认内嵌选择。`DeliveryMethod=Encode` 表示已烧录进画面的字幕，不作为可选轨道，也不会映射到 MPV。服务器外挂字幕按 `DeliveryUrl → 本地鉴权网关 → MPV` 加载；播放前也可以在详情页选择本地 ASS、SSA、SRT、VTT、SMI 或 SUB 文件，用户选择的本地字幕会覆盖该媒体的服务器自动字幕。

遇到继续观看刷新或字幕加载问题，先在设置中打开日志目录，查看 `data/logs/` 中对应时间的 JSONL 日志，同时核对 MPV、MediaWarp 和 Jellyfin 版本；不要把令牌、设置或日志提交到仓库。

## 开发

```powershell
npm ci
npm run dev
```

常用检查：

```powershell
npm test
npm run test:coverage
npm run typecheck
npm run test:contract
npm run release:check
```

Windows x64 发行包使用：

```powershell
npm run release:windows
```

该命令在独立的临时目录构建并压缩发行文件，只生成播放器、运行时文件、启动说明、更新记录和 ZIP 校验文件；不会读取或打包 `data/`、设置、日志、历史版本或构建内部文件。

## 仓库关系

播放器和 MPV 配置保持为两个独立仓库。播放器源码不包含 MPV 二进制或配置仓库代码；配置仓库的安装方式和第三方许可见 [mpv-config README](https://github.com/wzyoct/mpv-config#readme)。

## 许可

播放器自有代码使用 [MIT License](LICENSE)。
