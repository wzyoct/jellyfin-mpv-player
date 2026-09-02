# Windows 发布与启动说明

## 用户启动

正式发布时下载 `Jellyfin-MPV-Player-v<版本>-win-x64.zip`，解压后直接双击 `Jellyfin MPV Player.exe`。不需要安装，也不会生成单文件自解压程序。

播放器不会附带 MPV 程序或 MPV 配置。用户需要分别准备播放器 ZIP、官方 Windows MPV 和独立的 `portable_config` 配置 ZIP。

便携配置、登录状态、缓存和诊断日志位于解压目录的 `data/`。日志文件在 `data/logs/`，应用会自动轮转并保留有限数量的历史文件。移动整个应用目录时请保留 `resources/`、`locales/` 和所有 DLL/PAK 运行文件。

## 本机运行目录

```text
解压目录/
├─ Jellyfin MPV Player.exe
├─ data/                       # 首次运行后产生，不属于发行 ZIP
├─ resources/
├─ locales/
├─ *.dll / *.pak / *.bin
├─ 00-启动说明.txt
└─ 发布信息/
```

`data/` 不属于 GitHub 发行 ZIP。它包含便携设置、加密登录令牌、图片缓存和 `logs/` 诊断日志，不应删除或提交到 Git。发行 ZIP 也不包含历史版本和构建内部文件。

## 打包命令

在项目根目录运行：

```powershell
npm run release:windows
```

该命令会依次完成版本检查、覆盖率测试、媒体服务器契约测试、类型构建、Windows `--dir` 解包构建，并在独立干净暂存目录中生成 `Jellyfin-MPV-Player-v<版本>-win-x64.zip` 和对应的 `.sha256` 文件。

发布前还需要检查：

- 解压 ZIP 后 `Jellyfin MPV Player.exe` 可直接启动且不弹安装器。
- 应用中的 MPV 路径可用，并由用户填写自己的完整路径。
- ZIP 中不存在 `data/`、设置、日志、历史版本或构建内部文件。

## GitHub 同步与版本存档

项目远程仓库：

`https://github.com/wzyoct/jellyfin-mpv-player.git`

每次面向用户的更新都按下面的顺序执行，确保程序、文档和 GitHub 提交保持一致：

1. 更新版本号，同时更新 `package.json` 和 `package-lock.json`：

   ```powershell
   npm version <新版本号> --no-git-tag-version
   ```

2. 在 `src/data/release-notes.json` 顶部增加同版本的日期、摘要和变更项。
3. 生成结构化更新文档：

   ```powershell
   npm run release:notes
   ```

   `CHANGELOG.md` 只能由该命令从 `src/data/release-notes.json` 生成，不要手工维护两份内容。

4. 运行正式 Windows 发布流程：

   ```powershell
   npm run release:windows
   ```

   该流程会先检查版本、测试和契约，再生成干净的 Windows x64 ZIP、启动说明、更新记录和 ZIP SHA256 校验值；不会读取或移动本机 `release/data`、历史版本或构建内部文件。

5. 检查差异和文件状态，只暂存本次更新涉及的源码与文档：

   ```powershell
   git diff --check
   git status
   git add <本次实际修改的文件>
   git diff --cached --check
   ```

6. 使用 Conventional Commits 格式创建存档提交，并推送当前分支：

   ```powershell
   git commit -m "chore: 发布 Jellyfin MPV Player <版本号>"
   git push origin HEAD
   ```

7. 需要让 GitHub 默认分支立即跟随当前正式版本时，在确认 `main` 没有独立提交后执行快进推送：

   ```powershell
   git push origin HEAD:main
   ```

Git 保存源码、配置和更新文档；便携运行文件和构建内部文件属于可再生产物，按项目 `.gitignore` 规则保留在本机 `release/`。GitHub Release 只上传干净 ZIP 和对应的 `.sha256` 文件。

## 注意事项

- 便携运行文件和构建内部文件是构建产物，不提交到 Git。
- 每次面向用户的发布都必须递增版本号并补充 `src/data/release-notes.json`。
- 当前未配置数字签名，Windows SmartScreen 可能显示未知发布者提示；发布前请核对 GitHub Release 中的 SHA256 文件。
