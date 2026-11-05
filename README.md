# Connect WorkBuddy

**把 WorkBuddy 的模型，接进 VS Code Copilot Chat 的模型下拉框。**

装好扩展、登录一次，模型选择器里就会多出 WorkBuddy 的模型，
和你已有的 Copilot 模型放在同一个下拉框里 —— 直接切，不用换界面。
不用起服务、不用记端口、不用填 base_url、不用手输模型名。

```
装扩展 → 登录一次 → 下拉框里出现 "DeepSeek-V4.1-Flash · 我的账号" → 选中就能用
```

> **📦 [下载最新版本](https://github.com/a2689307431/vscode-connect-workbuddy/releases)**

---

## 它能做什么

- 🧩 **接进 Copilot 的整套工作流** —— 模型出现在 Copilot Chat 的模型下拉框里，
  `@workspace`、`#file`、Agent 模式、自定义指令、MCP 工具都能照常用
- 🔀 **一个下拉框里切换** —— 和 GPT、Claude 等 Copilot 自带模型并列，不用在两个面板之间来回切
- 🔐 **OAuth 登录** —— 在浏览器里点几下就完成，不用手抄 token
- 🖼️ **支持图片** —— 截图、设计稿可以直接粘贴给模型
- 🧠 **显示思考过程** —— 推理模型的思考链会以可折叠的形式展示
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

两边可以用同一个账号，不冲突。
**想要代码补全和 inline edit，用官方插件；想在 Copilot 里统一聊天，用这个。**

---

## 安装

### 前提

- VS Code **1.116.0** 或更高
- 已安装 **GitHub Copilot Chat** 扩展（免费版即可，模型请求由 WorkBuddy 侧处理）
- 一个 **WorkBuddy / CodeBuddy** 账号

### 步骤

1. 打开 **[Releases](https://github.com/a2689307431/vscode-connect-workbuddy/releases)** 页面，
   下载最新版 `vscode-connect-workbuddy-x.y.z.vsix`
2. 在 VS Code 里按 `Ctrl+Shift+P`（macOS 为 `Cmd+Shift+P`），输入 `Install from VSIX`，回车
3. 选中下载的 `.vsix` 文件
4. 再按 `Ctrl+Shift+P` → `Developer: Reload Window` 重载窗口

也可以用命令行安装：

```bash
code --install-extension vscode-connect-workbuddy-x.y.z.vsix
```

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
| `connect-workbuddy.debug` | `false` | 在输出面板打印详细日志 |
| `connect-workbuddy.hideLoginPrompt` | `false` | 不再在启动时提示登录（仍可用命令登录） |
| `connect-workbuddy.showCreditsInStatusBar` | `true` | 在状态栏显示剩余积分 |
| `connect-workbuddy.creditsRefreshSeconds` | `300` | 状态栏积分的自动刷新间隔（秒），最小 60 |
| `connect-workbuddy.autoCheckin` | `false` | 每天首次启动时自动签到（每账号每天最多一次） |
| `connect-workbuddy.apiKey` | `workbuddy-local-proxy` | 占位值，真正凭据由扩展注入 |

---

## 支持的平台

Windows / macOS / Linux 都支持。

### 关于 Linux

WorkBuddy 官方没有 Linux 客户端，但本扩展**不需要**它 ——
登录走的是浏览器 OAuth，代理直接与 WorkBuddy 服务端通信。

---

## 工作原理

```
VS Code Copilot Chat
        ↓  语言模型提供方接口（稳定 API）
   本扩展  extension.js
        ↓  http://127.0.0.1:<随机端口>，随机 Bearer token
   代理进程  proxy/workbuddy-proxy.mjs
        ↓  HTTPS
   WorkBuddy 服务端
```

扩展启动时自动拉起代理，并且：

- 端口随机，只监听 `127.0.0.1`（不对外网开放）
- 每次启动生成一个随机 Bearer token，只有本扩展知道
- 关闭 VS Code 时，扩展只结束自己拉起的那个进程

每日签到也走这一层代理（`POST /checkin`），不会额外起服务，也不会另存一份凭据。

已经手动在 `127.0.0.1:8799` 起了代理的话，扩展会直接复用它。

---

## 故障排查

### 模型下拉框里没有 WorkBuddy

1. 命令面板 → `WorkBuddy: 显示日志`，看有没有 `已发现 N 个 WorkBuddy 账号`
2. 没有账号：执行 `WorkBuddy: 登录账号`
3. 日志里报代理起不来：设置 `connect-workbuddy.nodePath` 指向一个可用的 node 可执行文件

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
- 扩展不做任何遥测，不上报任何数据
- 登录凭据存在本机 VS Code 的 `globalStorage` 目录下 `vault/` 子目录中
- 设备标识用的随机盐（64 字符，**不是凭据、不含账号信息**）也放在
  `globalStorage` 下的 `dsh-home/` 里 —— **不会往家目录写任何文件**
- 如果机器上原本就有 `~/.dsh`（装过 DSH 插件），扩展会**只读**它来补上缺失的账号，
  并把已有的设备盐复制一份过来（保持设备身份不变），之后不再读写该目录

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
| `dsh-connect-workbuddy`（LaoDing） | MIT | **内嵌了 `lib/host-heartbeat-*.js`**（当前对应其 `5.18.2`），并调用其中的 `prepareChatBody` / `perturbChannelFingerprints`。这是本项目能与上游稳定通信的关键 |
| `Sliverkiss/workbuddy2api` | MIT | 上游协议细节（基址选择、强制流式、CLI 形态请求头）的参考实现 |
| `corrinehu/dsh-workbuddy-connect` | MIT | 本地代理的入站加固（回环校验、随机端口、随机 secret）与错误映射设计的参考 |

其中 `lib/host-heartbeat-DFqDsnte.js` 是**原样再分发**（仅在文件头追加了归属说明），
文件头保留了原始版权与许可声明，请勿删除。

---

## 开发

```bash
git clone https://github.com/a2689307431/vscode-connect-workbuddy.git
cd vscode-connect-workbuddy
```

目录结构：

```
extension.js                扩展入口：语言模型提供方 + 代理进程管理
proxy/workbuddy-proxy.mjs   本地代理：登录、凭据刷新、请求整形
lib/                        请求整形与指纹模块（源自官方插件，MIT）
```

重新打包：

```bash
npm exec --yes --package @vscode/vsce -- vsce package --allow-missing-repository
```

## 许可

[MIT](./LICENSE)
