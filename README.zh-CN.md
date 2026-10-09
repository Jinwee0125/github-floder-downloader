<p align="center">
  <img src="icons/icon.svg" width="96" height="96" alt="GitHub Folder Downloader 图标" />
</p>

# GitHub 文件夹下载器

在 GitHub 仓库代码树页面中勾选文件与文件夹，打包为 ZIP 下载。

[English](README.md) · **简体中文**

## 功能

- 在代码视图头部、**Add file** 按钮左侧注入一个 **下载** 按钮。
- 点击后进入**选择模式**：每个文件/文件夹行左侧出现复选框。
- 可选择文件与文件夹（勾选文件夹会下载其下全部内容）。
- 支持**全选**、**反选**以及文件夹**半选**状态。
- 下载/打包过程显示**进度**。
- 可选 **Personal Access Token**，提升 GitHub API（文件列表）速率限制并支持私有仓库。
- 自动跳过子模块、符号链接与 Git LFS 指针文件。

## 工作原理

1. content script 检测到仓库代码树页面后注入工具栏。
2. 下载时，若勾选了文件夹或仓库为私有仓库，则用
   `GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1` 拉取一次完整文件树
   （返回 `truncated` 表示仓库文件数超过 10 万，会提示不支持）。
3. 公开仓库的每个文件从 `raw.githubusercontent.com` 抓取（不带 Token、不计入 API 配额），
   并发为 6，并带重试与退避；私有仓库改经 `api.github.com` 的 blob 接口
   （`Accept: application/vnd.github.raw`）逐个获取。
4. 文件以 STORE（不压缩）打包为 ZIP，保留仓库相对路径，最后通过 Blob URL 保存。

## 在 Chrome 中加载

1. 打开 `chrome://extensions`。
2. 右上角开启**开发者模式**。
3. 点击**加载已解压的扩展程序**，选择本目录。
4. 打开任意仓库的代码页，例如 `https://github.com/octocat/Hello-World`。

## 配置 Token（可选）

仅在需要提升文件列表配额或下载私有仓库时才需要：

打开扩展弹窗 → **打开设置**，或 `chrome://extensions` → 详情 → 扩展程序选项。
粘贴一个 fine-grained token，私有仓库需勾选 `Contents: Read`。
公开仓库无需 Token 即可下载（文件本体走 CDN，不计入 API 配额）。

## 已知限制

- 匿名 GitHub API（文件列表）限制约 60 次/小时；配置 Token 后为 5000 次/小时。
  公开仓库的文件下载走 CDN，不计入该配额。
- 文件数超过 100,000 的仓库暂不支持（文件树会被截断）。
- LFS 文件下载的是指针文件（尚未实现下载 LFS 真实内容）。
- 超大选择仅**提示**，不会阻止下载。

## 语言

界面通过 `chrome.i18n` 跟随浏览器语言。内置英文与简体中文；
其他语言会回退到英文。

## 许可证

MIT
