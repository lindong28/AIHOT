# 部署

## 用 Docker（推荐）

需要一台装了 Docker（带 Compose）的机器。云服务器建议至少 2 核、4 GB 内存，构建镜像时要用到。

```bash
git clone https://github.com/KKKKhazix/AIHOT.git myhot
cd myhot
node scripts/init-env.ts --llm-key <你的模型 API Key>
docker compose up -d --build
```

`init-env.ts` 会生成 `.env`，填好随机密钥和管理员密码，并把密码打印一次。机器上没有 Node 的话，把 `.env.example` 复制成 `.env`，自己填 `ADMIN_PASSWORD`（至少 12 位）、`SESSION_SECRET`、`IMG_PROXY_SIGN_SECRET`、`POSTGRES_PASSWORD`（各用 `openssl rand -hex 32` 生成）和 `LLM_API_KEY`。

启动后打开 `http://服务器地址:3000`，后台在 `/admin`，用管理员密码登录。第一次启动会导入示范信源，一两分钟后开始出现内容；第一次导入的一百多条资料大约半小时处理完（每条都要预筛、评分，入选的还要写标题摘要）。

`docker compose` 会起五个容器：`db`（PostgreSQL 17）、`setup`（每次启动先跑数据库迁移和种子数据，然后退出）、`api`、`worker`（抓取、模型处理、定时任务）、`web`（网页）。

### 在中国大陆的服务器上

- 构建时 npm 走国内镜像：`docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com`，然后 `docker compose up -d`。
- 拉取 Docker 镜像慢，先给 Docker 配置镜像加速。
- 海外信源抓不到时，在 `.env` 里设置 `EGRESS_PROXY_URL`：抓信源、图片和模型榜数据时走这个代理，调用模型接口不走。
- 对外提供网站服务需要先完成 ICP 备案，备案号填在 `industry/site.ts` 的 `icp`。

### 配域名和 HTTPS

先把域名解析到服务器，然后在 `.env` 里设置：

```bash
SITE_URL=https://example.com
SITE_DOMAIN=example.com
PORT=127.0.0.1:3000        # 3000 端口只给本机的 Caddy 用，不直接对外
TRUST_PROXY=true           # 访客地址从 Caddy 转来的请求头里读
```

再用带 HTTPS 的方式启动，Caddy 会自动申请和续期证书：

```bash
docker compose --profile https up -d --build
```

已经有 Nginx 的话，不用 Caddy，把站点反向代理到 `http://127.0.0.1:3000`，带上 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`，并在 `.env` 里设 `TRUST_PROXY=true`。`SITE_URL` 一定要写成读者实际访问的地址：生成的链接、RSS、分享图和 MCP 都用它。

### 更新

```bash
git pull
docker compose up -d --build
```

数据库迁移只做向后兼容的增量，更新时自动执行。

### 备份

在 `.env` 里配置 `DB_BACKUP_STORE_*`（任何 S3 兼容的对象存储），每天 04:10 自动备份到那里。也可以手动导出：

```bash
docker compose exec -T db pg_dump -U aihot aihot | gzip > myhot-$(date +%F).sql.gz
```

数据都在三个 Docker 卷里：`db`（数据库）、`data`（上传的图片、图片缓存、本地备份）、`caddy`（证书）。`docker compose down` 不会删除它们；`docker compose down -v` 会。

### 看日志

```bash
docker compose logs -f --tail 100 api worker web
```

后台的“运行”页能看到每个定时任务最近的结果，“信源”页能看到每个信源的抓取状况。

## 花多少钱

### 使用个人 llm-gateway

在 Gateway 中登记本站的稳定项目身份及个人资源范围，确认精确模型可用后，配置 `LLM_GATEWAY_URL`、`LLM_GATEWAY_PROJECT`、`LLM_MODEL`。`LLM_GATEWAY_MODE` 可用 `stream`（默认）或 `batch`；它表示 Gateway 路由偏好，本站仍接收完整 JSON 响应，不表示一定使用某个服务层级。`LLM_EXTRA_JSON` 等参数仍需与选定模型匹配。上游密钥只保存在 Gateway，本站不需要 `LLM_API_KEY`。

设置 Gateway 后，文本与向量都经它转发，不会退回直接调用供应商。向量可用 `EMBEDDINGS_ENABLED=false` 关闭；启用时必须显式指定 `EMBEDDING_MODEL`，维数可用 `EMBEDDING_DIMS` 指定。容器内的 `127.0.0.1` 指向容器自身，应填写 worker 实际能访问的 Gateway 地址。当前本机部署进度与尚待裁决的资源见 [切换清单](migration.md)。

本站使用 Gateway 仓维护的 `@lindong/llm-gateway-client`。启用新版消费者前，先升级 Gateway 并确认 `/api/capabilities` 宣告 retry policy v1，再执行数据库迁移（含 `0043_receipt_output_validation.sql`）与应用更新。旧服务端不支持时，客户端在模型派发前失败；不得以此退回直连供应商。

实例参数来自 `LLM_GATEWAY_MAX_ATTEMPTS=3`、`LLM_GATEWAY_ATTEMPT_TIMEOUT_MS=30000`、`LLM_GATEWAY_INITIAL_BACKOFF_MS=3000`，分别表示包含首次的 provider 次数、每次独立的时间上限与第一次退避。Gateway 执行退避和 provider 切换，本站不额外重发 fetch。`LLM_JSON_MAX_ATTEMPTS=3` 控制应用 JSON/schema 校验生成次数，失败后立即重新生成。配置由客户端实例读取；同一实例内不按每次请求修改，修改生产环境变量后需要重启 worker 才生效。

本站在每次生成前把新的 UUID 写入 `receipts.request_id` 与 `receipt_attempts.request_id`，再发送 `X-LLM-Request-ID` 并核对响应 identity（压缩响应使用 identity headers）。每次响应与 usage 先保存到 attempt，再校验 JSON；不合格记录 `output_validation_error`，同一业务回执内有界重试。预算在数据库认领事务中核对，worker 重启不会获得全新三次。成功保存业务结果后主回执变为 `completed`，旧失败 attempt 和未知费用继续保留。默认最坏为三次生成、每次三个 provider attempts，共九次，均可能收费；本站预算按生成回执计数，provider 明细在 Gateway ledger。

无法确认已收到结果的超时、连接中断、HTTP 错误，以及身份不匹配，仍保持 `unknown`，不自动重发。例外是能证明零 provider 派发的拒绝，以及已收到且 identity 匹配的指定输出校验失败；普通 502 不等于 JSON 失败。`fetch failed` 保留安全原因码，原因不明为 `UNKNOWN`，不记录可能含凭据的底层消息。Gateway 的 `ledger_unavailable` 503 不证明上游没有执行。按 UUID 核账后再使用[受控恢复入口](operations/receipt-recovery.md)，不能因等待已久就解除 unknown。

```sql
SELECT id, status, request_id, usage, error
FROM receipts WHERE id = '<后台显示的回执 ID>';
SELECT attempt, status, request_id, usage, error, output_validation_error
FROM receipt_attempts WHERE receipt_id = '<后台显示的回执 ID>'
ORDER BY attempt;
```

未取得金额时费用保持未知，不把 token 数当作实际账单。默认一次 Gateway HTTP 等待窗口为 160 秒，含三次 30 秒执行、两次候选等待与传输余量；窗口到期仍须查账。配置所得总窗口须低于本站回执过期阈值，具体参数校验以客户端为准。未配置 Gateway 时，原有供应商直连保留其网络行为，应用输出校验仍使用配置的生成次数上限。

- **模型**：每条新资料至少预筛一次；可能入选的再评分两次，入选的还要写标题摘要、打标签、归组，另外还有日报和事件综述。我们用示范信源在本地试跑，第一次导入的 152 条资料一共用了大约 930 次模型调用。之后每天用多少，取决于你的信源每天更新多少条。后台“模型与评测”页能看到每一步的调用次数和输入输出 token 数。
- **付费采集**（X、公众号、Jina）：按请求计费，默认不启用，填了 key 才会用。
- 所有付费服务都有每分钟、每小时、每天的调用上限（后台“设置 → 预算”），超过就暂停，不会一夜之间刷爆账单。填 0 表示立即停用这个服务。

## 不用 Docker

需要 Node.js 24.11 以上和 PostgreSQL 16 或 17。

```bash
npm ci
node scripts/init-env.ts --llm-key <你的模型 API Key>
createdb myhot
```

在 `.env` 里加上：

```bash
DATABASE_URL=postgres://你的用户名@127.0.0.1:5432/myhot
API_BASE_URL=http://127.0.0.1:3001
```

然后：

```bash
node --env-file=.env scripts/migrate.ts
node --env-file=.env scripts/seed.ts
npm run build -w @aihot/web

node --env-file=.env apps/api/src/main.ts          # 接口，3001 端口
node --env-file=.env apps/worker/src/main.ts       # 后台任务
cd apps/web && NODE_ENV=production node --env-file=../../.env server.ts   # 网页，3000 端口
```

三个进程要一直运行，生产环境用 systemd 或 pm2 守护。

开发时用带热更新的方式：`npm run dev:api`、`npm run dev:worker`、`npm run dev:web`。开发时想免登录进后台，在 `.env` 里设 `DEV_AUTH_ROLE=admin`（生产环境会拒绝启动）。
