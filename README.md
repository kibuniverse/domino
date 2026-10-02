# domino

在 React 开发页面选择元素，描述修改要求，由本地 Codex 或 Claude Code 修改源码，并通过 Vite 更新页面。

第一版对外为一个包 `@zephry/domino`，内部按编译转换、浏览器 runtime、任务核心和 Agent Adapter 分模块。分别通过官方 `@openai/codex-sdk` 和 `@anthropic-ai/claude-agent-sdk` 调用 Codex、Claude Code。当前尚未发布到 npm。

## 本地运行

要求 Node.js 22.12+、pnpm、Codex CLI 0.160.0+。仓库通过 `.npmrc` 为 pnpm 固定 Node 22.23.3。示例使用现有 Codex 登录，或 `CODEX_API_KEY` / `OPENAI_API_KEY`。

```bash
pnpm install
pnpm example
# 或安装并登录 Claude Code 2.1.287+ 后：
pnpm example:claude
```

打开终端显示的本地地址，将鼠标悬停在目标元素上，按 `Space` 或 `Alt+Space` 调起输入框并自动选中当前元素 → 输入要求 → 回车发送。也可点击右下角 domino，默认使用最近悬停的页面元素；需要更换目标时点击“选择/切换元素”。输入期间目标保持固定。默认快捷键为 `Space` 和 `Alt+Space`，可配置为其他组合或组合列表；如果被操作系统截获，使用面板按钮。

选择模式会阻止目标按钮的点击行为。修改后显示真实候选 diff、执行日志和模块更新确认。源码或 DOM 更新后需要重新选择元素。

## 独立 React 接入项目

仓库同层级的 `../domino-react-app` 是完整的 React + TypeScript + Vite 工作台，具有独立 `package.json`、锁文件、业务源码和构建配置。它安装 `vendor/zephry-domino-0.1.0.tgz`，验证真实 npm 包接入，不使用工具源码 alias。

```bash
pnpm --dir ../domino-react-app install
pnpm --dir ../domino-react-app dev
# 使用 Claude Code：
pnpm --dir ../domino-react-app dev:claude
# http://127.0.0.1:5180/
pnpm --dir ../domino-react-app build
```

支持页面切换、项目搜索和分类、新建项目、待办勾选。业务状态保存在内存中，刷新恢复初始数据；可选择“新建项目”按钮体验 Agent 修改、HMR、diff 与撤销。默认 `pnpm dev` 使用 Codex，`pnpm dev:claude` 使用 Claude；切换前需停止当前服务。

## 接入 Vite

本地打包后可将生成的 tarball 安装到其他项目：

```bash
pnpm build
npm pack
# 在目标项目安装生成的 zephry-domino-0.1.0.tgz
```

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { domino } from '@zephry/domino/vite'

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

`agent.model` 可指定本地登录有权使用的模型；不指定时使用 Codex 的默认模型。`agent.authHome` 可指定已有文件凭证的 Codex 目录。domino 在独立临时配置目录复用 `auth.json`，不读取或展示凭证内容；不继承用户的 MCP、插件、hooks 或自定义模型供应商配置。仅存于系统钥匙串的登录暂不支持，可使用 API key，或先运行 `codex -c 'cli_auth_credentials_store="file"' login`。

两个官方 SDK（`@openai/codex-sdk`、`@anthropic-ai/claude-agent-sdk`）声明为**可选依赖**：默认随包安装，只使用单一 Agent 的环境也可显式排除；缺少对应 SDK 时 domino 会报 `AGENT_SDK_NOT_INSTALLED` 并提示安装命令。两者均为精确版本锁定（每版经过兼容性验证），升级由 Dependabot 分组 PR 跟进。

### Claude Code

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

`directories` 必须是工作区相对源码目录。默认只允许其下的 JS/TS、JSX/TSX、CSS/SCSS/Less、JSON、SVG、HTML 等文本文件。二进制资源、隐藏文件、符号链接、依赖目录和构建配置不在自动修改范围内。

## 执行与恢复

1. 编译阶段只标记原生 JSX 节点，位置和 ID 绑定当前源文件 hash。提交和出队执行时分别验证版本。
2. 保存当前源码，包括已存在的未提交和未跟踪文件；将支持的文件复制到临时工作区，并提供少量项目元数据。
3. 根据 `agent.provider` 调用官方 SDK，消费结构化事件并通过取消信号停止执行。Codex 的 `startThread()` / `runStreamed()` 使用权限 profile，仅允许读取副本、写入源码目录和专用临时目录，工具网络关闭；每次运行前实际探测允许写入及拒绝越界读写。Claude 的 `query()` 使用上面的文件工具权限 hook。两个适配器均复用任务核心，没有自定义 CLI RPC 客户端。
4. Agent 结束后核对真实文件差异、JS/TS/JSON 语法和编辑范围，并确认原工作区仍与快照一致，再应用改动。
5. 撤销前检查所有相关文件是否仍符合任务结果；检测到后续编辑时整项拒绝。新建、删除和修改文件均记录恢复信息。

取消或超时会通过 SDK 的 `AbortSignal` 停止 CLI，展示可读取的部分候选 diff；候选改动不会因此自动应用。默认超时为 5 分钟，以容纳模型服务的连接重试；可按项目调整。进入确定性应用阶段后，请等待应用结束，再使用撤销。

任务记录与前后内容保存在项目的 `.domino/tasks/`，应加入 `.gitignore`；插件阻止开发服务器通过文件路由读取该目录。最近 20 项记录可在重启后查看和撤销；未完成任务标记为中断，不会自动重新执行。同一工作区只允许一个 domino 服务，多个浏览器页签共享队列。

快照上限为 1000 个文件、单文件 1 MiB、合计 10 MiB；单次候选改动最多 30 个文件、diff 合计 1 MiB。超限会阻止应用。多文件应用和撤销并非原子事务，逐文件记录进度；运行期间仍应避免手工修改相关文件。外部编辑器没有共同文件锁，最后一次 hash 检查与写入之间仍存在竞争窗口。

## 支持范围

包尚未发布 1.0：0.x 阶段 minor 版本可能包含破坏性变更，升级前请查看 [Release Notes](https://github.com/kibuniverse/domino/releases)。

已使用 macOS、Node 22.23.3、Vite 8.3.2、React 19.3.0、`@vitejs/plugin-react` 6.1.1 和 Chrome 验证浏览器闭环。当前集成目标为 `@openai/codex-sdk` / Codex CLI 0.160.0，以及 `@anthropic-ai/claude-agent-sdk` 0.3.287 / Claude Code 2.1.287。权限和事件接口升级后应重跑 smoke test。Linux 尚需目标环境验证；Codex 在 Windows 首版禁用真实执行，Claude 的 Windows 集成尚未验证。

- 支持单元素选择、父节点定位提示、任务队列、重连状态快照、真实 diff、取消、受控撤销与 Vite 编译诊断展示。
- 第三方组件可能只能定位到带标记的父元素；没有源码标记时无法提交任务。当前使用处与共享组件选项表达用户意图，不保证实例级映射。
- Agent 在临时源码副本执行，检查后自动应用；暂未提供候选 patch 的人工审批模式。
- 目前仅进行文件范围、并发冲突和 JS/TS/JSON 语法检查，不替代项目类型检查、lint、测试或视觉验收。模块更新确认不代表视觉要求已经满足，CSS-only 修改可能保持“更新待确认”。
- 暂不支持 Fiber、截图、SSR/RSC、Webpack/Rspack、Vue、远程开发桥接、跨域 iframe 和封闭 Shadow DOM。

Agent 路由只接受 loopback 连接，检查精确 Host/Origin，并通过首次 WebSocket 消息校验每次启动生成的 token。生产构建不启用插件，不注入标记、runtime 或任务服务。需要将 domino 放在其他改写 JSX 的插件之前；无法确认原始代码位置时跳过该文件。

本地文件执行不代表离线推理，源码上下文可能发送到所选 Agent 配置的模型服务。任务快照包含项目源码，清理 `.domino` 前请先结束任务并确认不再需要历史撤销。

## 开发与验证

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

```
src/transform/     JSX 标记、原始位置、source map、语法校验
src/runtime/       Shadow DOM 浮层、选择器、任务与 diff 展示
src/core/          登记表、协议校验、快照、队列、持久化与撤销
src/agents/        官方 Codex / Claude SDK 适配与 provider 选择
src/vite/          编译及开发服务器接入
examples/react/    可直接运行的 React 示例
tests/            单元、协议与浏览器测试
```

包提供根入口、`/vite`、`/core`、`/transform`、`/agents/codex`、`/agents/claude`；根入口导出 `AgentConfig` 类型。适配器按 provider 延迟加载；浏览器 runtime 为插件使用的内部入口，独立打包，不引入 Node 依赖。
