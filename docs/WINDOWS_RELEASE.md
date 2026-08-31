# Windows 发布与启动说明

## 用户只需要点击什么

每次正式打包后，打开项目根目录下的 `release/` 文件夹，直接双击根目录中的 `Ember Player.exe`。不需要安装、不需要解压，也不会生成单文件自解压程序。

便携配置、登录状态、缓存和诊断日志位于同目录的 `data/`。日志文件在 `data/logs/`，应用会自动轮转并保留有限数量的历史文件。移动整个 `release/` 文件夹时请保留 `resources/`、`locales/` 和所有 DLL/PAK 运行文件。

## 发布目录

```text
release/
├─ Ember Player.exe
├─ data/
├─ resources/
├─ locales/
├─ *.dll / *.pak / *.bin
├─ 00-启动说明.txt
├─ 发布信息/
├─ 历史版本/
└─ 构建内部文件/
```

`data/` 永远不参与发布文件覆盖、归档和 SHA256 计算。它包含便携设置、加密登录令牌、图片缓存和 `logs/` 诊断日志，不应删除或提交到 Git。`历史版本` 保存旧安装器和旧发布说明，`构建内部文件` 保存原始 `win-unpacked` 构建和旧运行文件；普通用户不需要打开这两个目录。

## 打包命令

在项目根目录运行：

```powershell
npm run dist
```

该命令会依次完成版本检查、字幕测试、Emby 契约测试、类型构建、Windows `--dir` 解包构建、目录整理、更新记录生成和 SHA256 校验值生成。

发布前还需要检查：

- `package.json`、`package-lock.json` 和更新记录版本一致。
- `release/Ember Player.exe` 双击后可直接启动且不弹安装器。
- 二次双击只聚焦已有窗口，不会启动第二个实例。
- 应用中的 MPV 路径可用。
- `release/data` 未被构建流程覆盖或计算校验值。

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

   该流程会先检查版本和测试，再生成根目录解包运行文件、启动说明、更新记录和 SHA256 校验值；旧版发布材料会自动移动到 `release/历史版本/<版本号>/`。

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

Git 保存源码、配置和更新文档；便携运行文件和构建内部文件属于可再生产物，按项目 `.gitignore` 规则保留在本机 `release/`，其中旧版本不会被覆盖。当前版本的更新记录和校验值位于 `release/发布信息/`。

## 注意事项

- 便携运行文件和构建内部文件是构建产物，不提交到 Git。
- 每次面向用户的发布都必须递增版本号并补充 `src/data/release-notes.json`。
- 未配置数字签名时，Windows SmartScreen 可能显示未知发布者提示；正式对外发布前应配置代码签名证书。
