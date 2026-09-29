# dsh 0.1.2-alpha.1 加载失败踩坑（2026-08-29）

实测：源码构建的 dsh v0.1.2-alpha.1 上，dsh-btw 0.0.3 报

```
Failed to load plugins — dsh-btw
failed to apply loader entry 440257ea (dsh-btw):
slot "shell.overlay" is not declared (a parent entry's children table must declare it)
```

## 根因

0.1.2 浏览器模块系统改为「懒 CJS 表」：脚本执行只注册工厂、首次 import
才物化（`packages/client/modules/src/client/manifest.ts`），条目应用顺序
不再由树序保证。注册到**他人声明的 slot**必须用 inject 等待模式。

dsh-btw `lib/client.js` 里两处写法并存：

- `conversation.session.header.utilities` → `ctx.slots.inject(slot, () => register(...))` ✅ 两版都能过
- `shell.overlay`（BtwTempOverlay）→ 裸 `ctx.effect(() => ctx.slots.register(...))` ❌ 在 ui-layout 尚未物化时炸

## 修法（一处改动，向后兼容 0.1.1）

```js
fibers.push(ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register({ name: "shell.overlay", id: "btw", order: 30 }, BtwTempOverlay)));
```

`slots.inject` 在 0.1.1 已存在（btw 自己已在用），改后两版通吃，无需版本分支。

## 关联

outline 插件同病（`lib/client.js:549` 裸注册 shell.overlay），详见
`../outline/docs/compat-0.1.2-alpha.1.md`。
