# Connect WorkBuddy

**把 WorkBuddy 的订阅额度，接进 VS Code 的模型下拉框。**

装好扩展、登录一次，Copilot Chat 的模型选择器里就会出现你自己的 WorkBuddy 模型。
不用起服务、不用记端口、不用填 base_url、不用手输模型名。

```
装扩展 → 登录一次 → 下拉框里出现 "DeepSeek-V4.1-Flash · 我的账号" → 选中就能用
```

---

## 它能做什么

- 🎯 **原生集成** —— 模型出现在 Copilot Chat 的模型下拉框里，而不是另起一个聊天面板
- 🔐 **OAuth 登录** —— 在浏览器里点几下就完成，不用手抄 token
- 🖼️ **支持图片** —— 截图、设计稿可以直接粘贴给模型
- 🧠 **显示思考过程** —— 推理模型的思考链会以可折叠的形式展示
- 👥 **多账号** —— 登录多个账号，模型按账号分组列出，随时切换
- 🔌 **零依赖** —— 不用装 Node.js，扩展自己管理后台进程
- 🛑 **不留后台** —— 关闭 VS Code，为它拉起的进程自动退出

---

## 安装

### 前提

- VS Code **1.116.0** 或更高
- 已安装 **GitHub Copilot Chat** 扩展（免费版即可 —— 模型请求走的是你自己的 WorkBuddy 额度）
- 一个 **WorkBuddy / CodeBuddy** 账号

### 步骤

1. 下载 `vscode-connect-workbuddy-x.y.z.vsix`
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

也可以随时在命令面板执行 **`WorkBuddy: 登录账号`**，并选择国内版 / 海外版。

> 登录凭据只保存在本机的 VS Code 数据目录里，不会上传到任何第三方服务器。

### 2. 用起来

打开 Copilot Chat，点模型下拉框，会看到类似：

```
WorkBuddy
  ├─ DeepSeek-V4.1-Flash · 我的账号
  ├─ GLM-4.6 · 我的账号
  └─ ...
```

选一个，正常聊天即可。

模型列表是从你的账号动态拉取的 —— 你订阅里有什么，这里就有什么。

---

## 多账号

同一个扩展可以登录多个 WorkBuddy 账号（比如一个个人号、一个公司号）。

- 模型下拉框里每个模型会按账号分别列出一份，带账号名后缀
- 也可以用 `WorkBuddy: 切换账号` 指定「默认账号」
- 某个账号的凭据失效时，请求会自动顺延到下一个可用账号

---

## 命令

| 命令 | 作用 |
|---|---|
| `WorkBuddy: 登录账号` | 打开浏览器登录，支持国内版和海外版 |
| `WorkBuddy: 切换账号` | 选择默认账号 |
| `WorkBuddy: 刷新模型列表` | 订阅或额度变化后重新拉取模型 |
| `WorkBuddy: 显示日志` | 打开输出面板，排查问题用 |

---

## 设置

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `connect-workbuddy.proxyUrl` | 空 | 留空 = 自动管理（推荐）。填了地址则完全使用外部端点，扩展不再插手 |
| `connect-workbuddy.nodePath` | 空 | 运行代理用的 Node 路径。留空自动探测，都找不到时使用 VS Code 自带的 Electron |
| `connect-workbuddy.debug` | `false` | 在输出面板打印详细日志 |
| `connect-workbuddy.hideLoginPrompt` | `false` | 不再在启动时提示登录（仍可用命令登录） |
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

已经手动在 `127.0.0.1:8799` 起了代理的话，扩展会直接复用它。

---

## 故障排查

### 模型下拉框里没有 WorkBuddy

1. 命令面板 → `WorkBuddy: 显示日志`，看有没有 `已发现 N 个 WorkBuddy 账号`
2. 没有账号：执行 `WorkBuddy: 登录账号`
3. 日志里报代理起不来：设置 `connect-workbuddy.nodePath` 指向一个可用的 node 可执行文件

### 报了 401 / 11217 / 未登录

凭据过期。执行 `WorkBuddy: 登录账号` 重新登录一次。

### 报了 14003 / 模型繁忙

上游限流。等一会儿重试，或在模型下拉框里换一个账号。

### 回复里看不到思考过程

不是所有模型都有思考过程。确认所选模型本身支持推理，并检查设置里是否开启了推理。

### 其他问题

命令面板 → `WorkBuddy: 显示日志`，带上输出面板内容提 issue。

---

## 隐私

- 对话内容只在你、VS Code、WorkBuddy 服务端之间传输
- 扩展不做任何遥测，不上报任何数据
- 登录凭据存在本机 VS Code 的 `globalStorage` 目录下 `vault/` 子目录中

---

## 免责声明

本项目**非官方**，与腾讯、WorkBuddy、CodeBuddy 无任何关联。

- 仅供学习与研究
- 使用非官方客户端访问服务**可能违反 WorkBuddy 的服务条款**，存在账号受限的风险
- 请使用**你自己的**账号与订阅
- 因使用本项目造成的任何后果由使用者自行承担

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
