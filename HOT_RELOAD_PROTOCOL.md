# Hot Reload Lifecycle Protocol

SillyTavern Extension Hot Reload 支持一个很小的可选协议，让目标扩展明确告诉更新器如何停止旧实例。协议不会改变 SillyTavern 的官方 hook 行为；不认识 `hot_reload` 的 SillyTavern 版本会自然忽略它。

## Manifest

推荐声明专用的 `hot_reload` hook：

```json
{
  "display_name": "My Extension",
  "js": "index.js",
  "hooks": {
    "activate": "onActivate",
    "update": "onUpdate",
    "disable": "onDisable",
    "hot_reload": "onHotUnload"
  }
}
```

查找清理函数的优先级为：

1. `hooks.hot_reload`；
2. `hooks.unload`；
3. `hooks.disable`。

热更新过程中不会调用 `clean` 或 `delete`。

删除扩展是独立流程：更新器会照常调用官方 `hooks.delete`，然后依次查找 `hot_reload`、`unload` 和 `disable` 来停止当前运行实例。`delete` 只表示“删除前执行”，不能单独证明脚本已从页面卸载。只有用户在删除确认框中主动勾选“同时清理扩展保存的数据”时，才会调用 `hooks.clean`。

## Hook context

清理、更新和激活 hook 会收到一个额外的上下文对象。普通 SillyTavern hook 不需要参数，因此已有函数可以忽略它。

```js
{
  reason: 'hot-update',
  extensionName: 'third-party/My-Extension',
  previousManifest: { /* 更新前 manifest 的副本 */ },
  manifest: { /* 更新后 manifest 的副本 */ }
}
```

## Reference implementation

```js
let controller;
let timer;
let observer;

export function onActivate() {
    // Activation must be idempotent.
    onHotUnload();

    controller = new AbortController();
    document.addEventListener('click', onClick, { signal: controller.signal });
    timer = window.setInterval(refresh, 30_000);
    observer = new MutationObserver(onMutation);
    observer.observe(document.body, { childList: true, subtree: true });

    if (!document.querySelector('#my-extension-root')) {
        document.body.append(createUi());
    }
}

export function onHotUnload() {
    controller?.abort();
    controller = undefined;
    window.clearInterval(timer);
    timer = undefined;
    observer?.disconnect();
    observer = undefined;
    document.querySelector('#my-extension-root')?.remove();
}

export function onDisable() {
    onHotUnload();
}

export async function onUpdate({ previousManifest, manifest } = {}) {
    // Only perform fast, repeatable data migrations here.
}
```

## Cleanup checklist

清理 hook 应当撤销该扩展本次激活创建的所有运行时资源：

- `addEventListener` / jQuery `.on()` 事件；
- `setTimeout`、`setInterval`、`requestAnimationFrame`；
- `MutationObserver`、`ResizeObserver`、`IntersectionObserver`；
- WebSocket、EventSource、Worker、媒体流；
- 插入的 DOM、菜单、按钮、弹窗；
- 注册到全局对象、事件总线或 slash command parser 的处理器；
- 未完成的 fetch（推荐集中使用 `AbortController`）。

用户设置和持久数据不应在 `hot_reload` 中删除。

## Module cache

更新器会给 manifest 中的 JS 入口添加 `st_hot_reload=<commit>-<timestamp>` 查询参数。浏览器因此会重新执行入口，但入口里的静态相对导入仍按它们各自的 URL 缓存。

可靠的发布方式有两个：

1. 将扩展打包为一个入口文件；或
2. 每次发布时同步更新本地导入的版本参数。

```js
import { start } from './runtime.js?v=1.4.0';
```

如果依赖图没有版本变化，热更新后可能出现“入口是新版、内部模块仍是旧版”的混合状态。

## Error handling

- 每个生命周期 hook 最多等待 5 秒；
- 新入口导入或激活失败时，更新器会尽力重新调用旧模块的 `activate` hook；
- Git pull 已经成功时，浏览器端回滚不会回滚仓库文件；下次正常刷新会加载磁盘上的新版本；
- 激活与卸载函数都应当可重复调用，以便错误恢复。
