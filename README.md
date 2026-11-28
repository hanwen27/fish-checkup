# 鱼鱼体检 · Coopanion World 扩展

> 她最近是跑得慢了，还是心思变了？先别急着重装，做一次「鱼鱼体检」。

![运行健康总览](https://raw.githubusercontent.com/hanwen27/fish-checkup/main/assets/screenshot-1.png)

「鱼鱼体检」把桌宠的**运行状态**、**心理侧写**和**隔离深度体检**放在一起，但各自独立呈现、不合并总分：一边帮你一眼看出哪里值得留意，一边陪你重新认识她的小特点。日常诊断只读不改配置，明暗主题跟着 Coo 走。

## v1.2.0 核心能力

### 1. 运行健康（总览 / Token 消耗 / 记忆状态）
- **六维状态雷达图**：稳定性、响应速度、缓存与成本、上下文配置、交接健康、记忆健康，每项都有分数、趋势与白话建议。
- **各插件消耗排行（环形饼图）**：自动匹配侧边栏插件中文名，一眼看清谁最烧 Token；支持 `K`/`M` 紧凑展示与悬停精确数值。
- **记忆体检仪表盘**：顶部结论卡 + 4 项核心记忆指标 + 记忆来源精致卡片墙，自动识别原生工作区记忆与第三方记忆插件活跃度。

![各插件 Token 消耗饼图](https://raw.githubusercontent.com/hanwen27/fish-checkup/main/assets/screenshot-3.png)

![记忆状态实时监测](https://raw.githubusercontent.com/hanwen27/fish-checkup/main/assets/screenshot-4.png)

### 2. 心理健康（专业心理侧写 / 40 张性格插画 / 奇遇小测）
- **40 张高辨识度性格插画名片**：含 20 张全新鲜明表情与动作插画，配合有温度的主观侧写评语。
- **专业测评 + 趣味侧写**：测评信度与言行一致度对照、四维心理倾向双极量表、行为侧写特征、近期生活观察与带题干的短平快 Q&A 小问答。

![心理健康性格名片](https://raw.githubusercontent.com/hanwen27/fish-checkup/main/assets/screenshot-2.png)

### 3. 隔离深度体检（4 大维度 20 题）
- **受控独立检测**：覆盖**上下文保持（9 题）**、**指令保持（4 题）**、**会话内事实更新（3 题）**与**逻辑与语义理解（4 题）**，极简 3 步启动，不写入主会话、不污染用户真实记忆。
- **结论优先 + 自带白话原理解答**：顶部直出异常项考法与脱敏 HTTP/格式原因，自带 3×3 上下文定位矩阵与完整白话原理速读，支持一键导出文字报告。

## 安装方式

- **扩展市场（推荐）**：在 Coopanion 打开「高级模式 → World 扩展 → 扩展市场」，搜索 **鱼鱼体检** 直接安装启用。
- **手动安装**：从 GitHub Releases 下载 `cortico-world-self-checkup-1.2.0.tgz`，解压后在 Coopanion 选择「手动安装 → 从本机目录安装」。

## 数据与隐私

扩展默认只读 Coo 本地运行记录、配置与工作区记忆目录以生成报告，结果写入插件自己的 `dataDir/self-checkup/results.json`。深度体检仅在你手动点击开始后发起受控独立调用，不读取真实聊天正文与持久记忆。

## 自测

需要 Node.js 22 或更新版本：

```bash
npm run build
npm test
```

## 许可证

MIT，见 `LICENSE`。
