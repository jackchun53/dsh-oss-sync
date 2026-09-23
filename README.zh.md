# dsh-oss-sync

[English](README.md) | 中文

把一台机器的 DeepSeek Harness 设置和 API Key 放进一个兼容 S3 的 bucket，
让其他机器开机就拿到同一份配置，不必再手工拷贝文件。

它是一个可安装的插件包，分两半：

- **设置同步。** 它是 Harness 设置服务（`ctx.settings`）的一个客户端：把本
  profile 的设置 —— 模型、provider、默认模型，以及各设置页能编辑的其他值 ——
  镜像成 bucket 里一份可读的 YAML 文档，并把其他机器提交到那里的改动应用回来。
- **凭证存储。** 它替换掉保存 API Key 的存储（`$DSH_HOME/.credentials.yaml`），
  改为同一个 bucket 里的第二份文档。

这两处接缝之上的一切都没有动。Web 端的 **Settings → Models** 页面照旧通过
`ctx.settings` 写入，模型选择器照旧通过 `ctx.credentials` 解析密钥，
`agent-default-model`、`llm-pi-ai`、`llm-deepseek` 也仍然是各自原来的条目。

## 运行要求

**Harness 0.1.7 或更高版本。** 0.2.0 建立在 Harness 0.1.7 引入的设置模型之上
（值存在各插件的 volatile Config 里，并保存进 profile 的 `cordis.patch.yml`）。
更早的 Harness 请继续用 `dsh-oss-sync@0.1`；也不要在 Harness 0.1.7 上运行 0.1.x：
它会停用设置服务，Desktop 随后在启动时报 `desktop welcome: Web RPC failed`。
见[从 0.1.x 迁移](#从-01x-迁移)。

bucket 必须在 `PutObject` 上支持 `If-Match` 和 `If-None-Match`。

## 快速开始

```sh
# 1. 装进一个 profile
dsh plugin --profile web add dsh-oss-sync

# 2. 指向某个 bucket —— 既可以在启动界面的环境里给，也可以启动后在
#    插件管理页该插件的配置区块里填
export DSH_SYNC_BUCKET=my-dsh
export DSH_SYNC_ENDPOINT=https://oss-cn-shanghai.aliyuncs.com   # AWS 可省略
export DSH_SYNC_REGION=cn-shanghai

# 3. 重启，然后打开 Plugins → dsh-oss-sync
```

此后每台装了该插件包、并读到同一个 bucket 的机器，都共享这两份文档。配置第二台
机器就是同样这三步 —— 配置本身已经在 bucket 里了，首次同步的机器会从那里取。

没有 bucket 也能正常起来：两半都以纯本地模式运行，设置留在 profile 里，凭证留在
本机缓存里，不读也不写任何服务，插件管理页的配置区块就是你填 bucket 的地方。

## 同步什么

设置文档里，设置服务描述的每个 **profile 条目**占一段 —— 条目 id 就是各设置页
编辑的那些（`agent-default-model`、`llm-pi-ai`、`llm-deepseek`、
`web-search-deepseek`、`permission`、`ui-theme`、`locale` ……）。每段是该条目的
**用户层**：本 profile 保存的值，而不是其下的 bundle 默认值。

刻意不同步的：

- **密钥。** 插件声明为 `role('secret')` 的字段（例如在 Web Search 表单里填的
  API Key）在读取前就被脱敏，应用某一段时再从本 profile 恢复。API Key 应该放在
  凭证存储里，那边是有意同步的。
- **`!!js` 表达式。** 像 `apiKeyEnv: !!js process.env.X` 这样的值读的是本机环境；
  它留在 profile 里，应用远端改动后依然保留。
- **机器专有的条目。** 默认排除 shell 执行器（`pwsh-sandbox`、`bash-sandbox`、
  `pwsh-local`、`bash-local`、`shell`）：它们保存本机的工作目录和可执行文件路径。
  用 `include` / `exclude` 调整范围（见下文）。
- **本插件自己的行**（`oss-settings`、`oss-credentials`）：连接是读取 bucket 的
  前提，所以它永远不存进 bucket。
- **本 profile 没有运行的条目。** 本机没装的插件的那一段会留在 bucket 里给运行它的
  机器用，并在本 profile 第一次运行该插件时应用过来。

凭证文档与 0.1.x 相同：`refs`（引用名到密钥值）和 `records`（按插件划分的凭证
记录，包含授权 grant）。

## 设置同步如何工作

- **上传。** 一次设置写入（来自任意页面，或 Harness 重新加载的 profile patch
  手改）会触发 `settings/document-updated`。静置一秒后，同步读取 profile 的各段，
  把自上次同步以来变化的条目，带着读到的 ETag 上传。
- **应用。** 每次轮询都读取对象。bucket 改了、本 profile 没改的条目，用
  `ctx.settings.replace()` 应用，并以该条目的 revision 作为栅栏；应用前先把本
  profile 自己的密钥和表达式补回这一段，本 Harness 没声明的字段直接丢弃。另一台
  机器重置过的条目，这里也会重置。
- **不回声。** 每个 profile 记录一份基线 —— 上次同步时 bucket 的各段和它自己的
  各段 —— 并且在每次应用*之后*才记录。所以被应用的那一段读回来就是“本地未改动”，
  永远不会再被上传；没有新东西的同步，两个方向都不写。
- **初始化。** 基线还没见过的条目 —— 在某个位置第一次同步时就是全部条目 ——
  如果 bucket 里有这一段，就以 bucket 为准（**全新机器上以已有的 bucket 为准**），
  否则用本 profile 去初始化 bucket（**空 bucket 由本 profile 初始化**）。只有本机
  有的条目会合并进去，而不是被丢掉。
- **冲突。** 两台机器改**不同**条目会合并。两台机器改**同一个**条目：该条目整体
  以后上传者为准。被拒绝的写入（`412 Precondition Failed`）会重新读取并重新规划。
- **传播。** 设置由轮询应用，所以 `pollMs`（默认 30 秒）就是传播窗口；一次编辑
  在保存后约一秒离开本机。

基线按 profile 保存在
`$DSH_HOME/.dsh-oss-sync/profiles/<profile>/settings-sync.yaml`。由于 Harness
0.1.7 按 profile 保存设置，同一台机器上的 Desktop 和某个 CLI profile 各自与 bucket
同步 —— 也就通过 bucket 彼此同步。

## 安装

### CLI profile

`dsh plugin` 会把命令转发到 `$DSH_HOME/profiles/<name>` 里的 pnpm，并把该插件包
追加到 profile 的层列表：

```sh
dsh plugin --profile web add dsh-oss-sync
```

按 registry spec 安装就够了 —— 包里带的已经是构建产物。如果是本仓库的 git
checkout，也可以让随包的脚本自己去推断：

```sh
pnpm install && pnpm build          # 只有从 checkout 运行时才需要
node scripts/install.mjs --profile web --desktop
```

```
  --profile <name>   要装进哪个 CLI profile；可重复（默认：web）
  --spec <spec>      包 spec；默认用当前 checkout，或用它的 git remote
  --dsh <command>    如何调用 dsh；默认从 PATH、再到同级 checkout 中探测
  --desktop          另外打印 Desktop 的安装步骤
  --check            只校验组合后的层，不改动任何东西
  --dry-run          只打印每条命令，不执行
```

两种方式都会用 `--dump-config` 组合一次 profile，并确认生效的行确实是
`dsh-oss-sync` 和 `dsh-oss-sync/credentials`。这个校验是有意义的：一个包可以
装上了，但它的层并没有被组合进去。

harness 本身没有发布的 profile（比如 `--profile mine`）只会用
`@deepseek-ai/dsh-base` 初始化，因此没有 Web UI。默认用 `web` 就是这个原因。

### Desktop

`dsh` 会直接拒绝 `--profile desktop` —— 那个目录归 Electron 应用所有，插件由它
自己的插件管理页安装。在那里安装 `dsh-oss-sync`（**Plugins → 添加插件**，spec
`dsh-oss-sync@0.2.0`），然后重启应用。

- `@deepseek-ai/*` 是 `peerDependencies`：由应用提供，插件用的就是宿主自己的那份。
  这些 range 标明了 Harness 0.1.7 这一下限。
- 它的普通依赖（`@aws-sdk/client-s3`、`@aws-sdk/credential-provider-node`、`yaml`）
  都能在 profile 内解析，且不带安装脚本。
- `lib/` 和 `lib/client.js` 已提交进仓库、并由发布的 tarball 一起带走，所以安装时
  不构建任何东西。

Desktop 启动不需要任何环境变量。`setx DSH_SYNC_BUCKET ...` 仍可作为引导默认值。
注意 `DSH_*` 这类名字不能来自 `.env` 文件 —— harness 把整个前缀都当作启动环境专属。

0.1.x 附带的 `scripts/patch-desktop-asar.mjs` 已移除：它修补的 peer range 校验器
在 Desktop 0.1.7 里已经不存在了。

## 配置

### 环境变量

两半都从启动环境里读连接信息，所以一份已安装的包可以服务所有机器。这里的每个值
都只是引导默认值：插件管理页的配置区块会把自己的值保存进 profile，覆盖在它们之上。

| 变量 | 含义 |
|---|---|
| `DSH_SYNC_BUCKET` | 存放文档的 bucket。不设则两半都以纯本地模式启动；在这里设，或在配置区块里设。 |
| `DSH_SYNC_ENDPOINT` | 兼容 S3 的 endpoint（MinIO、Ceph、COS、OSS、TOS）；AWS 可省略。 |
| `DSH_SYNC_REGION` | 签名用 region；默认 `us-east-1`。 |
| `DSH_SYNC_PREFIX` | Key 前缀；默认 `dsh-sync`。 |
| `DSH_SYNC_FORCE_PATH_STYLE` | 只有要求 path-style 寻址的服务（常见于 MinIO）才设为 `true`。默认使用 virtual-hosted 风格，TOS、OSS、AWS 都要求这种风格。 |
| `DSH_SYNC_POLL_MS` | 轮询间隔，毫秒；默认 `30000`。 |
| `DSH_SYNC_ACCESS_KEY_ID` / `DSH_SYNC_SECRET_ACCESS_KEY` | bucket 的静态凭证；优先级见下。 |

bucket 凭证按以下顺序解析：配置区块保存的那一对；0.1.x 安装保存的整机那一对
（`$DSH_HOME/.dsh-oss-sync/connection.yaml`）；这两个环境变量；最后是 SDK 自己的
链条（`AWS_ACCESS_KEY_ID`、profile、实例角色）。

### 配置区块

打开该插件的页面 —— **Plugins → dsh-oss-sync** —— 配置区块就位于描述与组件列表
之间，并带状态标记：保存 bucket 之前显示 `仅本机`，部署不可写时显示 `只读`，宿主
还没应答时显示 `等待宿主`，有未保存改动时显示 `未保存`。离开页面会丢掉所有暂存的
改动；被拒绝的保存会保留暂存内容，并就地说明。

该区块通过 Harness 的设置表单编辑 `oss-settings` 行的 live Config，所以一次保存
会落进本 profile 的 `cordis.patch.yml`，无需重启就生效。Harness 会把这一行的完整
配置存在那里；你没编辑的字段里那些 `!!js process.env…` 默认值会以表达式形式保留。

| 字段 | 含义 |
|---|---|
| `bucket`、`endpoint`、`region`、`forcePathStyle`、`accessKeyIdEnv`、`secretAccessKeyEnv` | 连接参数。不带 URL scheme 的 endpoint 会被规范化为 `https://`。TOS/OSS/AWS 用 `forcePathStyle: false`；只有兼容 MinIO 的服务要求时才打开。 |
| `accessKeyId`、`secretAccessKey` | bucket 自己的 OSS/TOS/S3 凭证 —— **不是**模型 provider 的 API Key。保存在本 profile 的 `cordis.patch.yml`（权限 0600），永不写入 bucket。secret 是 `role('secret')` 字段：宿主永远不会回传，所以输入框显示 `已保存（留空保持不变）`，留空即保持原值。**清除** 会保存一对显式为空的值，同时删掉 0.1.x 留下的整机 `connection.yaml`。 |
| `prefix` | Key 前缀。修改它会把两份文档一起搬走：新位置已有文档则以它为准，为空则用本 profile 初始化。 |
| `pollMs` | 轮询间隔；立即生效。 |
| `include` | 要同步的条目 id，逗号分隔；留空同步全部条目。 |
| `exclude` | 永不同步的条目 id，逗号分隔；默认是 shell 执行器。 |
| `status` | 运行期信息，只读：按半边（`settings`、`credentials`）给出 revision、writer、提交时间、object key、最近一次读/写、最近一次同步应用或上传的条目，以及最近一次错误。本插件把它发布到自己运行中的 Config 引用里；它从不写进 profile，也不写进 bucket。 |
| `request` | **立即同步** / **强制推送** 会在这里写入一个新 token，宿主随即在两半上执行同步。`push` 用本 profile 的各段覆盖 bucket 里的。 |

`secretAccessKey` 是掩码字段，而 Chromium 禁止从掩码输入里剪切或复制。所以这个
字段自带 **显示 / 隐藏**（切换 input 类型而不动值）和 **复制**（把字段当前的文本
交给宿主剪贴板）—— 两者作用于你输入的内容，因为已保存的 secret 永远不会到达页面。

### 按 profile 覆盖

配置区块是配置 profile 的常规方式，它写的就是该 profile 的
`$DSH_HOME/profiles/<name>/cordis.patch.yml`。手改这个文件也可以：

```yaml
- id: oss-settings
  config:
    bucket: my-dsh
    endpoint: https://oss-cn-shanghai.aliyuncs.com
    exclude: [pwsh-sandbox, bash-sandbox, ui-theme]
```

`oss-credentials` 不需要单独写一行：凭证那一半跟随 `oss-settings` 解析出的连接。
它自己那一行只是冷启动时的默认值。

强烈建议开启 Governance 模式的 bucket 版本控制：正是它把一次误覆盖变成一次可恢复
的版本。

## bucket 里存了什么

两个对象，`<prefix>/settings.yaml` 和 `<prefix>/credentials.yaml`，都是可读 YAML，
方便 diff 和手改：

```yaml
v: 1
rev: 12
writer: 6f1c1a1e-…
updatedAt: 2026-09-23T09:12:03.114Z
doc:
  llm-deepseek:
    reasoningEffort: max
  llm-pi-ai:
    providers:
      my-gateway:
        apiKeyEnv: GATEWAY_API_KEY
        baseURL: https://gateway.example/v1
        api: openai-completions
  agent-default-model:
    provider: deepseek-official
    model: deepseek-flash
```

信封格式和对象 key 与 0.1.x 写的一致，所以 0.1.x 填过的 bucket 可以原样读取。
0.1.x 的段名 `ui-developer-tools` 和 `ui-onboarding` 会按现在拥有它们的条目
（`ui-settings`、`ui-settings-general`）读取，0.1.x 的 `oss-sync` 段则被忽略。

每台机器自己的状态留在 `$DSH_HOME/.dsh-oss-sync/` 下：一个稳定的 `device-id`、
凭证缓存、一次性导入标记，以及每个 profile 的设置基线。

## 从 0.1.x 迁移

插件与 Harness 一起升级（或紧随其后）：0.1.x 在 Harness 0.1.7 上起不来，0.2.0
在它之前也起不来。

```sh
dsh plugin --profile web add dsh-oss-sync@0.2.0
```

Desktop 上，从插件管理页安装 `dsh-oss-sync@0.2.0`，然后重启。首次启动时，每个
profile 各发生一次：

- **Harness 把 `$DSH_HOME/settings.yaml` 导入 profile**，并把它改名为
  `settings.yaml.imported`。装着 0.1.x 时这个文件是安装前的副本，可能已经过时；
  后面几步会覆盖它。
- **导入 0.1.x 的缓存。** 0.1.x 把实时设置放在
  `$DSH_HOME/.dsh-oss-sync/settings.yaml.cache`。其中的各段会写进 profile；0.1.x
  页面保存的连接（bucket、endpoint、region、prefix、寻址方式、轮询间隔）会写进
  `oss-settings` 行 —— 除非这个 profile 已经有 bucket。
- **执行第一次同步**：bucket 里的各段优先于 profile 里的，只有本 profile 有的段
  会被上传。
- **bucket 凭证照常可用。** 0.1.x 页面保存在 `connection.yaml` 的那一对仍作为整机
  回退读取。在配置区块保存一对即可覆盖它，按 **清除** 则让它退役。

与 0.1.x 的其他差异：

- 不再替换设置：`settings` 行保持挂载，本插件通过它同步。Harness 0.1.7 按
  profile 保存设置，所以每个 profile 各自同步；原来那份全局文档不存在了。
- 设置的读取不再依赖 bucket 或缓存 —— profile 本身就是本地副本 —— 所以 bucket
  不可达只会推迟传播，别的都不受影响。离线时做的编辑，会由第一次连上 bucket 的
  同步上传。
- 密钥类表单字段不同步。
- 移除了 `scripts/patch-desktop-asar.mjs`。

要回退，就把 `dsh-oss-sync@0.1.x` 和早于 0.1.7 的 Harness 一起装回去。

## 安全 —— 部署前必读

凭证文档在 bucket 里是**明文**。这是为那些接受 bucket 级保护的部署方式做的刻意
取舍；它比本地存储弱，后者至少把文件限制在单个操作系统用户下。

- 任何对 bucket 有读权限的人，或一把泄露的 access key，都握有全部 provider key。
- 配置不当的公开 bucket 会把它们暴露到公网。
- 泄露的 access key 还会让攻击者*写入*你的模型配置，包括指向他们自己网关的
  base URL。

既契合该设计、又不用对 agent 隐藏取值的缓解手段：私有 bucket、把 RAM 策略按
前缀收紧到最小权限、SSE-KMS、每台机器使用短期 STS 凭证、开启 bucket 版本控制、
以及访问日志。如果这还不够，正确的改动是做一个用口令派生密钥加密文档的凭证
provider —— 接缝留了位置，而且接缝之上的一切都不用改。

bucket 自己的 access key 绝不能来自同步文档：它是引导凭证。

## 已知限制

- **设置随轮询应用。** 另一台机器的编辑在 `pollMs` 之内到达；点 **立即同步** 可
  马上应用。
- **同一条目的冲突按后写者胜出**，整条目为单位。
- **profile 行会被“钉住”。** 一个条目里只要保存过任何东西，Harness 就会把它的
  完整配置存进 profile，被应用的段也一样：此后 bundle 对该条目默认值的改动不再
  到达这个 profile，直到该条目被重置。这是 Harness 自身表单的行为。
- **只同步表单字段。** 文档只包含 volatile Config 字段 —— 也就是设置页能编辑的
  那些。手改 profile patch 加进去的普通 Config 只留在本地。
- **macOS 上缺 Edit 菜单的 Desktop 壳，连普通文本框也复制不了。** 区块里的
  **复制** 走的是 `navigator.clipboard` 而不是菜单，所以在补上那个菜单项之前，
  它是掩码字段唯一能用的复制路径。
- **配置区块尚未在屏幕上验证过。** `pnpm test:card` 会把构建产物对着桩模块表物化，
  并断言它的标记和交互；宿主那半边由 smoke 测试和一次针对真实 0.1.7 运行时的启动
  覆盖。还没有一次运行在浏览器里确认过 CSS。
- **凭证没有 `.env` 回退。** `dsh-credentials-local` 会依次叠加进程环境、存储
  文件、`<cwd>/.env` 和 `$DSH_HOME/.env`。本 provider 只叠加环境和 bucket。
- **离线的凭证写入会失败。** 凭证读取会回退到缓存；bucket 不可达时凭证写入会被
  拒绝。凭证没有离线队列。
- **一对文档一个 bucket。** 设置和凭证共用同一个前缀，因此也共用同一个 bucket。

## 工作原理

插件包的 patch（`cordis.patch.yml`）对 `dsh-base` 组合做两件事：

| 行 | 基础包 | 本插件包 |
|---|---|---|
| `settings` | `@deepseek-ai/dsh-settings` | 保持挂载；在它旁边插入 `oss-settings`（`dsh-oss-sync`），通过 `ctx.settings` 同步 |
| `credentials` | `@deepseek-ai/dsh-credentials-local`（`$DSH_HOME/.credentials.yaml`） | 停用；用它自己的 id 插入 `oss-credentials`（`dsh-oss-sync/credentials`） |

loader patch 不能给一行改名 —— 它的 `name` 是 patch 必须匹配上的断言 —— 所以
凭证存储是通过“停用 + 插入”来替换的。

`oss-settings` 把它的连接、范围、request 和 status 字段声明为 `.volatile()`。
正因如此它们成了一个设置表单（插件管理页的区块通过 `ctx.configForms` 编辑它们），
保存后的编辑也以 `loader/volatile-update` 的形式到达运行中的插件，而不是重新挂载。
它还提供 `ossSyncControl`，凭证那一半通过它跟随连接并上报自己的状态。

harness 自身的加载规则有两个后果塑造了本包的结构：

- 包根（`lib/index.js`）是设置同步，而不是某个子路径入口，因为浏览器模块扫描是
  **按裸包 specifier** 命名的 Loader 行去解析一个包的 `dsh.client` 产物的。
- `lib/client.js` 不是 ES module。combo 路由会把多个包拼成一个脚本，其中任何一个
  在顶层写 `import` 都会把整个脚本带崩。该产物是一个惰性的 CommonJS factory，外面
  包着 `window.__ModuleLoader__.load({ id, factory })`。

## 开发

```sh
pnpm install
pnpm build          # tsc → lib/，再 esbuild → lib/client.js
pnpm smoke          # 假 S3 与假设置服务的端到端检查
pnpm test:card      # 浏览器端区块，跑在桩模块表上
pnpm test           # 两者都跑
```

`tsconfig.json` 通过 `paths` 把 `@deepseek-ai/*` 这些 peer 包解析到同级
`deepseek-harness` checkout 的已构建声明文件上，所以必须先构建那个 checkout
（0.1.7 或更高），这个才能编译。

`lib/` 就是 loader 实际加载的东西：每次改完源码都要重新构建，然后重启 profile。

发布流程和其余维护者向的细节见
[CONTRIBUTING.md](https://github.com/jackchun53/dsh-oss-sync/blob/main/CONTRIBUTING.md)。

## 更新记录

### 0.2.0

- 需要 Harness 0.1.7。设置改为通过公开的设置 API 同步，而不是替换设置存储；
  `settings` 行保持挂载，修复了 0.1.x 在 0.1.7 上造成的 Desktop 启动失败。
- 按条目的三方同步，每个 profile 一份基线：不回声；首次同步时以已有 bucket 为准；
  空 bucket 由本机初始化；只有本机有的条目合并进去。
- 密钥、`!!js` 表达式、shell 执行器和本插件自己的行永不进入 bucket；
  `include` / `exclude` 设定范围。
- 插件管理页的区块编辑 `oss-settings` 行的 live Config；bucket 凭证保存在
  profile 里，0.1.x 的 `connection.yaml` 保留为回退。
- 每个 profile 一次性导入 0.1.x 的设置缓存和连接。
- 移除 `scripts/patch-desktop-asar.mjs`；Desktop 0.1.7 已没有要修补的 peer range
  校验器。

### 0.1.x

替换基于文件的存储的设置与凭证 provider，适用于 Harness 0.1.5–0.1.6。

## License

MIT —— 见 [LICENSE](https://github.com/jackchun53/dsh-oss-sync/blob/main/LICENSE)。
