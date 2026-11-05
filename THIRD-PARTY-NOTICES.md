# 第三方声明（THIRD-PARTY NOTICES）

本项目包含并再分发了以下第三方代码。它们均为 **MIT License**，
原始版权与许可声明如下。本项目对这些代码的使用遵守原许可证条款。

---

## 1. dsh-connect-workbuddy

**用途**：本项目内嵌了其 `lib/host-heartbeat-*.js`，并调用其导出的
`prepareChatBody` / `perturbChannelFingerprints` 等函数，用于与 WorkBuddy 上游
通信时的请求体整形与通道指纹处理。

**被内嵌的文件**：

- `lib/host-heartbeat-DFqDsnte.js`（来自 `dsh-connect-workbuddy@5.18.2`）
  - 更早的 `host-heartbeat-BtMcdOIa.js`（`5.13.1`）已被替换

**版权**：

```
Copyright (c) 2026 LaoDing
```

**许可**：MIT License

> 该文件头部保留了原始的许可与版权注释，请勿删除。

---

## 2. Sliverkiss/workbuddy2api

**用途**：上游协议（CN/global base 选择、强制 `stream: true`、`tool_choice`
压平为字符串、CLI 形态请求头等）的参考实现来源。`dsh-connect-workbuddy`
的源码注释中明确标注其协议部分参照本项目。

**版权**：MIT（原仓库已删除，许可记录沿用）

---

## 3. corrinehu/dsh-workbuddy-connect

**用途**：入站加固（Host/Origin 必须回环、chat POST 必须 JSON、bearer 匹配
进程内随机 secret）、随机端口绑定、body 上限、上游错误分类到 HTTP 状态码的
映射等设计的参考来源。

**版权**：

```
Copyright (c) 2026 Corrine Hu
```

**许可**：MIT License

---

## MIT License 全文

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 商标与免责

- **WorkBuddy** / **CodeBuddy** / **腾讯** 是其各自权利人的商标。
  本项目**非官方**，与上述公司无任何关联、背书或赞助关系。
- 本项目仅供学习与研究。使用非官方客户端访问服务可能违反服务条款。
- 本项目不附带任何担保，使用后果由使用者自行承担。
