# Connect WorkBuddy

把 **WorkBuddy / CodeBuddy** 的模型接进 **VS Code Copilot Chat** 的模型下拉框，
和 GPT、Claude 等自带模型并列，直接切换，不用在两个面板之间来回跳。

装好扩展、登录一次即可 —— 不需要起服务、不需要填接口地址、不需要手抄模型名。

> **📦 [下载最新版本](https://github.com/a2689307431/vscode-connect-workbuddy/releases)**

## 为什么不在 VS Code 应用市场

本扩展只在 GitHub 发布，没有上架 Marketplace。它的实现方式（把 WorkBuddy 的服务
当作 OpenAI 兼容端点接到编辑器里）属于 Marketplace 不允许的类别，提交后会被下架，
发布者账号也可能被封禁。

所以源码全部公开、以 MIT 许可发布，任何人都可以自行审阅和构建；分发走
GitHub Release 是唯一可行的方式。使用前请先读文末的[免责声明](#免责声明)。

---

## 它能做什么

| 能力 | 说明 |
|---|---|
| 接进 Copilot 工作流 | 模型出现在 Copilot Chat 的下拉框里，`@workspace`、`#file`、Agent 模式、自定义指令、MCP 工具都能照常用 |
| 和自带模型并列 | 同一个下拉框里切 GPT / Claude / WorkBuddy，不用换面板 |
| 上下文用量实时显示 | 底部的 token 进度条来自服务端真实用量，不是估算 |
| OAuth 登录 | 浏览器里点几下完成，凭据自动续期，不用手抄 token |
| 图片输入 | 截图、设计稿可以直接粘贴给模型 |
| 思考过程折叠 | 模型返回推理链时显示成可折叠的一整块 |
| 多账号 | 登录多个账号，模型按账号分组，随时切换 |
| 状态栏余额 | 当前账号的剩余积分常驻右下角，切模型即刻跟随 |
| 每日签到 | 一条命令给所有账号签到，并显示连续天数 |
| 开箱可用 | 不用另装 Node.js 或 WorkBuddy 桌面客户端，扩展会自己找可用运行时 |
| 退出即清理 | 关掉 VS Code，为它拉起的代理进程会自动结束 |

### 和官方 CodeBuddy 插件的关系

腾讯官方有 [CodeBuddy 插件](https://marketplace.visualstudio.com/items?itemName=tencent-cloud.coding-copilot)，
功能更全（代码补全、inline edit、多文件 diff），但和本项目不是同一个定位：

| | 官方 CodeBuddy 插件 | 本项目 |
|---|---|---|
| 界面 | 自己的侧边栏面板 | Copilot Chat |
| 与 Copilot 自带模型混用 | 不行，要切面板 | 同一个下拉框 |
| `@workspace` / Agent / MCP | 自己的一套 | 复用 Copilot 的 |
| 代码补全 / inline edit | ✅ | ❌ |
| 多账号分组 | — | ✅ |
| 状态栏积分 / 每日签到 | — | ✅ |

两者可以用同一个账号，互不冲突：
**需要补全和 inline edit 就用官方插件，想在 Copilot 里统一聊天就用这个。**

---

## 安装

### 前提

- VS Code **1.116.0** 或更高
- 已安装 **GitHub Copilot Chat** 扩展（免费版即可，模型请求由 WorkBuddy 侧处理）
- 一个 **WorkBuddy / CodeBuddy** 账号

> **不需要手动装 Node.js。** 扩展按以下顺序找运行时：设置里的 `nodePath` →
> Windows 常见安装路径 → `PATH` 里的 `node` → VS Code 自带的 Electron。
> 低于 **v18** 的 Node 会被自动跳过（例如 Ubuntu 22.04 自带的 v12），不会因此报错。
>
> VS Code Insiders / VSCodium / Cursor / Windsurf 也可用，模型分组会写入当前编辑器
> 自己的配置目录。

### 步骤

1. 打开 **[Releases](https://github.com/a2689307431/vscode-connect-workbuddy/releases)**，
   下载最新版 `vscode-connect-workbuddy-x.y.z.vsix`
2. `Ctrl+Shift+P`（macOS 为 `Cmd+Shift+P`）→ 输入 `Install from VSIX` → 选中该文件
3. 再按 `Ctrl+Shift+P` → `Developer: Reload Window`

命令行安装：

```bash
code --install-extension vscode-connect-workbuddy-x.y.z.vsix --force
```

> ⚠️ **装完必须重载窗口。** 扩展换的是磁盘上的文件，但后台代理进程不会热更新 ——
> 不重载时，你看到的新界面下面跑的仍是旧代码，「修了却没生效」通常就是这个原因。

### 从旧版本升级

0.7.9 起扩展 ID 从 `local.vscode-connect-workbuddy` 改为
`connect-workbuddy.vscode-connect-workbuddy`。VS Code 把不同 ID 视为不同扩展，
直接装新版不会顶掉旧版。

如果之前装过 ≤ 0.7.8：

1. 在扩展面板里卸载 publisher 显示为 `local` 的旧版
2. 安装新版 vsix，重载窗口
3. 登录状态会自动迁移，无需重新登录

新版启动时若检测到旧版仍在，会提示并自行停用；按弹窗里的「立即卸载」即可。

**升级后如果行为没变**，先确认没有残留的旧代理进程：

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

若命令行里的路径指向已删除的旧版本目录，结束该进程再重载窗口即可。
（成因：Windows 允许已启动的程序继续运行，即使它所在的目录已被删除。）

---

## 首次使用

### 1. 登录

第一次启动时右下角会提示未登录。点 **立即登录**，扩展会打开浏览器的授权页；
登录并同意后回到 VS Code，右下角出现「已登录 xxx」。
也可以随时执行 **`WorkBuddy: 登录账号`**，并选择国内站或国际站。

> 凭据只保存在本机的 VS Code 数据目录里，不会上传到任何第三方服务器。

### 2. 选模型

打开 Copilot Chat，点模型下拉框：

```
WorkBuddy
  ├─ DeepSeek-V4.1-Flash
  ├─ GLM-5.3
  └─ ...
```

列表从你的账号动态拉取 —— 账号能用什么，这里就有什么。

登录多个账号后按账号分成几组（见[多账号](#多账号)）：

```
WorkBuddy · 个人号                WorkBuddy · 公司号
  ├─ DeepSeek-V4.1-Flash            ├─ DeepSeek-V4.1-Flash
  ├─ GLM-5.3                        ├─ GLM-5.3
  └─ ...                            └─ ...
```

### 3. 看上下文占用

聊天框底部显示当前会话的 token 用量，例如 `41/1M 个令牌`，进度条随每轮对话增长。

- 数字来自 **WorkBuddy 服务端返回的真实用量**
- 接近上限时 Copilot Chat 会提示压缩或新建会话
- Agent 模式下工具结果与图片同样计入

如果一直显示 `0/1M`，见[上下文窗口一直显示 0](#上下文窗口一直显示-01m)。

---

## 多账号

同一个扩展可以登录多个 WorkBuddy 账号（个人号 + 公司号之类）。

- 每个账号在下拉框里占一个分组，组内只有该账号的模型，不会混淆
- `WorkBuddy: 切换账号` 可指定默认账号，列表里带每个账号的剩余积分

### 选中的账号用不了会怎样

在下拉框里选了「193 的 deepseek」，而那个账号恰好积分用尽或被限流时，
扩展会**自动换到另一个可用账号**完成这次请求，并提示「已改用 xxx，
消耗的是后者的积分」。

- 失败过的账号会**冷却**一段时间（限流约 1 分钟，积分用尽约 1 小时）。
  冷却期间请求直接走其它账号，不再白试一次
- 冷却只记在内存里，**重启 VS Code 即清空**，不会把已恢复的账号持续挡在外面
- 钱包总览里能看到哪些账号正在冷却、还剩几分钟
- 所有账号都在冷却时仍会逐个尝试，不会把路堵死
- 同一组换号提示 10 分钟内只弹一次，不会每句话都提醒

### 账号分组从哪来

VS Code 的模型下拉框只认它自己配置文件里的分组，扩展无法凭空创建。
因此扩展会往 `chatLanguageModels.json` 写入「WorkBuddy · 账号名」这样一条：

- 登录新账号或首次激活时自动同步
- 也可手动执行 `WorkBuddy: 按账号生成模型分组`
- **写完需要重载窗口**才生效
- 账号退出后，对应分组会在下次同步时清掉

> 该文件是 VS Code 的用户配置，扩展改动前会留一份 `.workbuddy-bak` 备份。
> 不想要分组就把它删掉，模型会退回平铺列表。

---

## 积分与钱包

登录后右下角显示**当前所用账号**的剩余积分，例如 `2,571 · 193****5767`。

- 在模型下拉框里切换账号或模型的那一刻就跟着换，不用先发一句话
- 悬停可看账号名、最近到期时间、有没有积分快过期
- 点击打开钱包
- 默认每 5 分钟刷新，间隔可调或直接关闭
- 余额接近 0 时状态栏变黄

### 钱包

点状态栏，或执行 `WorkBuddy: 钱包（账号余额）`，打开**账号池总览**：
每个账号一行，带余额、区域、连签天数、积分到期提醒，标题栏是合计积分。

选中账号进入**明细页**：

- 剩余合计、最早到期时间、30 天内会作废的部分
- 每个积分包剩余 / 总量，以及是每月重置还是某天到期
- 针对该账号的操作：刷新、设为代理当前账号、单独签到、复制明细

| 操作 | 效果 |
|---|---|
| 「← 返回账号池」 | 回到总览，换个账号看 |
| Esc / 点击列表外任意位置 | 关闭整个钱包 |

> 明细由上游用量接口实时返回，和登录 codebuddy.cn 网页看到的数字一致。
> 国内站（codebuddy.cn）和国际站（workbuddy.ai）的账号会出现在同一张表里。

---

## 每日签到

执行 **`WorkBuddy: 每日签到`**，会依次给所有已登录账号签到，结果显示在通知里；
每个账号的「今日已签 / 连续 N 天 / 今日 +N」也会出现在积分明细中。

签到是**幂等**的：今天签过会直接提示「今日已签」，不会重复扣减或报错。
明细可在 `WorkBuddy: 显示日志` 的输出面板里查看。

想每天自动签，打开设置：

```jsonc
"connect-workbuddy.autoCheckin": true
```

开启后**每天第一次启动 VS Code** 时在后台签一次（每账号每天最多一次；
全部失败则下次启动重试）。默认关闭 —— 签到属于计费接口，手动执行更稳妥。

> 签到运行在本地代理里，和聊天共用同一份凭据，不需要额外的工具。

---

## 自动更新

本扩展不上架 Marketplace，因此没有商店的自动更新，由扩展自己实现：

- **启动时静默检查**，每天最多一次（可关掉 `connect-workbuddy.autoUpdate`）
- `WorkBuddy: 检查更新` 可随时手动查
- 钱包里的「检查更新」一行
- 有新版本时状态栏文字末尾出现 `↑`

发现新版本会弹窗，三个按钮：

| 按钮 | 行为 |
|---|---|
| 立即更新 | 下载 vsix → 校验 SHA256 → 安装 → 提示重载窗口 |
| 前往 Release 页面 | 用浏览器打开自行下载 |
| 跳过 x.y.z | 该版本不再提示（下个版本会重新提示） |

SHA256 取自 GitHub 对 Release 附件自动计算的 digest，无需作者或用户额外操作；
校验不通过会中止安装。

> 装完**必须重载窗口**才生效。
>
> VS Code 自带的「自动更新」开关对本扩展无效 —— 那个开关只对从商店安装的扩展生效，
> vsix 安装的扩展没有商店元数据。

如果检查更新失败，见[检查更新提示失败](#检查更新提示失败)。

---

## 命令

| 命令 | 作用 |
|---|---|
| `WorkBuddy: 登录账号` | 浏览器登录，支持国内站与国际站 |
| `WorkBuddy: 切换账号` | 选择默认账号（列表带剩余积分） |
| `WorkBuddy: 钱包（账号余额）` | 账号池总览 → 单账号明细 |
| `WorkBuddy: 每日签到` | 给所有账号签到，已签的跳过 |
| `WorkBuddy: 按账号生成模型分组` | 写入「每账号一组」，写完需重载窗口 |
| `WorkBuddy: 刷新模型列表` | 账号权限或模型清单变化后重新拉取 |
| `WorkBuddy: 检查更新` | 立即查询新版本，可一键下载安装 |
| `WorkBuddy: 重置更新检查计时` | 清掉「每天只查一次」的计时（排查用） |
| `WorkBuddy: 显示日志` | 打开输出面板 |

---

## 设置

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `connect-workbuddy.proxyUrl` | 空 | 留空 = 由扩展自动管理（推荐）。填了则完全使用外部端点 |
| `connect-workbuddy.nodePath` | 空 | 运行代理用的 Node 路径。留空自动探测，找不到时用 VS Code 自带的 Electron |
| `connect-workbuddy.debug` | `false` | 在输出面板打印详细日志 |
| `connect-workbuddy.hideLoginPrompt` | `false` | 启动时不再提示登录（仍可用命令登录） |
| `connect-workbuddy.showCreditsInStatusBar` | `true` | 在状态栏显示剩余积分 |
| `connect-workbuddy.creditsRefreshSeconds` | `300` | 状态栏积分刷新间隔（秒），最小 60 |
| `connect-workbuddy.autoCheckin` | `false` | 每天首次启动时自动签到 |
| `connect-workbuddy.autoUpdate` | `true` | 每天最多检查一次新版本 |
| `connect-workbuddy.proxy` | 空 | **仅供检查更新使用**的网络代理，如 `http://127.0.0.1:7897`。留空则自动探测，见[检查更新时连不上 GitHub](#检查更新时连不上-github) |
| `connect-workbuddy.apiKey` | `workbuddy-local-proxy` | 占位值，仅外部代理场景需要。自动管理时真凭据由扩展注入，**不用改** |

---

## 支持的平台

| 平台 | 状态 | 说明 |
|---|---|---|
| Windows | ✅ 主要开发平台 | 完整验证 |
| macOS | ✅ 代码层面适配 | 路径 / 权限 / 子进程均有平台分支 |
| Linux | ⚠️ 可用但验证较少 | 见下 |

WorkBuddy 官方没有 Linux 客户端，但本扩展不需要它 ——
登录走浏览器 OAuth，代理直接与服务端通信。Linux 上留意：

- **凭据权限**：`vault/` 建成 `0700`、文件 `0600`（明文 token，别用 root 运行）
- **无图形界面**：没有浏览器时会给出授权链接，可复制到别处打开

遇到问题请附上 `WorkBuddy: 显示日志` 的输出。

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

**为什么要隔一层代理**：

1. 凭据刷新只能由单一进程完成 —— 两个进程同时刷新会让对方的 refreshToken 失效
2. 子进程崩溃不影响扩展宿主
3. 请求整形逻辑是独立模块，隔离在代理里便于随上游升级

扩展启动时自动拉起代理，并且：

- 端口随机，只监听 `127.0.0.1`
- 每次启动生成随机 Bearer token，只有本扩展知道
- 关闭 VS Code 时只结束自己拉起的那个进程（Windows 上用 `taskkill /T /F`）

每日签到同样走这一层代理（`POST /checkin`），不额外起服务，也不另存凭据。
若你已在 `127.0.0.1:8799` 手动起了代理，扩展会直接复用。

### 数据放在哪

| 内容 | 位置 |
|---|---|
| 登录凭据 | `<globalStorage>/vault/<区域>/*.json`（明文 token，POSIX 权限 0600） |
| 设备标识 | `<globalStorage>/dsh-home/.workbuddy-device.json`（64 字符随机盐，**不是凭据**） |
| 模型分组 | `<userDataDir>/chatLanguageModels.json`（VS Code 的配置，改动前留备份） |
| 扩展状态 | `state.vscdb`（登录提示开关、自动签到日期、更新检查计时） |
| 下载的新版本 | 系统临时目录 `vscode-connect-workbuddy-update/`（下次升级前自动清空） |

---

## 故障排查

### 模型下拉框里没有 WorkBuddy

1. 执行 `WorkBuddy: 显示日志`，看有没有 `已发现 N 个 WorkBuddy 账号`
2. 没有账号 → 执行 `WorkBuddy: 登录账号`
3. 代理起不来 → 看 `[proxy:err]` 那几行，通常是 Node 版本或权限问题

### 提示「请先卸载旧版本扩展」

机器上同时装着旧 ID（`local.vscode-connect-workbuddy`）的版本。两者会同时注册模型、
同时刷新凭据，导致登录反复失效。按弹窗里的「立即卸载」，再重载窗口。

### 报错 `fetch is not defined` 或 `AbortSignal.timeout is not a function`

实际运行的 Node 低于 v18。清空 `connect-workbuddy.nodePath` 让扩展自动挑选，
或把 Node 升到 v18 以上。

### 升级后模型列表空了 / 账号数比实际少

0.7.9 起扩展 ID 变更，`globalStorage` 路径随之改变。扩展会自动迁移旧凭据，
但中途装回旧版或手动删过目录时可能漏掉。执行一次 `WorkBuddy: 登录账号` 即可恢复。

若之前用**别的工具**（DSH 插件、签到工具等）登录过账号，那份凭据在
`~/.dsh/workbuddy-vault/` 里，扩展启动时会**只读**它并补齐缺失账号，日志里会有：

```
导入   : 另一个账号（来自旧 vault）
```

### 登录成功了但账号数没增加

该账号之前已登录过时会明确提示。常见原因是**浏览器里还留着上一个账号的登录状态**，
授权页自动沿用了旧账号。先在浏览器里退出 WorkBuddy / CodeBuddy，或用无痕窗口打开授权页。

### 报了 401 / 11217 / 未登录

凭据过期或被吊销，执行 `WorkBuddy: 登录账号` 重新登录。

### 登录会被自动续期吗

会。凭据里有两把钥匙：

| 字段 | 有效期 | 作用 |
|---|---|---|
| `accessToken` | 约 30 天 | 每个请求实际携带 |
| `refreshToken` | 约 60 天 | 用来换新的 accessToken |

代理在 `accessToken` 剩不到 6 小时时自动续期并写回本地 vault，
正常情况下无需手动重新登录。只有 `refreshToken` 本身失效时才需要
（过期、被服务端吊销、或同一账号在别处重新登录导致旧的失效）。

### 日志里出现 `fetch failed`

这是**网络层**错误（DNS 失败、连接被重置、超时、被代理软件拦截），
与登录状态无关，重新登录解决不了。新版日志会带出真正的原因：

```
模型目录异常：fetch failed ← ENOTFOUND / getaddrinfo ENOTFOUND copilot.tencent.com
模型目录异常：fetch failed ← ECONNRESET
```

排查方向：

1. 换网络试（手机热点），确认不是本地网络问题
2. 关闭代理软件的 TUN 模式或换规则再试
3. 公司网络 / 校园网可能拦截了 `copilot.tencent.com`，用浏览器确认能否打开
4. Windows 上偶发 IPv6 解析问题（Node 22+ 才默认开启 happy-eyeballs）

> 浏览器能打开 codebuddy.cn 而扩展报 `fetch failed` 时，优先怀疑第 2、4 条。

### 报了 14003 / 模型繁忙

上游限流。稍等重试，或在模型下拉框里换一个账号。

### 回复里看不到思考过程

不是所有模型都有独立的思考过程。上游是否返回 `reasoning_content` 由模型和服务端决定，
扩展无法强制开启；部分模型直接把推理混在正文里输出。

能正常显示时，思考区是一整块、标题里的秒数持续增长（`Thought for 12s`）。

### 上下文窗口一直显示 0/1M

先确认已重载窗口。仍为 0 的话，把 `connect-workbuddy.debug` 设为 `true`，
发一句话后看日志里有没有：

```
上下文用量：prompt=41 completion=49
```

- 有这行但界面仍是 0 → 上报格式与当前 Copilot Chat 版本不匹配，请提 issue 附版本号
- 没有这行 → 上游未返回 usage，请一并提供日志

### 模型名字都很陌生，点了全都报错

例如出现 `fast-model`、`balanced-model`、`gpt-5.6-sol` 这类你账号里根本没有的模型，
说明**模型清单拉错了区域** —— 国内站和国际站的模型完全不重叠。
日志里这一行的方括号应与你账号所属站点一致（`codebuddy.cn` → `cn`，
`workbuddy.ai` → `global`）：

```
[cn] 已同步 15 个模型：hy4flash, deepseek-v4.1-flash, glm-5.3, ...
```

### 模型下拉框里出现重复分组

`chatLanguageModels.json` 里有旧版残留条目。删掉那几条后重载窗口，
再执行 `WorkBuddy: 按账号生成模型分组` 重建。

### 签到相关

| 现象 | 原因与处理 |
|---|---|
| 「当前代理不支持签到」 | 连上的不是扩展自己拉起的代理。清空 `connect-workbuddy.proxyUrl`，或把外部代理升级到 0.6.0 以上 |
| 401 / 登录已失效 | 凭据过期，重新登录后再签 |
| 「没有进行中的签到活动」 | 账号侧未开放活动（新账号、活动已结束、部分企业账号）。在 WorkBuddy 客户端里确认 |
| 签到成功但余额没变 | `+N` 来自签到接口，余额是另一个接口查的，上游偶有延迟。看到连续天数增加即为成功 |

### 检查更新提示失败

刚发版后几分钟内 GitHub 的 Release 接口可能尚未刷新，稍等重试。

> **如果提示「GitHub API 限流」**：这是 GitHub 未认证配额（每小时 60 次，
> **按出口 IP 计算**）被用尽。机场节点、公司 NAT、校园网的出口 IP 都是共享的，
> 别人用完你也用不了，与你的代理是否配好无关。
>
> 此时扩展会自动改用 GitHub 的**静态页面**兜底（不消耗配额），仍可正常更新，
> 但拿不到 SHA256 校验值 —— 弹窗会明确提示。静态页面也失败时，
> 去 [Release 页面](https://github.com/a2689307431/vscode-connect-workbuddy/releases/latest)
> 手动下载 vsix。

其他常见原因：

| 现象 | 处理 |
|---|---|
| 访问不到 api.github.com | 需要能访问 GitHub 的网络环境。弹窗里可点「前往 Release 页面」手动下载 |
| SHA256 校验失败 | 下载内容被中间层改写（代理 / 镜像）。重试一次，仍失败就手动下载 |
| 提示已安装但版本号没变 | 没重载窗口，执行 `Developer: Reload Window` |

### 检查更新时连不上 GitHub

**如果电脑需要代理才能访问 GitHub，请务必看这一节。**

扩展里的 `fetch` 是 Node 内置实现，**不读系统代理**（这是扩展宿主环境的限制）。
所以即使浏览器能打开 GitHub，扩展也可能连不上。

自动探测顺序：

1. VS Code 自己的 `http.proxy` 设置
2. 环境变量 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`
3. 系统代理：
   - **Windows**：注册表 `Internet Settings`（Clash / V2RayN / mihomo 开「系统代理」会写这里）
   - **macOS**：`scutil --proxy`（ClashX / Surge / Stash 勾「设为系统代理」）
   - **Linux**：GNOME 设置（`gsettings`）

探测到了但连不通，或使用的是 **PAC 脚本**（不支持），就显式配置：

```jsonc
{
  // HTTP 代理（Clash / mihomo 的「混合端口」通常就是这个）
  "connect-workbuddy.proxy": "http://127.0.0.1:7897",

  // 或 SOCKS5（同样支持，含 user:pass@）
  "connect-workbuddy.proxy": "socks5://127.0.0.1:7891"
}
```

支持的写法：`127.0.0.1:7897`（按 HTTP 处理）、`http://…`、`socks5://…`、
`socks5h://…`、`socks://…`、`http://user:pass@host:port`。
公司代理使用自签证书时，会跟随 VS Code 的 `http.proxyStrictSSL: false` 跳过校验。

> 该设置**只影响检查更新和下载 vsix**。聊天请求都走 `127.0.0.1`，与代理无关。
> 用 TUN 模式（Clash Verge / sing-box）时直连本来就能通，不用配。
> 改完执行一次 `WorkBuddy: 检查更新` 即可生效（会自动重新探测）。

### 想看排查日志

更新过程每一步都写在：

```
%TEMP%\workbuddy-update.log      （Windows）
$TMPDIR/workbuddy-update.log     （macOS / Linux）
```

失败弹窗里也有「打开日志文件」按钮。里面能看到完整链路：

```
代理探测：http.proxy="" env="" system="http://127.0.0.1:7897" → 采用 "http://127.0.0.1:7897"
GET api.github.com → 尝试直连（strictSSL=true）
GET api.github.com → 直连成功 HTTP 403
查 Release 失败：HTTP 403 body={"message":"API rate limit exceeded for ..."}
判定为限流=true，尝试 Release 页面兜底
atom feed 解析成功：v1.0.2
资产列表解析结果：vscode-connect-workbuddy-1.0.2.vsix
下载响应：HTTP 200 content-length=298244
下载完成：...（298244 字节）
```

### 状态栏有个 ↑ 角标

有新版本。点状态栏 → 钱包 →「检查更新」即可升级。
若升级后角标仍在，说明当前跑的仍是旧代码，重载窗口。

### 其他问题

执行 `WorkBuddy: 显示日志`，带上输出面板内容提 issue。

---

## 隐私

- 对话内容只在你、VS Code 与 WorkBuddy 服务端之间传输
- 扩展**不做任何遥测**，不上报数据，没有统计或埋点
- 凭据存于本机 `globalStorage/vault/`，POSIX 上目录 `0700`、文件 `0600`
- 设备标识是一个 64 字符随机盐（**不是凭据、不含账号信息**），放在
  `globalStorage/dsh-home/` —— **不会往家目录写任何文件**
- 若机器上原本有 `~/.dsh`（装过 DSH 插件），扩展会**只读**它来补齐缺失账号，
  并复制已有的设备盐以保持设备身份，之后不再读写该目录
- 模型分组写入 `chatLanguageModels.json`（VS Code 的配置），改动前留 `.workbuddy-bak` 备份
- **自动更新会连接 `api.github.com`**（仅查版本号）和 `github.com`（下载 vsix），
  不上传任何本地信息。不想联网就关掉 `connect-workbuddy.autoUpdate`
- 为了知道你当前选的是哪个账号，扩展会**只读** VS Code 的 `state.vscdb`
  里的当前模型记录（不写入、不上报）

---

## 免责声明

本项目**非官方**，与腾讯、WorkBuddy、CodeBuddy 无任何关联。

- 仅供学习与研究
- 使用非官方客户端访问服务**可能违反 WorkBuddy 的服务条款**，存在账号受限的风险
- 请使用**你自己的**账号与订阅
- 因使用本项目造成的任何后果由使用者自行承担

---

## 致谢

实现参考了以下开源项目，感谢作者的工作。
完整的版权与许可声明见 [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)。

| 项目 | 许可 | 本项目的使用方式 |
|---|---|---|
| `dsh-connect-workbuddy`（LaoDing） | MIT | **内嵌 `lib/host-heartbeat-*.js`**（当前对应其 `5.31.4`），并调用其中的 `prepareChatBody` / `perturbChannelFingerprints`。这是本项目能与上游稳定通信的关键 |
| `Sliverkiss/workbuddy2api` | MIT | 上游协议细节（基址选择、强制流式、CLI 形态请求头）的参考实现 |
| `corrinehu/dsh-workbuddy-connect` | MIT | 本地代理入站加固（回环校验、随机端口、随机 secret）与错误映射设计的参考 |

其中 `lib/host-heartbeat-DThI1MMs.js` 是**原样再分发**（仅在文件头追加了归属说明），
文件头保留了原始版权与许可声明，请勿删除。

---

## 开发

```bash
git clone https://github.com/a2689307431/vscode-connect-workbuddy.git
cd vscode-connect-workbuddy
```

目录结构：

```
extension.js                 扩展入口：提供方、代理生命周期、命令、状态栏、钱包、签到、更新
proxy/workbuddy-proxy.mjs    本地代理：OAuth、凭据池、请求整形、积分、签到、错误分类、换号
lib/host-heartbeat-*.js      第三方模块（源自 dsh-connect-workbuddy，MIT），
                             负责请求体整形与通道指纹，原样再分发、不要手改
lib/package.json             记录上游版本与 sha256
update-net.js                更新用的 HTTP 客户端（代理隧道），不依赖 vscode，可直接用 Node 测
release-parse.js             GitHub Release 静态解析，纯函数，可离线单测
scripts/check-upstream.mjs   对比上游版本、校验内嵌文件 sha256
scripts/package.mjs          打包（先建目录再调 vsce）
proxy/tests/                 回归脚本，不进 vsix
```

打包：

```bash
npm run package        # 产出 dist/*.vsix，并自动校验包内容
```

测试：

```bash
npm run test:net       # 更新网络层（假代理 + 假目标），离线
npm run test:parse     # Release 解析，离线
npm run check:upstream # 内嵌模块 sha256
```

换号 / 冷却相关的改动还需要跑一次真实账号的端到端脚本（CI 无凭据，跑不了）：

```bash
$env:WB_TEST_HOOKS='1'; node proxy/workbuddy-proxy.mjs --port 8801
node proxy/tests/wb-test-failover.mjs
```

改动后至少跑：

```bash
node --check extension.js
node --check proxy/workbuddy-proxy.mjs
```

> `node --check` 只做语法分析，查不出未声明的变量。删过变量声明时要额外
> `node -e "import('./proxy/workbuddy-proxy.mjs')"` 真加载一次。

更详细的实现约束与踩坑记录不在仓库里（避免泄露本机信息）。

## 许可

[MIT](./LICENSE)

内嵌的第三方模块遵循其原始 MIT 许可，版权与许可声明见
[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)。
