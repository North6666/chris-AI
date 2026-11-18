// Netlify 转发函数：前端不填 Key 时走这里。
// 真实 Key 只存在服务器环境变量 MY_KEY / VISION_KEY 里，前端代码和浏览器都拿不到。
//
// 额度策略：
//   - 文字模型（deepseek-chat） 每天最多 MAX_PER_DAY 次（默认 200）
//   - 视觉模型（glm-4v-flash） 每天最多 MAX_VISION_PER_DAY 次（默认 10）
//   两者独立计数、独立额度，视觉明显更贵所以更严格。
// 两个额度都在真正发 HTTP 请求前 bump，确保"成本发生点"拦截，不进入等待态。
//
// 来源校验：ALLOW_ORIGIN 匹配 referer / origin，挡住脚本直接调。
// 持久化：优先 Netlify Blobs；拿不到降级到进程内存（冷启动会重置）。

// ========== 一、环境变量（全部在 Netlify 后台配置，前端看不到） ==========
// 文字模型（DeepSeek）
const TEXT_BASE  = process.env.PROXY_BASE  || 'https://api.deepseek.com';
const TEXT_MODEL = process.env.PROXY_MODEL || 'deepseek-chat';
const MAX_PER_DAY = parseInt(process.env.MAX_PER_DAY || '200', 10);

// 视觉模型（智谱 glm-4v-flash 等）
// 如果 VISION_KEY 没配，视觉请求会直接 500 拒绝，不会偷偷用文字模型。
const VISION_KEY = process.env.VISION_KEY || '';
const VISION_BASE  = process.env.VISION_BASE  || 'https://open.bigmodel.cn/api/paas/v4';
const VISION_MODEL = process.env.VISION_MODEL || 'glm-4v-flash';
const MAX_VISION_PER_DAY = parseInt(process.env.MAX_VISION_PER_DAY || '10', 10);

const ALLOW_ORIGIN = (process.env.ALLOW_ORIGIN || '').trim();

// ========== 二、额度计数器（按用途分 store key，自动跨天重置） ==========
// store key 命名规则： chris-rate-text-YYYY-MM-DD / chris-rate-vis-YYYY-MM-DD
// 同一天内递增，换了新日期 key 自动归零。
let store = null;
try {
  store = require('@netlify/blobs').getStore({ name: 'chris-rate', consistency: 'strong' });
} catch (e) {
  store = null;
}
// 内存兜底：冷启动后 Blobs 不可用时用这个，同日有效
let mem = {};

async function bump(day, kind) {
  const key = kind + '_' + day;   // 例如 'text_2026-11-18' 或 'vis_2026-11-18'
  if (store) {
    try {
      const cur = parseInt((await store.get(key)) || '0', 10);
      const next = cur + 1;
      await store.set(key, String(next));
      return next;
    } catch (e) { /* Blobs 不可用时静默降级 */ }
  }
  if (mem.day !== day) { mem = { day }; }
  mem[kind] = (mem[kind] || 0) + 1;
  return mem[kind];
}

// 判断一条 payload 里有没有图片
function hasImageInPayload(messages) {
  if (!Array.isArray(messages)) return false;
  for (const m of messages) {
    const c = m.content;
    if (Array.isArray(c)) {
      for (const piece of c) {
        if (piece && piece.type === 'image_url') return true;
      }
    }
  }
  return false;
}

// ========== 三、主入口 ==========
exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin': '*' };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };
  }

  // 来源检查：只接受来自自己站点的请求
  if (ALLOW_ORIGIN) {
    const src = event.headers.referer || event.headers.origin || '';
    if (!src.includes(ALLOW_ORIGIN)) {
      return { statusCode: 403, headers: cors, body: '来源不被允许' };
    }
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: cors, body: '请求体不是合法 JSON' };
  }

  const day = new Date().toISOString().slice(0, 10);
  const isVision = hasImageInPayload(payload.messages);

  // 关键：先决定"用哪种模型 + 用哪个额度"，再在真正发 HTTP 之前 bump
  let baseUrl, model, apiKey, limit, label;
  if (isVision) {
    if (!VISION_KEY) {
      return { statusCode: 500, headers: cors, body: '服务器没配置视觉 Key（VISION_KEY）' };
    }
    baseUrl = VISION_BASE;
    model   = VISION_MODEL;
    apiKey  = VISION_KEY;
    limit   = MAX_VISION_PER_DAY;
    label   = '视觉';
  } else {
    apiKey  = process.env.MY_KEY;
    if (!apiKey) {
      return { statusCode: 500, headers: cors, body: '服务器没配置文字 Key（MY_KEY）' };
    }
    baseUrl = TEXT_BASE;
    model   = TEXT_MODEL;
    limit   = MAX_PER_DAY;
    label   = '文字';
  }

  // ===== 成本发生点：在这里 bump，确保额度扣在真正要花 API 钱的那一刻 =====
  const used = await bump(day, isVision ? 'vis' : 'text');
  if (used > limit) {
    return {
      statusCode: 429,
      headers: cors,
      body: label + '额度已用完（上限 ' + limit + ' 次/天）'
    };
  }

  // 强制服务端指定的模型，前端传什么都不生效
  payload.model = model;
  payload.stream = false;

  try {
    const res = await fetch(baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    return {
      statusCode: res.status,
      headers: Object.assign({ 'Content-Type': 'application/json' }, cors),
      body: text
    };
  } catch (e) {
    return { statusCode: 502, headers: cors, body: '上游请求失败：' + e.message };
  }
};
