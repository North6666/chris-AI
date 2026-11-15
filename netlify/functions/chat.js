// Netlify 转发函数：前端不填 Key 时走这里。
// 真实 Key 只存在服务器环境变量 MY_KEY 里，前端代码和浏览器都拿不到。

const DEFAULT_BASE  = process.env.PROXY_BASE  || 'https://api.deepseek.com';
const DEFAULT_MODEL = process.env.PROXY_MODEL || 'deepseek-chat';
const MAX_PER_DAY   = parseInt(process.env.MAX_PER_DAY || '200', 10);
const ALLOW_ORIGIN  = (process.env.ALLOW_ORIGIN || '').trim();

// 优先用 Netlify Blobs 持久计数；拿不到就退回内存（函数冷启动会重置）
let store = null;
try {
  store = require('@netlify/blobs').getStore({ name: 'chris-rate', consistency: 'strong' });
} catch (e) {
  store = null;
}
let mem = { day: '', n: 0 };

// 给当天的计数器 +1，返回累计次数
async function bump(day) {
  if (store) {
    try {
      const cur = parseInt((await store.get(day)) || '0', 10);
      await store.set(day, String(cur + 1));
      return cur + 1;
    } catch (e) {
      // Blobs 不可用时静默降级
    }
  }
  if (mem.day !== day) { mem.day = day; mem.n = 0; }
  mem.n += 1;
  return mem.n;
}

exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin': '*' };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };
  }

  // 来源检查：只接受来自自己站点的请求（挡住脚本直接调用）
  if (ALLOW_ORIGIN) {
    const src = event.headers.referer || event.headers.origin || '';
    if (!src.includes(ALLOW_ORIGIN)) {
      return { statusCode: 403, headers: cors, body: '来源不被允许' };
    }
  }

  // 每日总额度：超过就拒绝，控制损失
  const day = new Date().toISOString().slice(0, 10);
  const used = await bump(day);
  if (used > MAX_PER_DAY) {
    return {
      statusCode: 429,
      headers: cors,
      body: '今日额度已用完（' + MAX_PER_DAY + ' 次）'
    };
  }

  // 服务端 Key
  const key = process.env.MY_KEY;
  if (!key) {
    return { statusCode: 500, headers: cors, body: '服务器没有配置 MY_KEY' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: cors, body: '请求体不是合法 JSON' };
  }

  // 强制使用服务端指定的模型，前端传什么都不生效；并关闭流式
  payload.model = DEFAULT_MODEL;
  payload.stream = false;

  try {
    const res = await fetch(DEFAULT_BASE.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key
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
