/**
 * Cloudflare Worker — 直播源定时更新触发器
 *
 * 作用：绕过 GitHub Actions 的 cron 调度（本账号实测不触发），
 *       用 Cloudflare Cron Trigger 定时调用 GitHub 的 workflow_dispatch API。
 *
 * 部署步骤：
 *   1. Cloudflare Dashboard → Workers & Pages → Create → Worker
 *   2. 粘贴本文件全部内容 → Deploy
 *   3. Settings → Triggers → Cron Triggers → Add Cron Trigger
 *      填入：0 */6 * * *   （每 6 小时，UTC）
 *   4. Settings → Variables and Secrets → 添加 Secret：
 *      GITHUB_TOKEN = 你的 GitHub PAT（需 repo 权限）
 *      可选 Secret：
 *        SCHEDULER_REPO     = ding603237-cell/live-scheduler
 *        SCHEDULER_WORKFLOW = scheduled-update.yml
 *        MIN_INTERVAL_HOURS = 6
 *
 * 副作用控制：每次触发前会读取目标仓库的 heartbeat.json，
 *             若距上次更新不足 MIN_INTERVAL_HOURS 则跳过，避免重复触发。
 *
 * 可选：绑定自定义域名后，GET 请求该域名即可手动触发一次。
 */

const GITHUB_API = 'https://api.github.com';
const HEARTBEAT_REPO = 'ding603237-cell/live';

export default {
  async scheduled(event, env, ctx) {
    const skip = await shouldSkip(env);
    if (skip) {
      console.log(`跳过：${skip}`);
      return;
    }
    const res = await trigger(env);
    console.log(`触发结果: ${res.status} ${res.body}`);
  },

  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    const skip = await shouldSkip(env);
    if (skip) {
      return new Response(
        JSON.stringify({ ok: true, skipped: true, reason: skip }, null, 2),
        { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
      );
    }
    const res = await trigger(env);
    return new Response(
      JSON.stringify({ ok: res.ok, status: res.status, detail: res.body }, null, 2),
      {
        status: res.ok ? 200 : 502,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }
    );
  },
};

async function shouldSkip(env) {
  const minHours = Number(env.MIN_INTERVAL_HOURS) || 6;
  const token = env.GITHUB_TOKEN;
  if (!token) return null; // 无 token 时不在这里报错，交给 trigger 处理

  try {
    const resp = await fetch(
      `${GITHUB_API}/repos/${HEARTBEAT_REPO}/contents/heartbeat.json`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'live-source-trigger',
        },
      }
    );
    if (!resp.ok) return null;

    const data = await resp.json();
    const content = atob(data.content.replace(/\n/g, ''));
    const last = Date.parse(JSON.parse(content).last_run);
    if (!last || Number.isNaN(last)) return null;

    const hours = (Date.now() - last) / 3600000;
    if (hours < minHours) {
      return `距上次更新 ${hours.toFixed(1)} 小时，未达 ${minHours} 小时阈值`;
    }
    return null;
  } catch {
    return null;
  }
}

async function trigger(env) {
  const token = env.GITHUB_TOKEN;
  const repo = env.SCHEDULER_REPO || 'ding603237-cell/live-scheduler';
  const workflow = env.SCHEDULER_WORKFLOW || 'scheduled-update.yml';

  if (!token) {
    return { ok: false, status: 500, body: '缺少 GITHUB_TOKEN secret' };
  }

  try {
    const resp = await fetch(
      `${GITHUB_API}/repos/${repo}/actions/workflows/${workflow}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'live-source-trigger',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    );

    const body = resp.status === 204 ? 'dispatched' : await resp.text();
    return { ok: resp.status === 204, status: resp.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: String(err) };
  }
}
