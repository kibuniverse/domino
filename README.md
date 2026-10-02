# domino

在 React 开发页面选择元素，描述修改要求，由本地 Codex 或 Claude Code 修改源码，并通过 Vite 更新页面。

对外是一个包 `@kibuniverse/domino`，内部按编译转换、浏览器 runtime、任务核心和 Agent Adapter 分模块，分别通过官方 `@openai/codex-sdk` 和 `@anthropic-ai/claude-agent-sdk` 调用 Codex、Claude Code。当前尚未发布到 npm。

## 功能

### 交互流程

在开发页面把鼠标悬停在目标元素上，按 `Space` 或 `Alt+Space` 调起输入框并自动选中当前元素，输入要求后回车发送。也可以点击右下角的 domino 打开面板，默认使用最近悬停的页面元素；需要更换目标时点击「选择/切换元素」。输入期间目标保持固定。

修改完成后展示真实候选 diff、执行日志和模块更新确认。源码或 DOM 更新后需要重新选择元素。

### 能做什么

- 单元素选择、父节点定位提示、任务队列、重连状态快照、真实 diff、取消、受控撤销与 Vite 编译诊断展示。
- 新建、删除和修改文件均记录恢复信息，最近 20 项记录可在重启后查看和撤销。
- 同一工作区只允许一个 domino 服务，多个浏览器页签共享队列。

### 执行机制与安全边界

1. 编译阶段只标记原生 JSX 节点，位置和 ID 绑定当前源文件 hash。提交和出队执行时分别验证版本。
2. 保存当前源码，包括已存在的未提交和未跟踪文件；将支持的文件复制到临时工作区，并提供少量项目元数据。
3. 根据 `agent.provider` 调用官方 SDK，消费结构化事件并通过取消信号停止执行。Codex 的 `startThread()` / `runStreamed()` 使用权限 profile，仅允许读取副本、写入源码目录和专用临时目录，工具网络关闭；每次运行前实际探测允许写入及拒绝越界读写。Claude 的 `query()` 使用下面的文件工具权限 hook。两个适配器均复用任务核心，没有自定义 CLI RPC 客户端。
4. Agent 结束后核对真实文件差异、JS/TS/JSON 语法和编辑范围，并确认原工作区仍与快照一致，再应用改动。
5. 撤销前检查所有相关文件是否仍符合任务结果；检测到后续编辑时整项拒绝。新建、删除和修改文件均记录恢复信息。

Agent 在临时源码副本执行，检查后自动应用；暂未提供候选 patch 的人工审批模式。生产构建不启用插件，不注入标记、runtime 或任务服务。需要将 domino 放在其他改写 JSX 的插件之前；无法确认原始代码位置时跳过该文件。

Agent 路由默认只接受 loopback 连接，检查精确 Host/Origin，并通过首次 WebSocket 消息校验每次启动生成的 token。需要从局域网其他设备使用时，见下面的「局域网访问」。

本地文件执行不代表离线推理，源码上下文可能发送到所选 Agent 配置的模型服务。任务快照包含项目源码，清理 `.domino` 前请先结束任务并确认不再需要历史撤销。

### 支持范围

包尚未发布 1.0：0.x 阶段 minor 版本可能包含破坏性变更，升级前请查看 [Release Notes](https://github.com/kibuniverse/domino/releases)。

已使用 macOS、Node 22.23.3、Vite 8.3.2、React 19.3.0、`@vitejs/plugin-react` 6.1.1 和 Chrome 验证浏览器闭环。当前集成目标为 `@openai/codex-sdk` / Codex CLI 0.160.0，以及 `@anthropic-ai/claude-agent-sdk` 0.3.287 / Claude Code 2.1.287。权限和事件接口升级后应重跑 smoke test。Linux 尚需目标环境验证；Codex 在 Windows 首版禁用真实执行，Claude 的 Windows 集成尚未验证。

- 第三方组件可能只能定位到带标记的父元素；没有源码标记时无法提交任务。当前使用处与共享组件选项表达用户意图，不保证实例级映射。
- 目前仅进行文件范围、并发冲突和 JS/TS/JSON 语法检查，不替代项目类型检查、lint、测试或视觉验收。模块更新确认不代表视觉要求已经满足，CSS-only 修改可能保持“更新待确认”。
- 暂不支持 Fiber、截图、SSR/RSC、Webpack/Rspack、Vue、远程开发桥接、跨域 iframe 和封闭 Shadow DOM。

## 安装与使用

### 前置准备

- Node.js 22.12+ 与 pnpm。
- 已登录的 Codex CLI 0.160.0+，或已登录的 Claude Code 2.1.287+；二者至少准备一个，也可两个都装、按项目切换。
- 模型推理需要网络：domino 调用的是本地 CLI/SDK，但源码上下文会发送到所选 Agent 配置的模型服务。

### 安装

包尚未发布到 npm，需要从源码打包后安装到目标项目：

```bash
pnpm install
pnpm build
npm pack
# 在目标项目安装生成的 kibuniverse-domino-0.1.0.tgz
```

### 接入 Vite

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { domino } from '@kibuniverse/domino/vite'

export default defineConfig({
  plugins: [
    domino({
      agent: { provider: 'codex', executable: 'codex', effort: 'low' },
      directories: ['src', 'public'],
      shortcut: 'Alt+Space',
      execution: { timeoutMs: 300_000, queueLimit: 3 },
    }),
    react(),
  ],
})
```

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `agent` | `{ provider: 'codex' }` | 见下面的「Agent 配置」。 |
| `directories` | `['src', 'public']` | 必须是工作区相对源码目录。默认只允许其下的 JS/TS、JSX/TSX、CSS/SCSS/Less、JSON、SVG、HTML 等文本文件；二进制资源、隐藏文件、符号链接、依赖目录和构建配置不在自动修改范围内。 |
| `shortcut` | `['Space', 'Alt+Space']` | 单个组合或组合列表。如果被操作系统截获，使用面板按钮。 |
| `execution.timeoutMs` | `300000` | 允许 1000–1800000。默认 5 分钟以容纳模型服务的连接重试。 |
| `execution.queueLimit` | `3` | 允许 1–10。 |
| `allowLan` | `false` | 允许局域网内其他设备使用，见下面的「局域网访问」。 |

### Agent 配置

两个官方 SDK（`@openai/codex-sdk`、`@anthropic-ai/claude-agent-sdk`）声明为**可选依赖**：默认随包安装，只使用单一 Agent 的环境也可显式排除；缺少对应 SDK 时 domino 会报 `AGENT_SDK_NOT_INSTALLED` 并提示安装命令。两者均为精确版本锁定（每版经过兼容性验证），升级由 Dependabot 分组 PR 跟进。

#### Codex

`agent.model` 可指定本地登录有权使用的模型；不指定时使用 Codex 的默认模型。`agent.authHome` 可指定已有文件凭证的 Codex 目录。domino 在独立临时配置目录复用 `auth.json`，不读取或展示凭证内容；不继承用户的 MCP、插件、hooks 或自定义模型供应商配置。仅存于系统钥匙串的登录暂不支持，可使用 API key，或先运行 `codex -c 'cli_auth_credentials_store="file"' login`。

#### Claude Code

安装并登录 Claude Code **2.1.287+**（`claude auth login`），或设置 `ANTHROPIC_API_KEY`。将 `agent` 替换为：

```ts
agent: {
  provider: 'claude',
  executable: 'claude',
  effort: 'low',
  maxTurns: 30,
  // model: '填写本地登录或供应商支持的模型 ID',
}
```

`agent.configDir` 可指定 Claude 用户配置目录，默认 `CLAUDE_CONFIG_DIR` 或 `~/.claude`。仅从用户 `settings.json` 复用 `model` 以及 `env` 中的认证、模型别名、供应商地址和代理字段；进程环境优先。不会加载项目配置、用户权限规则、hooks 或插件，也不执行 `apiKeyHelper` 等用户命令。仅有自定义凭证命令的配置请改用 API key 或已有登录。凭证不会写入任务日志或源码副本。

Claude 使用 SDK `query()` 的结构化事件和 `AbortController`。首版仅开放 **Read、Glob、Grep、Edit、Write**，每次调用经 `PreToolUse` 检查路径、编辑目录和符号链接，再传入规范化路径；仅允许读取副本内源码及少量只读项目元数据。采用 Claude Code restricted / safe mode，并关闭这版 CLI 默认的两个内置插件；启动时校验 hook 注册确认和实际工具、MCP、插件列表，不符合预期时停止执行。

这是文件工具模式，文件工具由 CLI 进程执行，**不是 Codex 的操作系统文件沙箱**。Bash、网络工具、MCP、子 Agent、安装依赖、运行测试和直接删除文件暂不开放。Claude 的模型请求仍需要网络。SDK / CLI 升级后应重新验证权限和事件兼容性。[官方权限文档](https://code.claude.com/docs/en/agent-sdk/permissions)和 [hook 文档](https://code.claude.com/docs/en/agent-sdk/hooks)说明了权限与工具调用的顺序。

无论使用哪个 Agent，切换 provider 前都需要停止当前开发服务器。

### 使用

打开终端显示的地址，悬停目标元素 → 按 `Space` / `Alt+Space` → 输入要求 → 回车发送。或者点击右下角 domino → 「选择/切换元素」→ 点击页面目标 → 输入要求 → 发送。执行进度和 diff 在面板中查看，完成后可以撤销。选择模式会阻止目标按钮的点击行为。

### 局域网访问

默认只允许 loopback 连接。需要在手机或另一台设备上访问时：

```ts
domino({ agent, allowLan: true })
```

同时让 Vite 监听所有网卡：

```bash
vite --host 0.0.0.0
```

启动日志会打印 Network 地址，用该地址访问即可。开启后**局域网内任何能打开页面的设备都可以驱动 Agent 修改本项目源码**——token 随页面下发，不能作为访问控制。不需要时请关闭 `allowLan` 并停止服务。

同源校验（Host 与 Origin 必须一致）在开启后依然生效，可阻止其他站点发起的跨站 WebSocket 连接。若要改用主机名（如 `xxx.local`）而非 IP 访问，还需按 Vite 提示补 `server.allowedHosts`。

### 运行限制与注意事项

- 取消或超时会通过 SDK 的 `AbortSignal` 停止 CLI，展示可读取的部分候选 diff；候选改动不会因此自动应用。进入确定性应用阶段后，请等待应用结束，再使用撤销。
- 任务记录与前后内容保存在项目的 `.domino/tasks/`，应加入 `.gitignore`；插件阻止开发服务器通过文件路由读取该目录。未完成任务标记为中断，不会自动重新执行。
- 快照上限为 1000 个文件、单文件 1 MiB、合计 10 MiB；单次候选改动最多 30 个文件、diff 合计 1 MiB。超限会阻止应用。
- 多文件应用和撤销并非原子事务，逐文件记录进度；运行期间仍应避免手工修改相关文件。外部编辑器没有共同文件锁，最后一次 hash 检查与写入之间仍存在竞争窗口。

## 本地开发调试

### 仓库结构

```
src/transform/     JSX 标记、原始位置、source map、语法校验
src/runtime/       Shadow DOM 浮层、选择器、任务与 diff 展示
src/core/          登记表、协议校验、快照、队列、持久化与撤销
src/agents/        官方 Codex / Claude SDK 适配与 provider 选择
src/vite/          编译及开发服务器接入
examples/react/    可直接运行的 React 示例
scripts/           真实 Agent / 独立项目的 smoke test
tests/             单元、协议与浏览器测试
```

包提供根入口、`/vite`、`/core`、`/transform`、`/agents/codex`、`/agents/claude`；根入口导出 `AgentConfig` 类型。适配器按 provider 延迟加载；浏览器 runtime 为插件使用的内部入口，独立打包，不引入 Node 依赖。

### 本地运行示例

仓库通过 `.npmrc` 为 pnpm 固定 Node 22.23.3。

```bash
pnpm install
pnpm example         # 使用现有 Codex 登录，或 CODEX_API_KEY / OPENAI_API_KEY
pnpm example:claude  # 需安装并登录 Claude Code 2.1.287+
```

打开终端显示的本地地址即可调试完整闭环。

### 独立 React 接入项目

仓库同层级的 `../domino-react-app` 是完整的 React + TypeScript + Vite 工作台，具有独立 `package.json`、锁文件、业务源码和构建配置。它安装 `vendor/kibuniverse-domino-0.1.0.tgz`，验证真实 npm 包接入，不使用工具源码 alias。

```bash
pnpm --dir ../domino-react-app install
pnpm --dir ../domino-react-app dev
# 使用 Claude Code：
pnpm --dir ../domino-react-app dev:claude
# http://127.0.0.1:5180/
pnpm --dir ../domino-react-app build
```

支持页面切换、项目搜索和分类、新建项目、待办勾选。业务状态保存在内存中，刷新恢复初始数据；可选择“新建项目”按钮体验 Agent 修改、HMR、diff 与撤销。默认 `pnpm dev` 使用 Codex，`pnpm dev:claude` 使用 Claude；切换前需停止当前服务。

改动工具后需要重新构建并更新该项目的依赖：

```bash
pnpm build
npm pack --pack-destination ../domino-react-app/vendor
pnpm --dir ../domino-react-app add -D @kibuniverse/domino@file:vendor/kibuniverse-domino-0.1.0.tgz
```

### 测试与验证

```bash
pnpm check       # 类型检查、单元/协议测试、打包、发布产物校验（publint + attw）
pnpm test:e2e    # 本地 Vite + 无界面 Chrome；需已安装 Google Chrome
node scripts/codex-smoke.mjs # 使用真实 Codex，在临时项目测试修改、应用和撤销
node scripts/claude-smoke.mjs # 使用真实 Claude，在临时项目测试修改、应用和撤销
node scripts/react-project-smoke.mjs # 独立 React 项目先运行 pnpm dev；真实 SDK + Chrome 验收
# 独立项目先运行 pnpm dev:claude，再执行：
node scripts/react-project-smoke.mjs ../domino-react-app http://127.0.0.1:5180/ claude
```

真实 smoke test 依赖本地登录、网络和模型调用，不属于默认单元测试流程。独立 React 验收检查项目搜索、分类、新建、待办勾选，再通过页面修改实际按钮文案，验证 diff、HMR、React 状态保留及撤销后所有源码恢复。

`tests/e2e/` 覆盖完整浏览器闭环（含非安全上下文的局域网访问）、跨站 WebSocket 拒绝和任务日志不可经文件路由读取；单元测试使用 fake CLI fixture，不需要凭证。

## 发布

发布由 `pnpm release`（bumpp）打出的 `v*` 标签触发。CI 不直接发布，而是把版本推入 npm 暂存区，**包不会公开**，直到维护者本人登录 npmjs.com 审核并用 2FA 批准。OIDC token 只能执行 `npm stage publish`，无法执行 `npm stage approve`，因此审批无法被工作流自动化。工作流使用 GitHub 自动提供的 `GITHUB_TOKEN` 创建 Release，不需要 `NPM_TOKEN`。

GitHub Release 在暂存成功后就会创建，**早于包公开**。因此 Release 正文开头会带上 npm 暂存状态和 Stage ID——Release 存在不代表 npm 审批已完成。

批准是人工步骤，需要支持 staging 的 npm CLI：

```bash
npm stage list @kibuniverse/domino
npm stage view <stage-id>
npm stage approve <stage-id>
```

`--tag` 是暂存包的不可变属性，批准后直接落到对应 dist-tag。公开仓库发布公开包时，SLSA provenance 由 OIDC 自动附加，不需要 `--provenance`。

### 首次启用前

npm 的 Trusted Publisher 配置入口只在**已存在**的包上出现，而 OIDC 又要求先有该配置，所以首个版本必须手动发布：

1. `@kibuniverse` npm organization 必须存在，且你的账号在其中拥有发布权限。scoped 包要求先拥有该 scope。
2. 手动发布首个版本（需账号级 2FA）：`npm login` 后 `npm publish --access public`。

   > 发布报 `E404 ... PUT https://registry.npmjs.org/@scope%2fname` 时，先查 `npm whoami` 而不是怀疑包名：registry 对**未认证**的创建请求一律返回 404 而非 401，以免泄露 scope 是否存在。granular access token 最长只有 90 天，过期就会走到这个分支，重新 `npm login` 即可。
   >
   > 反向也成立：发布成功后**立刻**查包可能仍返回 404，那是 registry 的 CDN 缓存（`cache-control: max-age=300`），不是发布失败。以 `~/.npm/_logs/` 中该次 `PUT` 的状态码为准，或加 `?t=$(date +%s)` 绕过缓存。
3. 在包页面 **Settings → Trusted publishing** 添加 GitHub Actions：

   | 字段 | 值 |
   |---|---|
   | Organization or user | `kibuniverse` |
   | Repository | `domino` |
   | Workflow filename | `release.yml` |
   | Environment name | `npm` |
   | Allowed actions | 允许 `npm stage publish`；不需要直接 `npm publish` 权限 |

   所有字段区分大小写；保存后无法修改，填错只能删除重建。`release.yml` 设了 `environment: npm`，所以这里必须填 `npm` 而不是留空——GitHub 会把 environment 写进 OIDC token，npm 会比对，不一致会被拒绝。

4. 首次暂存发布验证通过后，建议把包的 Publishing access 设为 **Require two-factor authentication and disallow tokens**。该设置只影响传统 token，OIDC 暂存不受影响。

发布工作流需要 npm >= 11.20.0（`release.yml` 中显式安装）；构建与测试仍由 `.npmrc` 固定的 Node 22.23.3 执行。
