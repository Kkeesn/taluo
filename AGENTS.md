# 云函数 taluo

这是一个腾讯云开发（CloudBase）云函数项目，本目录即函数的代码根目录。

## 基本信息

- 环境 ID：base-d1gxmzgqv9f560fc4
- 函数名称：taluo
- 函数类型：HTTP 函数（HTTP Function）
- 运行环境：Python3.10

### 类型说明

- 形态：在进程内启动 HTTP 服务，端口默认为 `9000`（不是 `exports.main`）
- Node.js 需提供可执行的 `scf_bootstrap`，且其中的 Node 路径要与运行时版本一致
- 依赖需随代码一并打包；浏览器跨域需自行处理 CORS
- 「HTTP 访问 / 网关」是给**事件函数**补 HTTP 入口用的，不要和本类型混用

## 推荐：用 AI IDE + CloudBase 集成开发

优先在 WorkBuddy / Cursor / CodeBuddy 等 AI IDE 中接入 **CloudBase AI Toolkit**（MCP + 云函数 Skill），用对话完成修改、部署、查日志、配 HTTP 访问。

- 总览与接入：https://docs.cloudbase.net/cloud-function/develop/ai-local
- 云函数 Skill（选型与写法约定）：https://docs.cloudbase.net/ai/cloudbase-ai-toolkit/prompts/cloud-functions
- WorkBuddy（内置连接器）：https://docs.cloudbase.net/ai/cloudbase-ai-toolkit/ide-setup/workbuddy
- Cursor：https://docs.cloudbase.net/ai/cloudbase-ai-toolkit/ide-setup/cursor
- CodeBuddy：https://docs.cloudbase.net/ai/cloudbase-ai-toolkit/ide-setup/codebuddy

安装云函数 Skill（建议）：

```bash
npx skills add https://github.com/tencentcloudbase/skills --skill cloud-functions
```

对话示例：「更新本函数代码并部署」「查最近执行日志」「给本函数配 HTTP 访问」。

## 备选：未接入集成时用 CLI

若当前环境没有 CloudBase MCP / AI Toolkit，再用 CLI 部署。

### 安装 CLI

```bash
npm install -g @cloudbase/cli
```

安装与登录说明：https://docs.cloudbase.net/cli-v1/install

首次使用需登录并选择环境，例如：

```bash
tcb login
```

### 常用命令

本地运行：

```bash
tcb fn run taluo
```

按当前运行时安装函数依赖后即可本地调试。更多用法：https://docs.cloudbase.net/cli-v1/functions/run

部署到 $LATEST：

```bash
tcb fn deploy --env-id base-d1gxmzgqv9f560fc4 taluo
```

若云端已存在同名函数，CLI 会提示是否覆盖；追加 `--force` 可跳过提示，但会同时覆盖函数配置与触发器，请谨慎使用。

从云端重新拉取代码：

```bash
tcb fn code download --env-id base-d1gxmzgqv9f560fc4 taluo
```

## 约束

- 不要把 HTTP 函数写成 `exports.main(event, context)`；保持端口 `9000` + `scf_bootstrap` 约定
- 第三方依赖声明在依赖描述文件中；事件函数可由云端安装依赖，HTTP 函数需自行打包依赖
- 不要提交密钥、本地依赖目录与构建产物
- 环境 ID 仅用于定位资源，按环境权限管理访问，勿当作可公开分享的凭证
