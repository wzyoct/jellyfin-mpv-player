# Windows 发布与启动说明

## 用户只需要点击什么

每次正式打包后，打开 `release/当前版本-Ember Player <版本号>` 文件夹。

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
├─ 当前版本-Ember Player <版本号>/
│  ├─ 00-启动说明.txt
│  ├─ 01-双击安装（推荐）-Ember Player Setup-<版本号>.exe
│  ├─ 02-免安装绿色版-Ember Player-<版本号>.zip
│  ├─ 更新记录.txt
│  └─ 文件校验值-SHA256.txt
├─ 历史版本/
└─ 构建内部文件/
```

`历史版本` 保存旧版安装包，`构建内部文件` 保存 `blockmap`、`latest.yml`、`win-unpacked` 等调试或自动更新材料。普通用户不需要打开这两个目录。

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

## 注意事项

- 安装包和 ZIP 是构建产物，不提交到 Git。
- 每次面向用户的发布都必须递增版本号并补充 `src/data/release-notes.json`。
- 未配置数字签名时，Windows SmartScreen 可能显示未知发布者提示；正式对外发布前应配置代码签名证书。
