# dsh-oss-sync

[English](README.md) | 中文

把一台机器的 DeepSeek Harness 设置和 API Key 放进一个兼容 S3 的 bucket，
让其他机器开机就拿到同一份配置，不必再手工拷贝文件。

它是一个可安装的插件包，替换掉那两个让一台机器变得“属于你”的存储 ——
**用户设置**（模型、provider、默认模型）和 **凭证**（API Key）—— 并把两者放进
同一个 bucket，存成可读的 YAML，方便 diff 和手改。

接缝（seam）之上的一切都没有动。Web 端的 **Settings → Models** 页面照旧通过
`ctx.settings` 写入，模型选择器照旧通过 `ctx.credentials` 解析密钥，
`agent-default-model`、`llm-pi-ai`、`llm-deepseek` 也仍然是各自原来的命名空间。
变的只有存储。

## 快速开始

```sh
# 1. 装进一个 profile
dsh plugin --profile web add dsh-oss-sync

# 2. 指向某个 bucket —— 既可以在启动界面的环境里给，也可以启动后在
#    Settings → Plugins 里填，两者是同一份配置
export DSH_SYNC_BUCKET=my-dsh
export DSH_SYNC_ENDPOINT=https://oss-cn-shanghai.aliyuncs.com   # AWS 可省略
export DSH_SYNC_REGION=cn-shanghai

# 3. 重启，然后打开 Settings → Plugins
```

此后每台装了该插件包、并读到同一个 bucket 的机器，都共享这两份文档。配置第二台
机器就是同样这三步 —— 配置本身已经在 bucket 里了。

没有 bucket 也能正常起来：provider 以纯本地模式运行，每个命名空间都从本机缓存的
那份文档解析，不读也不写任何服务，卡片就是你填连接的地方。首次启动时会先把
`settings.yaml` 和 `.credentials.yaml` 导入到那份缓存，然后才停用基于文件的行。
之后在卡片里保存一个 bucket，会拿本机持有的整份文档去初始化它，所以已有的模型
provider API Key，以及 bucket 存在之前手填过的任何东西，都不会丢。

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
`dsh-oss-sync/settings` 和 `dsh-oss-sync/credentials`。这个校验是有意义的：一个包
可以装上了，但它的层并没有被组合进去。

harness 本身没有发布的 profile（比如 `--profile mine`）只会用
`@deepseek-ai/dsh-base` 初始化，因此没有 Web UI。默认用 `web` 就是这个原因。

### Desktop

`dsh` 会直接拒绝 `--profile desktop` —— 那个目录归 Electron 应用所有，插件由它
自己的插件窗口安装：

```
error: profile "desktop" is managed exclusively by the Electron application
```

那个窗口**只接受 npm registry 的包 spec**。它用 `packageNameFromSpec` 校验 spec，
拒绝任何带 URL scheme 或 `file:` 的东西，然后在 profile 里执行
`pnpm add <spec> --save-exact --ignore-scripts`。所以对 CLI profile 好用的
`github:` 或本地路径 spec，在 Desktop 上根本装不了。

因此请从插件窗口安装 `dsh-oss-sync`（窗口要版本号的话就带上版本）。有三条性质
让它能通过那套校验：

- `@deepseek-ai/*` 是 `peerDependencies`，这正是 Desktop 对宿主自有包的要求，而
  它们的 `*` range 能匹配应用捆绑的任何版本。后半句需要校验器在比较 peer range
  时把预发布版本算进去：Desktop 自己发布的宿主包就是预发布版（`0.1.5-rc.2`），
  而单纯的 semver 永远不会让 `*` 匹配上预发布版，于是旧版 Desktop 会以
  `requires @deepseek-ai/dsh-credentials@*, found 0.1.5-rc.2` 拒绝安装。这个修复
  属于 `apps/desktop/src/profile-packages.ts`
  （`satisfies(version, range, { includePrerelease: true })`），因为插件无论声明
  什么 range，都熬不过下一个预发布版本号。在你手上有带该修复的构建之前，可以先
  给已安装的那份打补丁 —— 见下面的*旧版 Desktop 构建*。
- 它的普通依赖（`@aws-sdk/client-s3`、`@aws-sdk/credential-provider-node`、`yaml`）
  都能在 profile 内解析，且不带安装脚本，所以 reviewed-build 名单不需要新增条目。
- `--ignore-scripts` 意味着安装时不构建任何东西，这正是 `lib/` 和 `lib/client.js`
  被提交进仓库、并由发布的 tarball 一起带走的原因。

Desktop 和 CLI 共用 `$DSH_HOME`，所以两个界面读的是同样这两份同步文档和同一份
离线缓存。

Desktop 启动不需要任何环境变量：没有 bucket 时 provider 以纯本地模式运行，应用
照常启动，连接就在 `Settings → Plugins` 里配置。`setx DSH_SYNC_BUCKET ...` 也仍然
可用，但它只是引导用的默认值，不是前置条件。注意 `DSH_*` 这类名字不能来自
`.env` 文件 —— harness 把整个前缀都当作启动环境专属。

安装完请重启界面：provider 是在启动时挂载的。

### 旧版 Desktop 构建

上面那个校验器缺口只能在应用侧修，所以早于该修复的 Desktop 构建，无论 manifest
怎么写都会拒绝这个包。`scripts/patch-desktop-asar.mjs` 改为把那一个参数写进已
安装的构建里，这才让插件在那边装得上：

```sh
# 1. 彻底退出应用，托盘也要退：app.asar 是原地重写的
# 2. 给已安装的构建打补丁，下面是默认安装目录
node scripts/patch-desktop-asar.mjs --app "%LOCALAPPDATA%\Programs\DeepSeek Harness"

# patched C:\Users\you\AppData\Local\Programs\DeepSeek Harness\resources\app.asar
#   backup:   ...\resources\app.asar.bak
#   files:    /lib/main.js (90953 -> 90982 bytes)
#   size:     2365617 -> 2365646 bytes

# 3. 重新启动，然后在插件窗口里安装 dsh-oss-sync
```

PowerShell 里这个变量写作 `$env:LOCALAPPDATA`；如果安装时改过目录，就用你实际
指向的那个。两种情况都不需要另装 Node：应用自带一个，就在被改的那个归档旁边的
`resources\runtime\node\node.exe`，而任何较新的 Node 行为都一样。

该脚本也随发布的 tarball 一起走，位置是
`$DSH_HOME/profiles/desktop/node_modules/dsh-oss-sync/scripts/patch-desktop-asar.mjs`，
以后应用重装时就用这一份。

| 调用方式 | 改的是哪个归档 |
|---|---|
| `node scripts/patch-desktop-asar.mjs` | `./resources/app.asar`，即当前 shell 所在的那个解包构建 |
| `node scripts/patch-desktop-asar.mjs "<app.asar>"` | 指定的那个归档 |
| `node scripts/patch-desktop-asar.mjs --app "<dir>"` | `<dir>/resources/app.asar` |
| `node scripts/patch-desktop-asar.mjs --help` | 什么都不改，只打印上面的用法 |

有且只有一个文件变化：编译产物 `lib/main.js` 里的
`satisfies(dependency.version, range)` 变成
`satisfies(dependency.version, range, { includePrerelease: true })`。asar 头部里
按文件记录的完整性校验（integrity）只为这一个文件重算，因此归档在结构上仍然是
`electron-builder` 写出来的样子，应用分辨不出差别。

补丁是幂等的 —— 已经打过的归档会打印 `already patched; nothing to do` 并退出 ——
旁边的 `.bak` 只在第一次运行时写入，所以反复执行也不会覆盖原始文件。但每次重装
或升级之后都必须重打：`app.asar` 会被重新生成，补丁不会。

这一招仅限 Windows，且只适用于本项目构建的未签名产物。重写已签名的 macOS bundle
里的 `app.asar` 会让它的签名和公证失效。

## 配置

### 环境变量

provider 在每次启动时从启动环境里读连接信息，所以一份已安装的包可以服务所有
机器。这里的每个值都只是引导默认值：没设就是没有，设置卡片在你于其中填写之前
不会把它写进存储。

| 变量 | 含义 |
|---|---|
| `DSH_SYNC_BUCKET` | 存放文档的 bucket。不设则 provider 以纯本地模式启动；在这里设，或在设置卡片里设。 |
| `DSH_SYNC_ENDPOINT` | 兼容 S3 的 endpoint（MinIO、Ceph、COS）；AWS 可省略。 |
| `DSH_SYNC_REGION` | 签名用 region；默认 `us-east-1`。 |
| `DSH_SYNC_PREFIX` | Key 前缀；默认 `dsh-sync`。 |
| `DSH_SYNC_FORCE_PATH_STYLE` | 只有要求 path-style 寻址的服务（常见于 MinIO）才设为 `true`。默认使用 virtual-hosted 风格，TOS、OSS、AWS 都要求这种风格。 |
| `DSH_SYNC_POLL_MS` | 轮询间隔，毫秒；默认 `30000`。 |
| `DSH_SYNC_ACCESS_KEY_ID` / `DSH_SYNC_SECRET_ACCESS_KEY` | bucket 的静态凭证；不设则回退到设置卡片保存的那一对，再回退到 SDK 自己的链条（`AWS_ACCESS_KEY_ID`、profile、实例角色）。 |

卡片保存的那一对优先级高于环境变量，环境变量又高于 SDK 链条。三者之中只有卡片
里的那一对永远不会离开本机。

### 按 profile 覆盖

如果不想让机器专有的值进入环境变量，可以改为覆盖该 profile 自己的
`$DSH_HOME/profiles/<name>/cordis.patch.yml` 里那两行：

```yaml
- id: oss-settings
  config:
    bucket: my-dsh
    endpoint: https://oss-cn-shanghai.aliyuncs.com
- id: oss-credentials
  config:
    bucket: my-dsh
    endpoint: https://oss-cn-shanghai.aliyuncs.com
```

bucket 必须在 `PutObject` 上支持 `If-Match` 和 `If-None-Match`。强烈建议开启
Governance 模式的 bucket 版本控制：正是它把一次误覆盖变成一次可恢复的版本。

### 设置页卡片

设置页通过一个注册好的设置命名空间（`oss-sync`）来读写同步，因为接缝本来就会把
实时值带到浏览器：命名空间在每次 commit 时重新解析，客户端的镜像会把它转发出去。
不需要第二条通道。

| 字段 | 含义 |
|---|---|
| `bucket`、`endpoint`、`region`、`forcePathStyle`、`accessKeyIdEnv`、`secretAccessKeyEnv` | 连接参数；条目配置是最底层，所以没填的字段保持 `cordis.yml` 和环境变量给的值。不带 URL scheme 的 endpoint 会被规范化为 `https://`。TOS/OSS/AWS 用 `forcePathStyle: false`；只有兼容 MinIO 的服务要求时才打开。 |
| `accessKeyId`、`secretAccessKey` | bucket 自己的 OSS/TOS/S3 凭证 —— **不是**模型 provider 的 API Key。在这里输入，只存在本机（`$DSH_HOME/.dsh-oss-sync/connection.yaml`，权限 0600），永不写入 bucket。两个都清空则删掉这个本地文件。 |
| `prefix` | Key 前缀。修改它会把两份文档一起搬走，并用本机持有的文档去初始化新位置。 |
| `pollMs` | 轮询间隔；立即生效。 |
| `status` | 运行期信息，只读。按 provider（`settings`、`credentials`）给出：revision、writer、提交时间、device id、object key、最近一次读/写、最近一次错误。 |
| `request` | 写入任意新值即可立刻在两个 provider 上执行一次同步，不必等轮询间隔。 |

`status`、`request` 和本机凭证在到达 bucket 之前都会被剥掉，所以存下来的文档只
包含配置。修改连接参数会重建客户端并立刻读取新位置；当新位置不可达或为空时，
`$DSH_HOME/.dsh-oss-sync/` 下的缓存和旁边的 `connection.yaml` 正是让这件事安全的
东西。

## bucket 里存了什么

两个对象，`<prefix>/settings.yaml` 和 `<prefix>/credentials.yaml`，都是可读 YAML，
方便 diff 和手改：

```yaml
v: 1
rev: 12
writer: 6f1c1a1e-…
updatedAt: 2026-09-14T09:12:03.114Z
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

`credentials.yaml` 里放 `refs`（引用名到密钥值）和 `records`（按插件划分的凭证
记录，包含授权 grant）。

每台机器自己的状态留在 `$DSH_HOME/.dsh-oss-sync/` 下：一个稳定的 `device-id`、
一份最近读到文档的缓存，以及一次性的 legacy 导入标记。原始的 `settings.yaml` 和
`.credentials.yaml` 原样保留作为恢复副本；那些标记则防止一个通过同步 provider 被
刻意删掉的 key 在下次重启时复活。

## 并发与传播

每次写入都带上它所读那个 revision 的 ETag。被拒绝的写入
（`412 Precondition Failed`）会重新读取更新的文档，把本地改动叠加到它上面重试 ——
于是：

- 两台机器改**不同**命名空间会合并；后写的那台看到先写的那台的 revision 并保留它。
- 两台机器改**同一个**命名空间：该命名空间整体以后写者为准，这与基于文件的
  provider 对单份文档采用的规则相同。
- `modifyRecord` 在进程内把读取和写入放在同一个互斥区里，在跨进程时按 ETag 重试，
  所以两台机器同时刷新 token 不会丢掉其中一个。

读取从不等待存储：解析由本进程最近读过、写过或轮询到的文档直接服务。因此
`DSH_SYNC_POLL_MS` 就是机器之间的传播窗口。

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

access key 本身必须来自机器的环境，绝不能来自同步文档：它是引导凭证。

## 已知限制

- **设置页卡片尚未在屏幕上验证过。** 浏览器那半边存在、能被发现、能被下发、求值
  也不报错，它背后的宿主那半边有 smoke 测试覆盖 —— 但还没有一次运行确认过卡片的
  实际渲染布局，所以那个布局只能算未证实。
- **没有 `.env` 回退。** `dsh-credentials-local` 会依次叠加进程环境、存储文件、
  `<cwd>/.env` 和 `$DSH_HOME/.env`。本 provider 只叠加环境和 bucket。以前放在
  `.env` 里的值请放进存储，或者继续导出它们。
- **没有“打开配置文件”入口。** 设置页只在 provider 指明一个本地文档时才提供那个
  按钮；对象存储没有本地文档，所以按钮会消失。编辑发生在页面里或 bucket 里。
- **删除会传播，冲突不会。** 被另一台机器移除的命名空间会在下一次轮询时从本机
  消失。同一个命名空间上同时发生的冲突编辑，按该命名空间的后写者胜出来解决。
- **离线写入会失败。** 读取会回退到缓存；bucket 不可达时写入会被拒绝，接缝保留
  此前的值。没有离线队列。
- **一对文档一个 bucket。** 设置和凭证共用同一个前缀，因此也共用同一个 bucket；
  想让两个 provider 指向不同 bucket，只能去改插入的那两行。

## 工作原理

`dsh-base` 组合里的两行被替换掉：

| 基础行 | 基础包 | 替换为 |
|---|---|---|
| `settings` | `@deepseek-ai/dsh-settings-file`（`$DSH_HOME/settings.yaml`） | `dsh-oss-sync/settings` |
| `credentials` | `@deepseek-ai/dsh-credentials-local`（`$DSH_HOME/.credentials.yaml`） | `dsh-oss-sync/credentials` |

loader patch 不能给一行改名 —— 它的 `name` 是 patch 必须匹配上的断言 —— 所以
`cordis.patch.yml` 先把两个基础行关掉，再用它们各自的 id（`oss-settings`、
`oss-credentials`）插入这两行。

harness 自身的加载规则有两个后果塑造了本包的结构，这也是它长成现在这样的原因：

- 包根（`lib/index.js`）是 settings provider，而不是某个子路径入口，因为浏览器
  模块扫描是**按裸包 specifier** 命名的 Loader 行去解析一个包的 `dsh.client`
  产物的 —— 一行如果叫 `dsh-oss-sync/settings`，那它永远不是 client 行。
- `lib/client.js` 不是 ES module。combo 路由会把多个包拼成一个脚本，其中任何一个
  在顶层写 `import`，在那个位置就是非法的，会把整个脚本带崩。该产物是一个惰性的
  CommonJS factory，外面包着 `window.__ModuleLoader__.load({ id, factory })`。

## 开发

```sh
pnpm install
pnpm build          # tsc → lib/，再 esbuild → lib/client.js
pnpm smoke          # 假 S3 的端到端检查
pnpm test:patch     # asar 补丁工具，跑在内存里合成的归档上
```

`tsconfig.json` 通过 `paths` 把 `@deepseek-ai/*` 这些 peer 包解析到同级
`deepseek-harness` checkout 的已构建声明文件上，所以必须先构建那个 checkout，
这个才能编译。

`lib/` 就是 loader 实际加载的东西：每次改完源码都要重新构建，然后重启 profile。
当从源码运行 harness 时（在 checkout 里执行 `pnpm dsh`，它通过 tsx 加载），用
`--patch` 直接叠加 `src/settings.ts` 会比重新构建更快。

发布流程和其余维护者向的细节见
[CONTRIBUTING.md](https://github.com/jackchun53/dsh-oss-sync/blob/main/CONTRIBUTING.md)。

## License

MIT —— 见 [LICENSE](https://github.com/jackchun53/dsh-oss-sync/blob/main/LICENSE)。
