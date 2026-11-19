# Windows 桌面：BTW 临时聊天排查

Windows DeepSeek Harness 的 `desktop` profile 与 WSL 的 `web` profile 独立。WSL 里能用 BTW 并不能证明 Windows 桌面安装了同一份插件。

## 先确认装到正确的 profile

在 **Windows PowerShell** 执行。由 WSL 操作时调用 Windows 的 `powershell.exe`，先切到 Windows 磁盘上的目录，避免 `dsh.cmd` 从 WSL UNC 工作目录启动。

```powershell
Get-Command dsh.cmd | Select-Object Source
dsh.cmd --version
dsh.cmd plugin --profile desktop list dsh-btw --depth 0
```

同时核对该实例实际使用的 `DSH_HOME`（Windows 默认 `%USERPROFILE%\.dsh`），确认 `profiles/desktop/package.json` 声明了 `dsh-btw`，且 `profiles/desktop/node_modules/dsh-btw` 确实存在。测试本地构建时，比对安装目录的 `cordis.yml`、`lib/index.js` 和 `lib/client.js` 的 SHA-256，避免把已发布版或旧打包当作当前 checkout。不要改 WSL 的 Web profile 来修复 Windows 缺包。

缺包时，通过桌面版自带的 CLI 恢复：

```powershell
dsh.cmd plugin --profile desktop add dsh-btw
# 验证指定本地版本时，用 Windows 磁盘上的持久 .tgz 路径代替包名。
```

如果用户要求在原窗口验证，就在原窗口新建空白会话确认插件是否已加载。不要另启动测试实例，也不要为了热加载失败自行重启原窗口；CLI 安装成功本身不等于 UI 已激活。

## 区分加载失败和开启失败

- 原窗口的空白页找不到「临时聊天」：先查桌面安装、加载状态及 BTW 的主页入口设置。
- 有入口，点了却显示「临时聊天未开启」：记录 DSH / BTW 版本、操作顺序、工作区是否已经选定和提示悬停文案（清理账号、路径等敏感信息）。这一步对应 `nativeOpen`；再按具体错误检查宿主存储版本和保护路由。不要关闭保护检查或手工删除回收记录来绕过错误。
- 只检查安装和入口时，可以开启再退出，外加核对本次回收记录；这属于冒烟测试。完整端到端验收必须从原生输入框实际发出合成消息、收到完整回复，再退出并核对会话及恢复记录清理。按 [验收规则](../AGENTS.md) 选择测试模型，不截取真实会话或记录访问凭证。

## 0.1.1 修复：已开启，输入框仍是工作区选择器

在 Windows 桌面 DSH `0.2.2-rc.5` 上，原生临时 Session 已在宿主创建且关联到工作区，但桌面客户端的工作区列表有时还不包含该 Session。宿主空白页只按工作区 `sessionIds` 认定归属，结果是临时状态已显示，原生输入框却仍用来选工作区。验收应检查能否编辑和发送，不能把输入框可见当作完成。

0.1.1 只在 Windows 的原生桌面页面补齐这一步：若客户端未看到该临时 ID，使用 DSH 公共 Workspace API 将该 ID「移动到自己之前」。这个操作不更改顺序；宿主返回的工作区状态由官方客户端合并。确认归属后才打开会话，超时会提示重试；退出能立即响应，后台等回执结束后再删除该临时会话，防止迟到回执把已退出的临时 ID 带回列表。不会为修复这一步重写 Web 配置或绕开存储保护。

本次 Windows `desktop` profile 一开始另有缺包，重装后恢复入口；实际发送才复现上述独立故障。原窗口用正式 0.1.1 包通过真实模型收发和退出清理，见 [验证记录](verification.md)和[收发截图](verification/windows/native-roundtrip-0.1.1.png)。
