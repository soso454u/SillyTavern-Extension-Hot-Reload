# SillyTavern Extension Hot Reload

一个用于 SillyTavern 第三方 UI 扩展的智能热更新器。它接管扩展管理器里的单个“更新”按钮，并提供“智能热更新全部”，尽量让更新后的 CSS 和 JavaScript 不刷新整页就直接生效。

> 重点：浏览器没有通用的 ES Module 卸载 API。这个插件不会假装所有扩展都能安全热替换。默认的安全模式会检查扩展是否提供生命周期清理钩子；没有钩子时只更新仓库和可安全替换的样式，并保留旧脚本继续运行。

## 功能

- 继续使用 SillyTavern 官方 `/api/extensions/update` 接口拉取 Git 更新；
- 直接接管扩展列表里原有的单个更新按钮；
- 在扩展管理器中加入“智能热更新全部”；
- 通过带版本参数的新 `<link>` 无闪烁替换 CSS；
- 对提供 `hot_reload`、`unload` 或 `disable` 钩子的扩展，先清理旧运行时，再导入新入口并调用 `update` / `activate`；
- 对已禁用的扩展只更新文件，不会意外启用其脚本或样式；
- 提供可选的“实验性强制热载入”，用于没有清理钩子的单文件/打包扩展；
- 更新单个扩展失败时不会触发整页刷新，也不会影响批量队列中的其他扩展。

## 安装

1. 打开 SillyTavern。
2. 进入“扩展” → “安装扩展”。
3. 粘贴本仓库的 Git URL。
4. 安装完成后，在扩展设置里展开“扩展热更新”。

仓库发布后可直接使用：

```text
https://github.com/soso454u/SillyTavern-Extension-Hot-Reload
```

## 使用

打开“管理扩展”，等待 SillyTavern 完成更新检查：

- 点击某个扩展右侧原有的下载图标：插件会自动执行智能热更新；
- 点击工具栏中的火焰按钮“智能热更新全部”：顺序更新当前检测到的全部可用更新；
- 如果提示“已更新并热载入”，当前页面已经使用新代码；
- 如果提示“脚本没有清理钩子”，Git 文件和 CSS 已更新，旧 JavaScript 会安全地继续运行到下次正常刷新。

SillyTavern 原生的“Update all / 更新全部”仍保留原行为。想避免它在关闭管理窗口后刷新页面，请使用本插件加入的火焰按钮。

## 两种脚本策略

### 安全模式（默认）

只有下列情况会在当前页面重新导入 JavaScript：

- 扩展此前没有运行脚本，但新版本首次增加了脚本；
- 扩展 manifest 声明了可调用的 `hot_reload` 或 `unload` 钩子；
- 扩展声明了官方 `disable` 钩子，插件可用它停止旧运行时。

这是日常使用推荐的设置。

### 实验性强制热载入

即使扩展没有清理钩子，也会导入带缓存破坏参数的新入口文件。旧模块本身仍留在内存中；如果它注册过未清理的事件、定时器、观察器或全局对象，可能出现重复执行。遇到异常时刷新一次页面即可恢复干净状态。

## 能与不能热更新的内容

| 内容 | 默认行为 |
|---|---|
| CSS | 安全换新并立即生效 |
| 已禁用扩展 | 只更新磁盘文件，不加载运行时 |
| 带清理钩子的 JS | 清理旧实例，导入新入口并重新激活 |
| 无清理钩子的 JS | 安全模式不强制替换；可手动启用实验模式 |
| HTML 模板 / 本地化 | 取决于目标扩展是否会在激活时重新渲染 |
| 多文件 ES Module 依赖 | 目标扩展需要打包为单入口，或在发布时给相对导入路径更新版本参数 |
| SillyTavern 服务端插件 | 不在本插件范围内，通常需要重启服务端 |

## 给扩展作者

只需提供一个幂等的激活函数和一个彻底的卸载函数，即可进入最可靠的安全热更新路径。完整协议、示例和检查清单见 [HOT_RELOAD_PROTOCOL.md](HOT_RELOAD_PROTOCOL.md)。

最小 manifest 示例：

```json
{
  "js": "index.js",
  "hooks": {
    "activate": "onActivate",
    "update": "onUpdate",
    "hot_reload": "onHotUnload"
  }
}
```

## 安全说明

- 不使用 `eval`、远程脚本或第三方更新服务器；
- 只请求当前 SillyTavern 实例的同源扩展文件；
- Git 拉取、权限检查和路径清理由 SillyTavern 服务端完成；
- `clean` 钩子永远不会被热更新流程调用，避免误删扩展数据；
- 生命周期钩子设有 5 秒超时。

第三方扩展本身拥有与 SillyTavern 页面相同的权限。请只安装你信任的仓库。可参考 SillyTavern 官方的 [扩展使用说明](https://docs.sillytavern.app/extensions/) 与 [UI 扩展开发文档](https://docs.sillytavern.app/for-contributors/writing-extensions/)。

## 开发

无需构建步骤。仓库根目录就是可安装的 SillyTavern 扩展。

```bash
npm test
npm run check
```

## License

[MIT](LICENSE)
