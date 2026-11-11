# Connect WorkBuddy

把 **WorkBuddy / CodeBuddy** 的模型，接进 **VS Code Copilot Chat** 的模型下拉框 ——
和 GPT、Claude 等自带模型并列，直接切，不用换面板。

装好扩展、登录一次，模型选择器里就会多出 WorkBuddy 的模型。
不用起服务、不用记端口、不用填 base_url、不用手输模型名。

```
装扩展 → 登录一次 → 下拉框里出现 "DeepSeek-V4.1-Flash · 我的账号" → 选中就能用
```

> **📦 [下载最新版本](https://github.com/a2689307431/vscode-connect-workbuddy/releases)**

### 为什么不在 VS Code 应用市场？

这类扩展**无法上架官方 Marketplace**，不是没提交，是不能：

- 它的工作原理需要绕过上游的客户端识别（否则请求会被拦）
- 微软的开发者协议明确禁止规避第三方技术保护措施
- 硬要提交的结果是 publisher 账号被永久封禁

所以走 GitHub Release 分发。这既是合规的边界，也是对使用者负责 —— 详情见文末[免责声明](#免责声明)。

---

## 它能做什么

- 🧩 **接进 Copilot 的整套工作流** —— 模型出现在 Copilot Chat 的模型下拉框里，
  `@workspace`、`#file`、Agent 模式、自定义指令、MCP 工具都能照常用
- 🔀 **一个下拉框里切换** —— 和 GPT、Claude 等 Copilot 自带模型并列，不用在两个面板之间来回切
- 📊 **上下文占用实时显示** —— 聊天框底部的进度条显示真实 token 用量，
  知道离塞满还有多远，该不该开新会话
- 🔐 **OAuth 登录** —— 在浏览器里点几下就完成，不用手抄 token，凭据自动续期
- 🖼️ **支持图片** —— 截图、设计稿可以直接粘贴给模型
- 🧠 **思考过程折叠展示** —— 模型返回推理链时，会显示成可折叠的一整块
- 👥 **多账号** —— 登录多个账号，模型按账号分组列出，随时切换
- 💳 **状态栏看余额** —— 当前账号的剩余积分常驻状态栏，切账号自动跟着换
- 📅 **每日签到** —— 一个命令给所有账号签到，积分明细里直接看到连续天数
- 🔌 **零依赖** —— 不用装 Node.js，也不用装 WorkBuddy 桌面客户端，扩展自己管理后台进程
- 🛑 **不留后台** —— 关闭 VS Code，为它拉起的进程自动退出

---

## 和官方 CodeBuddy 插件的关系

腾讯官方有 [CodeBuddy 插件](https://marketplace.visualstudio.com/items?itemName=tencent-cloud.coding-copilot)，
它功能更全（代码补全、inline edit、多文件 diff），但**和本项目占的不是同一个位置**：

| | 官方 CodeBuddy 插件 | 本项目 |
|---|---|---|
| 界面 | 自己的侧边栏面板 | Copilot Chat |
| 和 Copilot 自带模型混用 | 不行，要切面板 | 同一个下拉框 |
| `@workspace` / Agent / MCP | 自己的一套 | 直接复用 Copilot 的 |
| 代码补全 / inline edit | ✅ | ❌ |
| 多账号分组 | — | ✅ |
| 状态栏积分 / 每日签到 | — | ✅ |

两边可以用同一个账号，不冲突。
**想要代码补全和 inline edit，用官方插件；想在 Copilot 里统一聊天，用这个。**

---

## 安装

### 前提

- VS Code **1.116.0** 或更高
- 已安装 **GitHub Copilot Chat** 扩展（免费版即可，模型请求由 WorkBuddy 侧处理）
- 一个 **WorkBuddy / CodeBuddy** 账号

> **不需要手动装 Node.js**。扩展会按顺序找可用运行时：
> 设置里的 `nodePath` → Windows 常见安装路径 → `PATH` 里的 `node` →
> 最后兜底用 VS Code 自带的 Electron。
>
> 如果系统里的 Node 低于 **v18**（比如 Ubuntu 22.04 自带的 v12），
> 扩展会自动跳过它、改用 VS Code 内置运行时，不会因此报错。
>
> VS Code Insiders / VSCodium / Cursor / Windsurf 也可以，模型分组配置文件会
> 按当前编辑器自己的目录去写。

### 步骤

1. 打开 **[Releases](https://github.com/a2689307431/vscode-connect-workbuddy/releases)** 页面，
   下载最新版 `vscode-connect-workbuddy-x.y.z.vsix`
2. 在 VS Code 里按 `Ctrl+Shift+P`（macOS 为 `Cmd+Shift+P`），输入 `Install from VSIX`，回车
3. 选中下载的 `.vsix` 文件
4. 再按 `Ctrl+Shift+P` → `Developer: Reload Window` 重载窗口

也可以用命令行安装：

```bash
code --install-extension vscode-connect-workbuddy-x.y.z.vsix --force
```

> ⚠️ **装完必须重载窗口**（`Ctrl+Shift+P` → `Developer: Reload Window`）。
>
> 扩展换的是磁盘上的文件，但**后台代理进程不会热更新** —— 不重载的话，
> 你看到的新版本界面下面，跑的仍然是旧代码。这种情况下功能看起来「没变化」
> 或者「修了但没生效」都是正常的。

#### 覆盖升级时遇到「没生效」

如果确认已经重载但还是旧行为，检查有没有残留的代理进程：

```powershell
# Windows
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*workbuddy-proxy*' } |
  Select-Object ProcessId, CommandLine
```

```bash
# Linux / macOS
ps aux | grep workbuddy-proxy | grep -v grep
```

如果命令行的路径指向**旧版本目录**（比如删掉的 `-0.8.0`），说明它是个残留进程。
结束它，再重载窗口：

```powershell
# Windows
Stop-Process -Id <PID> -Force
```

```bash
# Linux / macOS
kill <PID>
```

> 这种残留的成因：Windows 允许已启动的程序继续运行，即使它的目录被删了。
> 所以「覆盖安装 + 删旧目录」之后如果不重载，旧进程会一直活着。

### 从 0.7.8 及更早版本升级

> ⚠️ **升级前请先卸载旧版**，否则两个版本会同时工作，互相干扰。

0.7.9 起扩展 ID 从 `local.vscode-connect-workbuddy` 改成了
`connect-workbuddy.vscode-connect-workbuddy`（原来那个 `local` 是占位名）。
VS Code 把不同 ID 当**不同扩展**，直接装新版**不会顶掉旧版**，两个都还在。

**不卸载会怎样**（新版本会检测到并主动停用自己，但最好还是手动卸干净）：

- 模型下拉框里出现两份 WorkBuddy 模型
- 两个代理进程同时跑，同时刷新同一账号的 token
- 两边的 refreshToken 会互相让对方失效，表现为「登录反复失效」

**正确步骤**：

1. 扩展面板里找到旧版 `Connect WorkBuddy`（publisher 显示为 `local`），点卸载
2. 安装新版 `.vsix`
3. `Developer: Reload Window`
4. 登录状态会自动迁移，**不需要重新登录**

如果新版启动时提示「检测到旧版仍处于安装状态」，按弹窗里的「立即卸载」即可。

若升级后模型列表空了，执行一次 `WorkBuddy: 登录账号` 即可；也可以手动把
`<userDataDir>/globalStorage/local.vscode-connect-workbuddy/vault/`
整目录复制到
`<userDataDir>/globalStorage/connect-workbuddy.vscode-connect-workbuddy/vault/`。

---

## 首次使用

### 1. 登录

第一次启动时，右下角会弹出提示：

> WorkBuddy 还没有登录账号。登录后即可在 Copilot Chat 里直接使用 WorkBuddy 的模型。

点 **立即登录**，扩展会：

1. 在浏览器里打开 WorkBuddy 的授权页
2. 你登录并同意后，页面提示成功
3. 回到 VS Code，右下角出现「已登录 xxx」

也可以随时在命令面板执行 **`WorkBuddy: 登录账号`**，并选择国内站 / 国际站。

> 登录凭据只保存在本机的 VS Code 数据目录里，不会上传到任何第三方服务器。

### 2. 用起来

打开 Copilot Chat，点模型下拉框，会看到类似：

```
WorkBuddy
  ├─ DeepSeek-V4.1-Flash
  ├─ GLM-5.3
  └─ ...
```

选一个，正常聊天即可。模型列表是从你的账号动态拉取的 —— 你账号能用什么，这里就有什么。

### 3. 看上下文占用

聊天框底部会显示当前会话用了多少上下文，比如 `41/1M 个令牌`，
旁边的进度条和百分比会跟着每轮对话增长。

- 这些数字来自 **WorkBuddy 服务端返回的真实用量**，不是估算值
- 接近上限时，Copilot Chat 会提示你压缩或新建会话
- 如果一直显示 `0/1M`，先确认版本 ≥ **0.7.8**，再重载窗口

登录了多个账号后，下拉框会按账号分成几个组（见下面的 [多账号](#多账号)）：

```
WorkBuddy · 我的账号              WorkBuddy · 公司账号
  ├─ DeepSeek-V4.1-Flash           ├─ DeepSeek-V4.1-Flash
  ├─ GLM-5.3                       ├─ GLM-5.3
  └─ ...                           └─ ...
```

---

## 多账号

同一个扩展可以登录多个 WorkBuddy 账号（比如一个个人号、一个公司号）。

- 模型下拉框里每个账号占一个分组，组里只有该账号的模型，不会混在一起
- 也可以用 `WorkBuddy: 切换账号` 指定「默认账号」
- 某个账号的凭据失效时，请求会自动顺延到下一个可用账号
- 切换账号时，选择列表里会直接显示每个账号还剩多少积分

### 账号分组是怎么来的

VS Code 的模型下拉框只认它自己配置文件里的分组，扩展没法凭空建一个。
所以扩展会往 `chatLanguageModels.json` 里写一条「WorkBuddy · 账号名」：

- 登录新账号、或首次激活时会**自动同步**
- 也可以手动执行 `WorkBuddy: 按账号生成模型分组`
- **写完需要重载窗口**（`Developer: Reload Window`）才会生效
- 账号退登后，对应的分组会在下次同步时自动清掉

> 这个文件是 VS Code 的用户配置，扩展改动前会留一份 `.workbuddy-bak` 备份。
> 不想用分组的话，把它删掉即可 —— 模型会退回一个平铺的列表。

---

## 查看剩余积分

登录后右下角状态栏会显示当前账号的剩余积分，比如 `1284`。

- 鼠标悬停可以看到账号名、最近到期时间、有没有积分快过期
- **点一下**打开明细：每个积分包还剩多少 / 总量多少、是每月重置还是某天到期
- 每 5 分钟自动刷新（可在设置里改间隔或直接关掉）
- 切换到别的账号后立刻重新读一次
- 积分快用完时状态栏会变黄

> 明细由上游的用量接口实时返回，和你登录 codebuddy.cn 后在网页上看到的数字一致。

---

## 每日签到

命令面板 → **`WorkBuddy: 每日签到`**，会依次给所有已登录账号签到，结果显示在弹窗里，
每个账号的「今日已签 / 连续 N 天 / 今日 +N」也会出现在积分明细中。

签到是**幂等**的：今天已经签过会直接提示「今日已签」，不会重复扣减或报错。

想每天自动签到的话，打开设置：

```jsonc
"connect-workbuddy.autoCheckin": true
```

开启后，**每天第一次启动 VS Code** 时会在后台自动签一次（每个账号每天最多一次；
如果全部失败，下次启动会重试）。默认是关闭的 —— 签到接口属于计费接口，
手动执行更稳妥。

> 签到逻辑运行在本地代理里，和聊天共用同一份登录凭据，不需要再单独安装别的工具。

---

## 命令

| 命令 | 作用 |
|---|---|
| `WorkBuddy: 登录账号` | 打开浏览器登录，支持国内站（codebuddy.cn）与国际站（workbuddy.ai） |
| `WorkBuddy: 切换账号` | 选择默认账号（列表里带每个账号的剩余积分） |
| `WorkBuddy: 查看剩余积分` | 弹出积分明细，可切换查看其它账号 |
| `WorkBuddy: 每日签到` | 给所有账号签到，已签过的会跳过 |
| `WorkBuddy: 按账号生成模型分组` | 往模型下拉框写入「每账号一组」，写完需重载窗口 |
| `WorkBuddy: 刷新模型列表` | 账号权限或模型清单变化后重新拉取 |
| `WorkBuddy: 显示日志` | 打开输出面板，排查问题用 |

---

## 设置

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `connect-workbuddy.proxyUrl` | 空 | 留空 = 自动管理（推荐）。填了地址则完全使用外部端点，扩展不再插手 |
| `connect-workbuddy.nodePath` | 空 | 运行代理用的 Node 路径。留空自动探测，都找不到时使用 VS Code 自带的 Electron |
| `connect-workbuddy.debug` | `false` | 在输出面板打印详细日志（排查问题时打开） |
| `connect-workbuddy.hideLoginPrompt` | `false` | 不再在启动时提示登录（仍可用命令登录） |
| `connect-workbuddy.showCreditsInStatusBar` | `true` | 在状态栏显示剩余积分 |
| `connect-workbuddy.creditsRefreshSeconds` | `300` | 状态栏积分的自动刷新间隔（秒），最小 60 |
| `connect-workbuddy.autoCheckin` | `false` | 每天首次启动时自动签到（每账号每天最多一次） |
| `connect-workbuddy.apiKey` | `workbuddy-local-proxy` | 占位值，仅用于外部代理场景。自动管理时真正的凭据由扩展注入，**不用改** |

---

## 支持的平台

| 平台 | 状态 | 说明 |
|---|---|---|
| Windows | ✅ 主要开发平台 | 完整验证 |
| macOS | ✅ 代码层面适配 | 路径 / 权限 / 子进程均有平台分支，未做大量实机验证 |
| Linux | ⚠️ 可用但验证较少 | 见下 |

### 关于 Linux

WorkBuddy 官方没有 Linux 客户端，但本扩展**不需要**它 ——
登录走的是浏览器 OAuth，代理直接与 WorkBuddy 服务端通信。

Linux 上需要留意：

- **凭据权限**：`vault/` 目录会建成 `0700`、凭据文件 `0600`（明文 token，别用 root 跑）
- **node 探测**：先看设置里的 `nodePath`，再从 `PATH` 里找 `node`，
  最后兜底用 VS Code 自带的 Electron
- **无图形界面**：没有浏览器时，登录会弹窗给出授权链接，可复制到别处打开

遇到问题请连同 `WorkBuddy: 显示日志` 的输出一起提 issue。

---

## 工作原理

```
VS Code Copilot Chat
        ↓  languageModelChatProviders（VS Code 稳定 API）
   本扩展  extension.js
        ↓  http://127.0.0.1:<随机端口>，进程内随机 Bearer token
   代理进程  proxy/workbuddy-proxy.mjs
        ↓  import lib/host-heartbeat-*.js（第三方模块，负责请求整形）
        ↓  HTTPS
   WorkBuddy 服务端
```

**为什么中间要隔一层代理**：

1. 凭据刷新只能一个进程做 —— 两个进程同时刷新会让对方的 refreshToken 失效
2. 子进程崩了不影响扩展宿主
3. 请求体整形逻辑是独立模块，隔离在代理里便于升级

扩展启动时自动拉起代理，并且：

- 端口随机，只监听 `127.0.0.1`（不对外网开放）
- 每次启动生成随机 Bearer token，只有本扩展知道
- 关闭 VS Code 时，扩展只结束自己拉起的那个进程（Windows 用 `taskkill /T /F`）

每日签到也走这一层代理（`POST /checkin`），不额外起服务，也不另存凭据。

已经手动在 `127.0.0.1:8799` 起了代理的话，扩展会直接复用它。

### 数据放在哪

| 内容 | 位置 |
|---|---|
| 登录凭据 | `<globalStorage>/vault/<区域>/*.json`（明文 token，POSIX 权限 0600） |
| 设备标识 | `<globalStorage>/dsh-home/.workbuddy-device.json`（64 字符随机盐，**不是凭据**） |
| 模型分组 | `<userDataDir>/chatLanguageModels.json`（VS Code 自己的配置，改动前会留备份） |

---

## 故障排查

### 模型下拉框里没有 WorkBuddy

1. 命令面板 → `WorkBuddy: 显示日志`，看有没有 `已发现 N 个 WorkBuddy 账号`
2. 没有账号：执行 `WorkBuddy: 登录账号`
3. 日志里报代理起不来：看 `[proxy:err]` 那几行，通常是 Node 版本或权限问题
   （扩展现在会把 stderr 最后几行带进错误提示）

### 提示「请先卸载旧版本扩展」

说明机器上同时装着旧 ID（`local.vscode-connect-workbuddy`）的新版。
两个版本会同时注册模型、同时刷新凭据，导致登录反复失效。

按弹窗里的「立即卸载」，然后重载窗口即可。

### 报了 `fetch is not defined` 或 `AbortSignal.timeout is not a function`

说明实际运行的 Node 太老（低于 v18）。代理用到了这两个特性。

- 清空设置 `connect-workbuddy.nodePath`，让扩展自动挑选可用运行时
- 或把 Node 升级到 v18 以上
- Linux 上如果 `which node` 指向很老的版本（如 Ubuntu 22.04 的 v12），
  扩展会自动跳过它

### Linux / macOS 上代理进程残留

正常情况下关闭 VS Code 会结束代理。如果 VS Code 崩溃或被强杀，
代理会自己检测到父进程消失并退出（POSIX 上轮询 ppid，Windows 上监听 stdin EOF），
最多 10 秒。

万一仍有残留：

```bash
# Linux / macOS
pkill -f workbuddy-proxy.mjs
```

```powershell
# Windows
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*workbuddy-proxy*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

### 登录会被自动续期吗

会。凭据里有两把钥匙：

| 字段 | 有效期 | 作用 |
|---|---|---|
| `accessToken` | 约 **30 天** | 每个请求实际带的那个 |
| `refreshToken` | 约 **60 天** | 用来换新的 accessToken |

代理在 accessToken 剩不到 6 小时时自动续期，续期结果会写回本地 vault。
所以正常情况下**不需要手动重新登录**——除非 `refreshToken` 本身失效了
（过期、被服务端吊销、或同一账号在别处重新登录导致旧的一串失效）。

> 曾经出现过「只用了两天就提示登录失效」的情况，日志里其实是
> `fetch failed`（网络不通），并不是凭据过期。注意区分这两类。

### 报了 401 / 11217 / 未登录

凭据过期或被吊销。执行 `WorkBuddy: 登录账号` 重新登录一次。

### 日志里出现 `fetch failed`

这是**网络层**错误（DNS 解析失败、连接被重置、超时、被代理软件拦截），
和登录状态无关 —— 重新登录解决不了根本问题。

新版日志会把真正的原因带出来，例如：

```
模型目录异常：fetch failed ← ENOTFOUND / getaddrinfo ENOTFOUND copilot.tencent.com
模型目录异常：fetch failed ← ECONNRESET
```

排查方向：

1. 换个网络试（手机热点），确认不是本地网络/路由器问题
2. 关闭代理软件（Clash / v2ray 等）的 TUN 模式或换规则再试
3. 公司网络/校园网可能拦截了 `copilot.tencent.com`，用浏览器打开确认
4. Windows 上偶尔是 IPv6 解析问题：新版 Node（22+）才默认开启 happy-eyeballs

> 如果浏览器能打开 codebuddy.cn 但扩展报 `fetch failed`，优先怀疑第 2、4 条。

### 报了 14003 / 模型繁忙

上游限流。等一会儿重试，或在模型下拉框里换一个账号。

### 回复里看不到思考过程

不是所有模型都有思考过程。上游是否返回独立的 `reasoning_content` 由模型和服务端决定，
扩展无法强制开启；部分模型会直接把推理过程混在正文里输出。

能正常显示时，思考区应该是一**整块**、标题里的秒数持续增长（`Thought for 12s`）。
如果看到的是一长串「Thought for 1s」碎片（每块只有一两个字），说明版本旧了，
升级到 0.7.6 及以上。

### 上下文窗口一直显示 0/1M

先确认版本 ≥ **0.7.8**，装完执行 `Developer: Reload Window`。

仍然为 0 的话，打开 `WorkBuddy: 显示日志`，把 `debug` 设为 `true` 后发一句话，
日志里应该有：

```
上下文用量：prompt=41 completion=49
```

- 有这行但界面还是 0 → 上报格式和当前 Copilot Chat 版本不匹配，请提 issue 并附版本号
- 没有这行 → 上游没返回 usage，把日志一起发来

### 思考块碎片化或空白块

- **一长串「Thought for 1s」**（每块只有一两个字）：版本 < 0.7.6，升级即可
- **每个工具调用前多一个空思考块**：版本 0.7.6，升级到 0.7.7 及以上

### 升级后模型列表空了

0.7.9 起扩展 ID 变了（`local.` → `connect-workbuddy.`），
`globalStorage` 路径跟着变。扩展会自动迁移旧凭据，但如果你中途装回了旧版本
或手动删过目录，可能会漏。

执行一次 `WorkBuddy: 登录账号` 即可恢复；也可以手动复制
`globalStorage/local.vscode-connect-workbuddy/vault/` 到新目录。

### 模型名字都很陌生，点了全都报错

比如下拉框里出现 `fast-model`、`balanced-model`、`gpt-5.6-sol` 这类名字，
但你账号里根本没这些模型 —— 说明**模型清单拉错了区域**。

国内账号的模型和国外账号完全不重叠。打开 `WorkBuddy: 显示日志`，看这一行：

```
[cn] 已同步 14 个模型：hy4-preview, hy3, deepseek-v4.1-flash, ...
```

方括号里的区域应该和你账号所属的站点一致（`codebuddy.cn` → `cn`，`workbuddy.ai` → `global`）。
对不上的话请提 issue，带上日志。

### 模型下拉框里出现了重复的分组

说明 `chatLanguageModels.json` 里有旧版残留的条目。
删掉那几条后再重载窗口，然后执行 `WorkBuddy: 按账号生成模型分组` 重建。

### 登录成功了，但账号数没有增加

如果那个账号之前已经登录过，扩展会明确提示「这个账号之前已经登录过了」。
常见原因是**浏览器里还留着上一个账号的登录状态**，点授权页时自动沿用了旧账号。

处理办法：先在浏览器里退出 WorkBuddy / CodeBuddy 登录，或用无痕窗口打开授权页，
再执行一次 `WorkBuddy: 登录账号`。

### 账号数比实际少一个

扩展默认只读自己 `globalStorage` 下的 vault。如果你之前用**别的工具**
（DSH 插件、签到工具等）登录过账号，那份凭据在 `~/.dsh/workbuddy-vault/` 里，
扩展会在启动时把缺失的账号**自动补齐**过来（只读旧目录，不删不改）。

日志里会有一行：

```
导入   : 另一个账号（来自旧 vault）
```

没生效的话执行一次 `WorkBuddy: 刷新模型列表`，或检查 `~/.dsh/workbuddy-vault/<区域>/`
里是否有对应的 `*.json`。

### 签到报「当前代理不支持签到」

说明连上的不是扩展自己拉起的代理 —— 常见于设置里填了 `connect-workbuddy.proxyUrl`，
或者复用了旧版手动启动的代理。清空 `proxyUrl` 让扩展自己拉起，或把外部代理升级到 0.6.0 以上。

### 签到报 401 / 登录已失效

凭据过期。执行 `WorkBuddy: 登录账号` 重新登录，再签一次。

### 签到提示「没有进行中的签到活动」

账号侧没有开放签到活动（新账号、活动已结束，或部分企业账号）。
这不是扩展的问题，去 WorkBuddy 客户端里确认活动是否存在。

### 签到成功但余额没变

弹窗里的 `+N` 来自签到接口，余额是另一个接口查的，上游偶尔有延迟。
看到「连续天数」增加了就说明成功了，别重复点。

### 其他问题

命令面板 → `WorkBuddy: 显示日志`，带上输出面板内容提 issue。

---

## 隐私

- 对话内容只在你、VS Code、WorkBuddy 服务端之间传输
- 扩展**不做任何遥测**，不上报任何数据，没有内置统计/埋点
- 登录凭据存在本机 VS Code 的 `globalStorage/vault/` 下，
  POSIX 上目录 `0700`、文件 `0600`
- 设备标识用的随机盐（64 字符，**不是凭据、不含账号信息**）放在 `globalStorage/dsh-home/`
  —— **不会往家目录写任何文件**
- 如果机器上原本就有 `~/.dsh`（装过 DSH 插件），扩展会**只读**它来补上缺失的账号，
  并把已有的设备盐复制一份过来（保持设备身份不变），之后不再读写该目录
- 模型分组会写 `chatLanguageModels.json`（VS Code 自己的配置），
  改动前留一份 `.workbuddy-bak` 备份

---

## 免责声明

本项目**非官方**，与腾讯、WorkBuddy、CodeBuddy 无任何关联。

- 仅供学习与研究
- 使用非官方客户端访问服务**可能违反 WorkBuddy 的服务条款**，存在账号受限的风险
- 请使用**你自己的**账号与订阅
- 因使用本项目造成的任何后果由使用者自行承担

---

## 致谢

本项目的实现参考了以下开源项目，感谢作者的工作。
完整的版权与许可声明见 [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)。

| 项目 | 许可 | 本项目的使用方式 |
|---|---|---|
| `dsh-connect-workbuddy`（LaoDing） | MIT | **内嵌了 `lib/host-heartbeat-*.js`**（当前对应其 `5.21.3`），并调用其中的 `prepareChatBody` / `perturbChannelFingerprints`。这是本项目能与上游稳定通信的关键 |
| `Sliverkiss/workbuddy2api` | MIT | 上游协议细节（基址选择、强制流式、CLI 形态请求头）的参考实现 |
| `corrinehu/dsh-workbuddy-connect` | MIT | 本地代理的入站加固（回环校验、随机端口、随机 secret）与错误映射设计的参考 |

其中 `lib/host-heartbeat-WSrMdV6b.js` 是**原样再分发**（仅在文件头追加了归属说明），
文件头保留了原始版权与许可声明，请勿删除。

---

## 开发

```bash
git clone https://github.com/a2689307431/vscode-connect-workbuddy.git
cd vscode-connect-workbuddy
```

目录结构：

```
extension.js                 扩展入口：提供方、代理生命周期、命令、状态栏、签到
proxy/workbuddy-proxy.mjs    本地代理：OAuth、凭据池、请求整形、积分、签到、错误分类
lib/host-heartbeat-*.js      第三方模块（源自 dsh-connect-workbuddy，MIT），
                             负责请求体整形与通道指纹，原样再分发、不要手改
lib/package.json             记录上游版本与 sha256
scripts/check-upstream.mjs   对比上游版本、校验内嵌文件 sha256
proxy/tests/*.mjs            手工回归脚本，不进 vsix
```

重新打包：

```bash
npm exec --yes --package @vscode/vsce -- vsce package --allow-missing-repository
```

检查上游是否有新版：

```bash
npm run check:upstream
```

改动后建议至少跑：

```bash
node --check extension.js
node --check proxy/workbuddy-proxy.mjs
```

更详细的实现约束与踩坑记录不在仓库里（避免泄露本机信息）。

## 许可

[MIT](./LICENSE)

内嵌的第三方模块遵循其原始 MIT 许可，版权与许可声明见
[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)。

---

<sub>

**关键词**：WorkBuddy · CodeBuddy · 腾讯 Copilot · CodeBuddy 插件 · VS Code ·
Visual Studio Code · Copilot Chat · GitHub Copilot · 模型下拉框 · 自定义模型 ·
`languageModelChatProviders` · Language Model Chat Provider · BYOK · Bring Your Own Key ·
DeepSeek V4 · DeepSeek-V4.1-Flash · GLM · Kimi · MiniMax · 混元 ·
多账号 · 多账号切换 · 额度查看 · 剩余积分 · 每日签到 · 自动签到 ·
VS Code 扩展 · VS Code extension · Windows · macOS · Linux ·
非官方 · unofficial · 学习研究

</sub>
