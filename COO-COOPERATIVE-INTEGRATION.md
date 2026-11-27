# COO 协作深度体检：本地实现与接入说明

2026-11-26，方法 DC-0.2。本文件区分已运行的原生机制、已验证的编排代码与尚未接入的真实模型／插件。

## 已运行的内容

`results/深度体检-原生机制实测.json` 是对本机 COO 程序源码的真实执行记录，使用独立 Cormini 实例和独立 SessionLog：

- 经公共入口 `MainLoop.handoffContext()` 运行真实交接事务，并观察交接边界、会话重置和笔记注入；没有以手工截断文本代替交接。
- 首／中／尾三个短合成场景都检查目标、约束、待办、最新事实。每例的信息都在交接后的注入材料中保留，没有用模型回答冒充笔记证据。
- 原生 `GitWorkspaceMemory` 的阴性对照、写入、重新实例化读取、覆盖更正和删除后读取均通过。每次重新实例化使用同一个独立测试目录，不读取正式工作区。
- 使用 256000、0.85、0.25 的示例策略，明确不声称从当前配置读取。测试没有让上下文增长到软线，不能据此评价自动交接频率或长上下文效果。
- 原生机制检查不调用模型，实际模型请求与输入／输出 Token 都为零。测试目录已清理；报告只保存判定、计量和证据，不保存原始合成提示或回答。

## 随包验证

需要 Node.js 22 或更新版本。普通回归：

```powershell
node --test "tests/*.test.mjs"
```

完整的本机 COO 源码集成测试需要显式提供 COO Cortico 源码目录；这只读源码，不代表安装到正在运行的 COO：

```powershell
$env:COO_SOURCE_ROOT = 'path/to/your/cortico/source'
node --experimental-transform-types --import ./tools/register-coo-source.mjs --test "tests/*.test.mjs"
```

没有设置源码目录时，该集成测试会跳过。测试只使用合成材料和独立临时存储，不发起真实模型请求。

## 如何由 COO 装配层接入

`src/index.ts` 导出 `createCooperativeCheckupDefinition(hostFactory)`，在 World 构造时接受显式宿主桥。默认 `CHECKUP_WORLD` 没有此桥，不会自动寻找或借用普通 `cognition`。

原生桥的构造要素：

```js
const Native = await loadCooNativeBindings(programSourceRoot);
const definition = createCooperativeCheckupDefinition((ctx) => createCooNativeHost({
  Native,
  dataDir: ctx.dataDir,
  runtime: () => ({
    stageTokens: actualPolicy.maxTokens,
    softRatio: actualPolicy.softRatio,
    keepRatio: actualPolicy.keepRatio,
    origin: 'live-host',
  }),
  transport: verifiedModelTransport,
  inventory: readHostExtensionMetadata,
  memoryAdapters: reviewedIsolatedAdapters,
}));
```

代码中的 `actualPolicy`、`verifiedModelTransport`、`readHostExtensionMetadata` 和 `reviewedIsolatedAdapters` 是装配层必须提供的依赖，不是声称 COO 0.2.23 已有的 WorldHost 字段。每次读取 runtime；配置指纹改变则旧预检失效。接入文件必须位于可编辑的 COO 源项目并按该项目运行方式构建，不能把此示例当作已经安装的宿主改动。

## 真实模型传输的必备条件

宿主传输提供 `inspect()`、`countMessages(messages)` 与 `complete(request)`：

- inspect 提供模型、真实窗口配置、最大输出、配置指纹、完整数据范围，以及 `counting: 'exact'`、`singleAttempt: true`、`noTools: true`、`noImplicitPrompts: true`。这些声明还需接入审查和提供方实测；布尔字段本身不是验证证据。
- countMessages 包含完整请求的角色／协议开销，不能用字符数或本地通用估算冒充实际分词。若服务端会插入未知内容，暂不启用模型模式。
- complete 只发一次，传递输出与输入上限及取消信号，不附带正式对话、正式提示、工具表、真实记忆或持久会话标识。失败与取消也回报用量；未知用量则控制器暂停，不记零。
- 长上下文完整请求按阶段预算和已知模型输入上限较小值的 25%／50%／75% 制定。三个位置共用同一请求，因此不是九个独立样本。
- 交接基线和交接后问题一致，使用真实原生事务产生的合成材料。若基线答错，不将交接后答错直接归因给交接或插件。

本轮没有读取凭据、没有选择真实服务端，也没有实现针对某个提供方的计费／分词适配。当前缺少这些依赖时，模型模式保持禁用。

## 第三方记忆适配器

仅显式注册经过审查的适配器，不能通过目录名称猜测插件，不能自动执行未知插件代码。清单只返回名称、ID、类型、版本和可用的启用状态，设置、路径、密钥和记忆正文不返回前端。

适配器提供 ID／名称／版本和 `createIsolated({directory, namespace, signal})`。所得实例提供 `verifyIsolation`、`write`、`read`、`remove`、`reconnect`、`cleanup`：

- 存储和检索权限必须限制在专用测试目录或测试用户／命名空间；不得只在提示词里要求隔离。
- verifyIsolation 返回可对照的 namespace 和正式记忆不可访问的声明；仍须用权限审查、负对照和操作追踪验证这些事实，不能只相信自报。
- reconnect 应重新建立存储连接；其测试仅证明适配接口重开后的结果，不自动证明新模型会话的自主召回。
- cleanup 返回含 namespace 的清理回执，随后还须验证合成键不存在。适配器清理失败会使整轮清理状态未验证，即便本地目录已删除，也不允许再开始。
- 不支持可靠取消、隔离和清理的实际插件暂不注册；报告写未适配／未测，不能判其不健康。

当前没有任何实际第三方插件适配器。测试中的 fixture-memory 只用于验证清理失败不会被隐藏。

## 展示与验证范围

真实插件面板新增“COO 链路验证”页，包含范围选择、预检确认、普通清单气泡、六格消耗／运行条件、机制与模型分开解读、逐项证据、停止和文字导出。两份 COO 格式 HTML 的启动／运行状态是交互样稿，结果页使用本轮原生实测数据；不会从静态文件发模型请求。

合并到 1.0.8 发布基线后的随包回归为 59/59 通过，包括实际 COO 源码集成、未知用量暂停、停止、配置变化、预算不足、存储持久化、拥有标记保护、第三方清理失败传播，以及前端挂载和结果解释。静态页面三态切换、确认、气泡与停止脚本另行通过验证。

浏览器自动化视觉验收未完成；本轮通过随包回归测试验证界面挂载与结果解释。1.0.9 没有修改或重启实际 COO；默认装配未注入宿主桥。
