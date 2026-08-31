# Windows 发布与启动说明

## 用户只需要点击什么

每次正式打包后，打开项目根目录下的 `release/` 文件夹，当前版本的安装包就在这里。

普通用户双击：

`01-双击安装（推荐）-Ember Player Setup-<版本号>.exe`

安装完成后，以后直接双击桌面或开始菜单中的 `Ember Player`。

不想安装时，解压：

`02-免安装绿色版-Ember Player-<版本号>.zip`

然后双击解压目录中的 `Ember Player.exe`。不要直接在压缩包预览窗口中运行它。

## 发布目录

```text
release/
├─ 00-先看这里-启动说明.txt
├─ 01-双击安装（推荐）-Ember Player Setup-<版本号>.exe
├─ 02-免安装绿色版-Ember Player-<版本号>.zip
├─ 03-更新记录.txt
├─ 04-文件校验值-SHA256.txt
├─ 历史版本/
└─ 构建内部文件/
```

打开 `release/` 就能看到当前版本的 EXE 和 ZIP。`历史版本` 保存旧版安装包，`构建内部文件` 保存 `blockmap`、`latest.yml`、`win-unpacked` 等调试或自动更新材料。普通用户不需要打开这两个目录。

## 打包命令

在项目根目录运行：

```powershell
npm run dist
```

该命令会依次完成版本检查、字幕测试、Emby 契约测试、类型构建、Windows 安装包构建、目录整理、更新记录生成和 SHA256 校验值生成。

发布前还需要检查：

- `package.json`、`package-lock.json` 和更新记录版本一致。
- 安装版双击后可以完成安装并启动。
- 绿色版解压后可以启动。
- 应用中的 MPV 路径可用。
- 桌面快捷方式和开始菜单入口名称正确。

## GitHub 同步与版本存档

项目远程仓库已经配置为：

`https://github.com/wzyoct/emby-mickey.git`

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
   npm run dist
   ```

   该流程会先检查版本和测试，再生成安装版、绿色版、启动说明、更新记录和 SHA256 校验值；旧版会自动移动到 `release/历史版本/<版本号>/`。

5. 检查差异和文件状态，只暂存本次更新涉及的源码与文档：

   ```powershell
   git diff --check
   git status
   git add <本次实际修改的文件>
   git diff --cached --check
   ```

6. 使用 Conventional Commits 格式创建存档提交，并推送当前分支：

   ```powershell
   git commit -m "chore: 发布 Ember Player <版本号>"
   git push origin HEAD
   ```

7. 需要让 GitHub 默认分支立即跟随当前正式版本时，在确认 `main` 没有独立提交后执行快进推送：

   ```powershell
   git push origin HEAD:main
   ```

Git 保存源码、配置和更新文档；安装包、绿色版和构建内部文件属于可再生产物，按项目 `.gitignore` 规则保留在本机 `release/`，其中旧版本不会被覆盖。当前版本的 Windows 文件名和校验值可直接查看 `release/03-更新记录.txt` 与 `release/04-文件校验值-SHA256.txt`。

## 注意事项

- 安装包和 ZIP 是构建产物，不提交到 Git。
- 每次面向用户的发布都必须递增版本号并补充 `src/data/release-notes.json`。
- 未配置数字签名时，Windows SmartScreen 可能显示未知发布者提示；正式对外发布前应配置代码签名证书。
