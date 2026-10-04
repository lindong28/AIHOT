# 双仓恢复 Wechat2RSS 部署

用户于 2026-10-04 明确：固定镜像可重下载算自包含；必须持久保存的私有部署信息经 `~/.claude/.env`（ai-agent-config 的加密 `env`）维护；AIHOT 与 ai-agent-config 两个仓应包含新机器部署所需信息，动态可重新取得的数据无需入仓。

固定许可证、RSS token、RSS_SECRET 与 RSS_PROXY_SECRET 归中央 env，AIHOT 生成最小私有运行副本。公开镜像、端口、加密开关、订阅身份与操作流程归 AIHOT。外部探针保留 Mac mini、20 分钟频率与原告警身份；专用 SSH key 仅允许强制健康命令，并禁止转发和 PTY，私钥、目标与主机信任信息归中央 env；不复制机器通用私钥。im-notify 安装和通知凭据已由 ai-agent-config 维护。

订阅恢复先完整读取官方 `/list`，仅对缺项调用 `/add/:id`，保留既有暂停状态并核对 feedId。RSS_SECRET 与 RSS_ENC_FEED_ID 共同决定稳定地址。用户进一步明确：中央 env 只保存环境变量、凭据等元数据，历史正文由数据库维护。Wechat2RSS SQLite 与 AIHOT PostgreSQL 保持原有数据；空库恢复订阅与后续采集不等于恢复全部历史文章。仓库访问和 git-crypt 解锁、微信扫码/许可激活为明确前提。

未选择把整库作为固定配置塞入 env（混入不断更新的历史和登录缓存）、继续依赖机器手工配置（不满足双仓目标）或把探针改到同一主机（改变现役外部观察拓扑）。旧 RSS 历史不可全部重抓，不能以“缓存”名称推导其可丢弃。

独立 decision-review `wechat_decision_review` 七项成立，放行固定配置、生成器、订阅恢复和受限探针的实现。已消解公开加密开关、完整分页与历史恢复表述三项增量问题。用户授权把中央 env 既有三项百炼/SocialData 凭据修改一并提交，已保持其值并纳入 ai-agent-config `3667d810`；原有其他 WIP 保留。env 的 Git blob 已核实为 git-crypt 密文。没有删除现役数据或发送测试通知。

## 实现与验证

`configure.ts` 安全读取中央 env 并生成最小运行副本；`restore-subscriptions.ts` 核对完整分页及 feedId，仅补缺项；`probe-install.ts` 生成受限 SSH 身份和 cron。探针 runner 保留运行时显式 `IM_NOTIFY_BIN` 覆盖，允许现场使用实体通知替身。

独立代码审查 `wechat_code_review` 放行，没有阻塞缺陷或基线独立 finding。已通过类型检查、隔离 PostgreSQL 库的后端测试（该次 291 个）、Web 构建和 Web 测试（11 个）；测试面为仓库现有 fixtures，不代表生产运行或冷部署许可激活。最终微信定向测试增加至 7 个，覆盖健康/错误/传输状态、通知替身、生命周期顺序、5 项私有配置、3 个订阅的分页/补项/幂等/feedId 漂移、受限 SSH 配置与 cron 幂等、CLI 符号链接与 stdin 导入，以及两种源 env 名的 SQLite 快照；未连接真实通知渠道。快照 fixture 需要 Python 3.11+，本机默认 Xcode Python 3.9 不支持 `serialize()`；使用 Homebrew Python 3.14，腾讯使用 Python 3.12。

本机在不含 `node_modules` 的临时目录验证了三个部署 fixture；最终四个 portable fixture 又在腾讯独立准备目录通过 Node 24.21.0/Python 3.12 执行，部署工具不依赖 AIHOT 的 npm 安装。中央 env 生成的 5 项真实私有输入逐项相等，未打印值。腾讯已加载中央配置并重建原容器，继续挂载原数据库；22 个账号、22 个预期 feedId 核对一致，新增 0、暂停 0。实际读取 22 份认证 RSS 均成功，共返回 931 个条目；这是 RSS 窗口条目数，不是本轮新入库文章数。公开站点的仓库 smoke 脚本也成功。

Mac mini 专用公钥已在腾讯登记强制健康命令；从 `env -i` 且禁用 SSH config/agent 的真实入口返回 1 个可用账号、无风控，提交其他 SSH 命令仍只返回健康结果。cron 已切换，逐字核对只替换本探针一行，健康状态保持。代码运行副本来自 AIHOT，最小私有输入副本来自中央 env，im-notify 继续使用 ai-agent-config 的原中央配置。

现场还发现 `current` 符号链接会使三个 CLI 的入口判断静默跳过，已按真实路径修复并复验；reviewer 检出的 stdin 导入回归也由存在性条件修复，三个模块的实际 stdin 导入已加入测试。快照脚本补充可指定远端 Python 和 `service.env` 的入口，原 Mac 默认参数保留。

仍未执行全新数据库的许可激活、扫码和订阅冷恢复；这些涉及可过期登录和许可证验证，不能用现役热部署结果代替。未测试真实故障通知投递或宿主机重启恢复；本轮保留现役告警身份和频率。两仓提交目前仅在本地，尚未 push。
