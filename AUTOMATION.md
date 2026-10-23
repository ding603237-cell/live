# 直播源自动更新机制

## 现状

| 项目 | 状态 |
|---|---|
| 订阅地址 | `https://ding603237-cell.github.io/live/tv/m3u/live.m3u` |
| 当前源数 | 560 条 / 268 频道 / 28 分组 |
| 更新脚本 | `ding603237-cell/live-scheduler` → `update_live_sources.py` |
| GitHub cron | **不可用**（见下方实测结论） |
| 可靠触发 | Cloudflare Worker cron（需手动部署一次） |

## 为什么不能直接用 GitHub cron

GitHub Actions 的 `schedule` 事件在本账号下实测完全不触发：

| 测试 | 结果 |
|---|---|
| fork 仓库 `live`（cron 设 2 分钟后） | 等待 7 分钟，零条 `schedule` 记录 |
| 新建私有仓库（cron 设 3 分钟后） | 等待 7 分钟，零条 `schedule` 记录 |
| 非 fork 私有仓库 `live-scheduler`（cron 设 1 分钟后） | 等待 12 分钟，零条 `schedule` 记录 |
| 对照组：上游 `fanmingming/live` | 15 条 `schedule` 记录，正常触发 |

排查过程与已排除项：

- ✅ Actions 权限 `enabled: true`、`allowed_actions: all`
- ✅ 三个 workflow 状态均为 `active`
- ✅ 仓库 `fork: false`（`live-scheduler` 确为独立仓库）
- ✅ 分支无保护规则
- ✅ 配额充足（本月仅用 64 分钟 / 2000 分钟）
- ❌ 结论：账号侧调度器未启用，属于 GitHub 平台侧行为，非配置问题

GitHub 官方文档也说明：定时任务为 best-effort，可能延迟数小时甚至被丢弃；fork 中默认不运行。

## 方案 A：Cloudflare Worker 触发（推荐，已备好代码）

Cloudflare 的 cron 是硬保证，不受 GitHub 调度限制影响。

`source-trigger.js` 已在两个仓库中就位：
- `ding603237-cell/live/worker/source-trigger.js`
- `ding603237-cell/live-scheduler/source-trigger.js`

### 部署步骤

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com) → 登录
2. 左侧 **Workers & Pages** → **Create** → **Start with Hello World!** → 选 **Hello World example** → **Deploy**
3. 进入 Worker 编辑页，把 `source-trigger.js` 的全部内容粘贴替换左侧代码
4. 点 **Deploy**
5. **Settings** → **Triggers** → **Cron Triggers** → **Add Cron Trigger**
   - Cron: `0 */6 * * *`（每 6 小时，UTC）
6. **Settings** → **Variables and Secrets** → **Add** → 类型选 **Secret**
   - `GITHUB_TOKEN` = 你的 GitHub PAT（需 `repo` 权限）
   - 可选：`SCHEDULER_REPO` = `ding603237-cell/live-scheduler`
   - 可选：`SCHEDULER_WORKFLOW` = `scheduled-update.yml`
   - 可选：`MIN_INTERVAL_HOURS` = `6`
7. 保存并部署

### 验证

在浏览器打开 Worker 的默认域名（形如 `xxx.workers.dev`）：

```json
{ "ok": true, "skipped": true, "reason": "距上次更新 0.3 小时，未达 6 小时阈值" }
```

说明链路通了。等待 6 小时后应返回 `{"ok": true, "status": 204, "detail": "dispatched"}`。

> 想立刻强制跑一次：把 `MIN_INTERVAL_HOURS` secret 临时改为 `0`，访问 Worker 域名，再改回去。

## 方案 B：手动触发（随时可用）

```bash
curl -X POST \
  -H "Authorization: Bearer <你的PAT>" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/ding603237-cell/live-scheduler/actions/workflows/scheduled-update.yml/dispatches \
  -d '{"ref":"main"}'
```

或在网页操作：
`https://github.com/ding603237-cell/live-scheduler/actions/workflows/scheduled-update.yml` → **Run workflow**

## 方案 C：Push 链自维持（已内置，兜底用）

`live` 仓库的 `Trigger Source Refresh` workflow 监听 `tv/m3u/**` 与 `e.xml` 变更，
满足 6 小时间隔时会自动 dispatch 下一轮更新。

> 注意：此链路需要先有一次 push 才能启动，单独使用时不能替代方案 A。

## 更新脚本做了什么

`update_live_sources.py` 六步：

1. 拉取上游源库（Guovin/iptv-api，1619 条）
2. 读取目标仓库现有订阅
3. **增量探测**：新增源做完整校验（预算 `NEW_BUDGET=450`），已有源抽样复检（`SAMPLE_MAX=200`），
   失效比例超 30% 时自动升级为全量复检
4. 重建 m3u：`tvg-logo` 统一指向自有站点 `/tv/`，分组按央视 → 卫视 → 地方台排序
5. 更新 EPG（`e.xml`）
6. 刷新 `heartbeat.json` 时间戳（供时间闸门判断）

### 性能参数

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PROBE_TIMEOUT` | 5 | 单源探测超时（秒） |
| `PROBE_WORKERS` | 64 | 探测并发数 |
| `NEW_BUDGET` | 450 | 每轮最多探测多少条新增源 |
| `SAMPLE_MAX` | 200 | 每轮抽样复检多少条已有源 |
| `SOURCE_M3U` | Guovin/iptv-api | 上游源库地址 |
| `EPG_SOURCE` | suzukua/epg | EPG 节目单地址 |

> 慢源是耗时主因。`urlopen` 的 timeout 不覆盖 DNS 解析阶段，脚本额外用
> `socket.setdefaulttimeout` 做硬超时兜底，否则单批卡顿会拖垮整体。

## 已知限制

- 直播源可用性本身在波动。实测同一批源在不同时间点存活率差异明显
  （某次 1619 条中 597 条存活，另一次同批新增源仅 7 条通过），所以定期复检是必要的。
- 部分地方市县台在 tv/ 图标库中没有对应图标，logo 仍指向第三方站点。
- 私有仓库 `live-scheduler` 的 cron 保留在 workflow 中。当前不生效，
  但若将来平台侧恢复调度，它可作为方案 A 的备份。
