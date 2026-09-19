# dsh-vscode 插件规划（v2，已定型）

## 选型结论
- **主路线 B**：自建 Webview UI + `dsh --profile acp`（标准 ACP v1，官方 SDK `@agentclientprotocol/sdk@1.4.0`）
- **保底**：`dsh.runInTerminal` 命令在集成终端启动 TUI
- **放弃方案 C**（iframe 嵌入 `dsh web`）：web 需 token 认证，跨环境获取不可行（已实测确认）
- 远期 P4：DSH 侧 Cordis bridge 插件，解锁 plan/todo 等 DSH 特有呈现

## 四环境兼容设计（已锁定）
扩展宿主位置决定"本侧"：`vscode.env.remoteName === 'wsl'` → WSL；`process.platform === 'win32'` → Windows。
dsh 侧由设置 `dsh.runtime: auto|wsl|windows` 决定（auto=跟随宿主）。

| # | 拓扑 | Launcher | 路径映射 |
|---|---|---|---|
| 1 | Remote-WSL + dsh(WSL) | LocalLauncher（bash -lc） | identity |
| 2 | Windows + dsh(WSL) ★开发环境 | WslLauncher（`wsl.exe --cd <dir> -e bash -lc …`，stdio 管道透传） | WinToWslMapper（启动时探测 automount root，drvfs 前缀映射，fallback `wslpath`） |
| 3 | Remote-WSL + dsh(Windows) | WindowsLauncher（WSL interop 直起 `cmd.exe`） | WslToWinMapper（`wslpath -w`；/home → \\wsl$ UNC，性能差，文档标注） |
| 4 | Windows + dsh(Windows) | LocalLauncher（`cmd.exe /d /s /c`，兼容 npx .cmd shim） | identity |

设置项：`dsh.runtime`、`dsh.command`（默认 `npx -y @deepseek-ai/dsh`）、`dsh.wsl.distro`、`dsh.env`（如 DEEPSEEK_API_KEY）、`dsh.autoAttachActiveFile`。
`extensionKind: ["workspace","ui"]`——Remote 窗口中扩展跑在远端，否则无法覆盖拓扑 1/3。

## 已验证（P0 spike，2026-09-16，本机 WSL 沙箱）
- initialize（1.65s）→ agentInfo `deepseek-harness-acp`；sessionCapabilities: close/list/resume
- session/new → sessionId + 完整模型 catalog（deepseek-flash / v4-flash / v4-pro，分组+描述）
- session/list → 跨进程持久化生效（spike 会话可被列出）
- session/prompt → 到达 LLM 路由层（沙箱无 DEEPSEEK_API_KEY 报 -32603，属预期；真实环境有 credentials）
- 错误文案自带修复指引（credentials service / 环境变量）

## ACP 契约要点（实现依据）
- 方法全部走 SDK 生成类型：`session/new|list|resume|close|set_config_option|prompt|cancel`
- 配置选项：select 型（model / reasoning_effort），value 为 JSON 字符串 `'["provider","model"]'`
- 更新流：agent_message_chunk / agent_thought_chunk / tool_call / tool_call_update / usage_update / config_option_update
- 权限：session/request_permission → outcome selected(optionId) | cancelled
- prompt 内容块：text / resource_link(file://, **dsh 侧绝对路径**) / image（initialize 显示 image:false 时禁用）
- 限制：resume 不重放历史 → 扩展本地缓存 transcript（P2）；无 plan/终端/elicitation（automation-only）

## 路线图
- ~~P0 Spike~~ ✅ 完成（脚手架 + 四环境 launcher + ACP 全链路 + 最小 UI）
- ~~P0.5 真机修复~~ ✅（2026-09-16）**根因：wsl.exe login shell 跳过 ~/.bashrc → nvm 的 node 不在 PATH，spawn 即死（exit 127）且 UI 挂起**。修复：① 目标侧 bootstrap 显式静默加载 nvm/volta/mise/asdf；② initialize 30s 超时 + 早退竞速，带 stderr tail 报错；③ 失败弹窗直达 DSH 日志通道；④ `dsh.doctor` 目标侧环境探针命令；⑤ 去掉 wsl.exe `--cd`（老版本 WSL 不支持）；⑥ 修配置变更后 view 绑定失效（provider.reset 替代重建）。已用 WSL interop 复现并验证修复后握手 OK。
- ~~P1（第一批）~~ ✅（2026-09-16）拓扑 2 真机跑通；AcpService 抽取（chat/sessions 共享连接）；SessionsView 树视图（cwd 过滤、点击 resume、刷新/新建按钮）；transcript 本地持久化（globalStorage/sessions/*.json，webview 防抖快照）；Markdown 渲染（marked+DOMPurify）；chips 可移除；状态栏显示模型名+busy 动画
- ~~P1（UI 优化批）~~ ✅（2026-09-16）① resume 修复（session/resume 必须带 cwd，冒烟覆盖回归）；② Sessions 并入 Chat 内侧边栏（☰ 开关，删除独立 tree view）；③ ~~会话自定义标题+删除~~（客户端 meta store 实现后按用户决定回滚：等 DSH 侧插件原生支持，见 P4 bridge；代码库不留半成品）④③→④ AutoWidthSelect 内容自适应宽度；⑤ 推理强度等所有非 model 的 select 配置项自动生成下拉；⑥ 头栏显示会话标题；⑦ 状态栏移到右侧
- P1（剩余）：错误恢复 UX 打磨
- ~~P2（第一批）~~ ✅（2026-09-16）**变更评审**：ChangedFilesTracker（tool_call diff 负载精确收集 + prompt 结束 git status 兜底 - 会话开始脏文件基线；全程只读 git）；`dsh-baseline://` 虚拟文档提供 HEAD 左栏 + vscode.diff；聊天内 ChangesBar + `dsh.showChanges` 命令。**@文件补全**：Composer 内嵌（150ms 防抖 → host findFiles，前缀命中优先排序，裸 @ 显示最近编辑器+工作区采样），选中转 chip。修复 parsePorcelainZ rename 双字段解析 bug
- ~~P2（修复批）~~ ✅（2026-09-16）**变更追踪主通道改为 FileSystemWatcher**（prompt 窗口内归因文件写入，区分 created/modified；仓库无关——此前 git 通道因工作区非 repo 静默失效，dsh ACP 也不发 diff 负载）；git 通道保留但先探测 rev-parse；非 repo 的 modified 文件退化为直接打开；ChangesBar 显示 A/M 徽标。权限说明：dsh 仅在 approval/request 时桥接（工作区内编辑默认放行），非缺陷
- ~~P2（第二批）~~ ✅（2026-09-16）① 断线恢复：service.generation 代数 + 会话钉代数，agent 重启后自动 session/resume 重挂（失败回退新会话），webview closed 态显示 Reconnect 按钮；② MCP：`dsh.mcpServers` 设置 + `dsh.configureMcp` 原生 QuickPick 流（stdio/http 增删），挂载到新会话；③ 图片附件：initialize 能力探测（image:false 时隐藏入口），📎 文件选择 + 粘贴两条路径，base64 image block 注入 prompt；④ 教训：字符串手术脚本截断过 ChatViewProvider.ts → 项目已 git init，术后必跑 tsc
- P2（收尾）：图片缩略图预览、MCP stdio 跨拓扑路径校验、会话标题/删除（并入 P4 bridge）
- P3：Chat Participant（@dsh）、CodeLens 快捷任务（headless）、i18n、vsce 打包上架、CI 契约测试
- ~~P3（第一批）~~ ✅（2026-09-16）① Chat Participant `@dsh`（专用长会话、代数钉扎、多轮流式、权限在 webview 不可见时降级为原生模态框、转发 editor/引用上下文）；② `dsh.explainSelection`（一次性 ACP 会话，全拓扑兼容，结果落在 markdown 预览）；③ vsce 打包（9 文件 219KB，剔除 map/smoke）；④ 修复 Reload Window 后 Reconnect 不恢复会话（activeSessionId 持久化到 workspaceState + 面板就绪自动 resume）；⑤ 教训沉淀：先 commit 再手术
- ~~P3（第二批）~~ ✅（2026-09-16）① 测试体系入仓：node:test 16 例（sessionOrder/changes/launcher），esbuild 预打包（绕开 node type-strip 不支持参数属性语法）；② GitHub Actions CI（ubuntu+windows 矩阵：typecheck/build/test + 真实 dsh ACP 契约冒烟，package job 产 vsix artifact）；③ package.nls zh-cn 全量中文化（命令/视图/配置）；④ Getting-Started walkthrough 四步；⑤ 程序化生成 128px 市场图标（PNG 编码手写）
- P3（剩余）：市场发布（publisher 注册 + PAT）、webview 内文案 i18n、CI 加 DEEPSEEK_API_KEY 秘密后跑真模型端到端
- ~~P4：DSH bridge 插件~~ ✅（2026-09-17 集成完成，含真机 E2E 验证）

### P4 集成实施记录
- bridge 插件由另一会话完成（`~/projects/dsh-plugins/dsh-vscode-bridge`）：loopback TCP 7310-7319 + ndjson JSON-RPC + token（`.dsh-bridge.json` 发现文件，0600）
- 扩展侧：`src/bridge/client.ts`（vscode-free，5 个 mock-server 单测）+ `src/bridge/manager.ts`（发现文件 watch + 自动重连）
- 已接通：会话真实标题（live 事件联动刷新）、归档删除、预设下拉（rail 左）、权限盾牌菜单（rail 右）、todo 滚动卡片、plan/mode 横幅、工作区分组（bridge 自动 attach）
- **E2E 验证（沙箱，真实 dsh + bridge）**：profile 创建 → 插件 link 安装 → patch 三服务 → ACP session/new → bridge session.list 可见 → workspace.list 已 attach（不再未分组）→ setTitle/permission.get(三档)/preset.list(standard/ptc)/session.delete 全通
- 扩展侧新增 `dsh.profile` 设置（默认 `acp`；bridge 用户设 `acp-vscode`）——修复了 launcher 硬编码 `--profile acp` 的冲突
- bridge UI 全部能力门控（capabilities 驱动），无 bridge 时界面自动退回 ACP-only
- ~~遗留：一键安装 bridge 命令~~ ✅ `dsh.installBridge`（幂等修复：补 dsh-acp-app bundle + insert 行 + model-selection-settings host 行 + 插件安装）
- 会话标题改名仅限活会话（上游契约）；拓扑 3 不支持 bridge（文档已注）
- ~~**bridge 插件待办（外部仓库）**：`.dsh-bridge.json` 目录污染~~ ✅（2026-09-19，插件 0.1.1 已集中到 `$HOME/.dsh/vscode-bridge/<pid>.json`；扩展侧改造见「bridge 发现机制 v2」）
- 会话物理删除：扩展在 bridge 归档后追加 `find $DSH_HOME/sessions -name '<id>' -exec rm -rf`（target-side shell）

---

### bridge 发现机制 v2：集中式发现（插件 0.1.1 + 扩展侧 2026-09-19 均已落地）

**插件侧已完成（dsh-vscode-bridge@0.1.1）**：
- 唯一发现文件 `$HOME/.dsh/vscode-bridge/<pid>.json`（目录 0700，文件 0600，原子写；卸载/进程退出时删除；启动时按 pid 活性清扫残留）——工作区目录不再写入任何文件
- payload 新增 `directories: string[]`（排序后的进程 cwd + 活会话 cwd + 工作区路径），供扩展按打开文件夹匹配实例；`protocolVersion` 仍为 1，鉴权不变（每请求顶层 `token`）
- 配置项 `discoveryFile` 移除，改为 `discoveryDir`（默认 `$HOME/.dsh/vscode-bridge`）

**扩展侧改造（`src/bridge/manager.ts`）**：✅ 全部实施（`discovery.ts` 纯函数目录读取+匹配，UNC 探测缓存，3s 轮询为主、去除工作区 watcher，安装器默认 `dsh-vscode-bridge@^0.1.1`）
1. **发现**：弃用工作区 `.dsh-bridge.json` watch，改为监视/轮询发现目录下 `*.json`：
   - 拓扑 1（Remote-WSL+dsh WSL）/ 拓扑 4（Windows+dsh Windows）：与 dsh 同机，直接读 `$HOME/.dsh/vscode-bridge`
   - 拓扑 2（Windows+dsh WSL，★开发环境）：经 UNC `\\wsl.localhost\<distro>\home\<user>\.dsh\vscode-bridge` 读取（distro 取 `dsh.wsl.distro`，user 探测一次后缓存）；读失败回退 `wsl.exe` 侧查询
   - 拓扑 3（WSL 宿主+dsh Windows）：维持不支持（文档已注）
2. **匹配**：把打开的文件夹按当前拓扑映射为 dsh 侧路径（拓扑 2 走 WinToWslMapper），在各条目 `directories` 中精确匹配（Windows 侧比较做大小写归一）；多条命中取 `startedAt` 最新；无 `directories` 字段的旧版条目视为不兼容，跳过并提示升级插件
3. **失效**：连接/握手失败即弃用该条目并尝试下一条；不做扩展侧 pid 活性判断（跨 OS 不可靠，插件启动时已自清扫）
4. **清理**：移除工作区 `.dsh-bridge.json` watcher 及相关文档/gitignore 提示；`dsh.installBridge` 安装/校验的插件版本提升到 0.1.1

---

## P4 详细规格：dsh-vscode-bridge（Cordis 插件）

### 目标能力（按优先级）
1. **工作区分组修复（「未分组」bug）**：ACP 创建的会话自动 attach 到 workspaceRegistry —— 根因：ACP profile 未加载 workspace 插件且无人 attach（Web UI 按 `workspace.sessionIds` 成员关系分组）
2. **会话标题**：读取/设置 dsh 原生 title（扩展侧 UI 已预留字段透传）
3. **会话删除**：调用 dsh 原生删除（ACP 无此面）
4. **Agent 预设选择**：列出/切换 preset（`packages/preset`），webview 组件已留位
5. **权限模式**：查询/切换 read-only / workspace-write / full-access（对齐 `dsh-vscode-abandoned` 的 PermissionSelect 设计：盾牌三态），webview 组件已留位
6. plan/todo 富卡片（DSH presentation 数据）

### 交付机制（无需上游改动）
1. 新建 profile：`dsh --profile acp-vscode --from-default-profile acp`（复制 ACP profile 模板）
2. 装入插件：`dsh plugin --profile acp-vscode add <bridge-pkg>`（支持 file:/link: 本地路径）
3. 扩展启动命令改为 `dsh --profile acp-vscode`（`dsh.command` 已可配；扩展提供「一键安装 bridge」命令，自动执行 1+2 并改写设置）

### 通信通道选型
| 方案 | 原理 | 结论 |
|---|---|---|
| A. ACP 扩展方法 | 在同一 ndjson 流上加自定义 method（SDK 支持 `request(method: string)` 泛型） | ❌ 暂不可行：dsh-acp 未把 AgentApp/connection 暴露为服务（无注册 seam）→ 上游 PR 方向 |
| **B. bridge 自带 TCP 服务（推荐起步）** | Cordis 插件内起 JSON-RPC/WS 服务，端口 7310-7319 扫描占位；发现文件写到 `<workspace>/.dsh-bridge.json`（port+token），用完即删；token 鉴权 | ✅ 拓扑 1/2/4 全覆盖（WSL2 localhostForwarding 天然支持 Windows→WSL）；拓扑 3（WSL 宿主→Windows dsh）受限，文档标注 |

### bridge 插件骨架（实现锚点）
```ts
export const name = 'dsh-vscode-bridge'
export const inject = ['sessions', 'workspaceRegistry'] // 按调研调整
export function apply(ctx: Context) {
  // 1. 会话创建 → 按 cwd 找到/创建工作区 → attachSession(sessionId)
  //    事件锚点参考 dsh-acp: ctx.on('session/event', ...) / agent 生命周期事件
  // 2. TCP JSON-RPC: {method: 'session.setTitle'|'session.delete'|'preset.list'|'preset.select'|'permission.get'|'permission.set'|...}
  // 3. 写 <cwd>/.dsh-bridge.json {port, token, pid}
}
```
参考实现：
- 事件钩子写法：`packages/acp/acp/src/index.ts`（`ctx.on('session/event'|'approval/request', ...)`）
- 工作区实体：`packages/workspace/workspace/src/entity.ts`（`attachSession` 会校验 session header cwd 与 workspace path 一致）
- Web UI 分组逻辑：`packages/client/ui-workspace/src/client/tree.ts`
- RPC 协议参考（已逆向验证）：`H:\Projects\dsh-vscode-abandoned/src/dsh/protocol.ts`
- 权限/预设 UI 参考：`dsh-vscode-abandoned/src/webview/main.ts`（PermissionSelect 盾牌三态、预设 rail）

### 扩展侧待办（bridge 就绪后）
- `BridgeClient`：发现 .dsh-bridge.json → 连接 → 能力协商（capabilities 消息已预留：扩展 capabilities 消息加 `bridge: true`）
- 会话列表 title 用 bridge 数据增强；rename/delete 消息改走 bridge
- 预设/权限选择器接数据后取消隐藏
- plan/todo 更新渲染（bridge 推送）

### 调研任务（下个 session 第一步）
1. session 创建事件的确切名称与负载（`ctx.on('session/event')` 还是 lifecycle 事件）
2. `ctx.workspaceRegistry` 的确切 API（create/find by path）
3. `packages/preset` 的服务键与选择 API
4. 权限模式（approval policy）的服务键与档位枚举
5. profile patch YAML 写法（参考 `apps/cli/src/sdk-source.cordis.patch.yml`）
6. 插件打包/加载约束：读 `packages/AGENTS.md`（function plugin 需 named-export name/inject/Config/apply；禁止 default export 混用）

### 验收标准
- 新建会话在 DSH Web UI 中归入正确工作区（不再「未分组」）
- 扩展侧栏会话显示真实标题，可重命名、可删除（bridge 直通）
- 权限盾牌三态切换立即生效于当前会话
- 预设切换后模型/工具集按预设生效

## 风险登记
1. DSH developer preview breaking change → CI 契约测试 + 能力探测（initialize）
2. resume 不重放 → P2 本地缓存
3. 拓扑 3 的 UNC cwd 兼容性未验证 → 文档标注 best-effort
4. nvm 管理的 node 在非 login shell 不可见 → 全部 launcher 走 login shell（bash -lc / cmd）
5. wsl.exe stdio 在大输出下的背压 → 观察 stderr 分流，必要时加 --shell-type

## 经验教训（持续更新）
- esbuild ESM 产物混入 CJS 依赖（如 yaml）会触发 "Dynamic require of 'process' is not supported"——必须 `mainFields: ['module','main']` + `createRequire` banner；验收方式：stub vscode 后 `import dist/extension.mjs` 无头加载
