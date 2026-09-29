// 后台 Service Worker：有道词典主导的查词 + 生词本收藏。
// 查词依次并发竞速：有道词典 jsonapi（词典释义/音标/发音）→ Google gtx → Google clients5 → MyMemory。
// 收藏用浏览器里已登录 dict.youdao.com 的 Cookie 调用网页版生词本接口。
'use strict';

const PROVIDERS = [youdaoDict, googleGtx, googleClients5, myMemory];

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'ytst-lookup') {
      lookup(msg.text, msg.tl || 'zh-CN').then(
        (data) => sendResponse(data),
        (err) => sendResponse({ ok: false, error: String((err && err.message) || err) })
      );
      return true; // 异步响应
    }
    if (msg.type === 'ytst-wordbook') {
      addWordbook(msg.word || '').then(
        (data) => sendResponse(data),
        (err) => sendResponse({ ok: false, error: String((err && err.message) || err) })
      );
      return true;
    }
  });
}

async function lookup(text, tl) {
  const q = (text || '').trim().slice(0, 500);
  if (!q) return { ok: false, error: 'empty' };
  // 有道优先；多源并发竞速，任一成功立即返回，被墙/失败的源不拖慢整体
  try {
    return await Promise.any(PROVIDERS.map((p) => p(q, tl)));
  } catch (agg) {
    const errors = ((agg && agg.errors) || []).map((e) => (e && e.message) || String(e));
    return { ok: false, error: errors.join(' | ') };
  }
}

async function withTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
  } finally {
    clearTimeout(t);
  }
}

// ---------------- 有道词典（jsonapi_s，与 dict.youdao.com 网页版同源接口，免密钥） ----------------
function youdaoAudioUrl(speech) {
  // jsonapi 返回的 speech 形如 "hello&type=2"（dictvoice 的查询参数部分）
  if (!speech) return '';
  if (/^https?:/i.test(speech)) return speech;
  return 'https://dict.youdao.com/dictvoice?audio=' + speech;
}

async function youdaoDict(q) {
  const url =
    'https://dict.youdao.com/jsonapi_s?doctype=json&jsonversion=4&q=' + encodeURIComponent(q);
  const res = await withTimeout(url);
  if (!res.ok) throw new Error('youdao HTTP ' + res.status);
  const data = await res.json();

  // ec.word 可能是对象也可能是数组（不同响应形态），simple.word 同理
  function firstWord(container) {
    if (!container) return null;
    const w = container.word;
    if (!w) return null;
    return Array.isArray(w) ? w[0] : w;
  }
  const head =
    firstWord(data && data.ec) || firstWord(data && data.simple) || null;
  const phonetics = { us: '', uk: '' };
  const audio = { us: '', uk: '' };
  if (head) {
    phonetics.us = head.usphone || '';
    phonetics.uk = head.ukphone || '';
    audio.us = youdaoAudioUrl(head.usspeech);
    audio.uk = youdaoAudioUrl(head.ukspeech);
  }

  // 词典释义（单词）：ec.word[0].trs
  const dict = [];
  if (head && Array.isArray(head.trs)) {
    for (const t of head.trs) {
      if (t && (t.tran || t.pos)) dict.push({ pos: t.pos || '', terms: [t.tran || ''] });
    }
  }

  // 整句/短语翻译：fanyi.tran；没有时退 web_trans 第一条 value
  let translation = '';
  if (data && data.fanyi && data.fanyi.tran) {
    translation = data.fanyi.tran;
  } else if (
    data &&
    data.web_trans &&
    Array.isArray(data.web_trans['web-translation']) &&
    data.web_trans['web-translation'][0]
  ) {
    const trans = data.web_trans['web-translation'][0].trans || [];
    const v = trans.map((x) => x && x.value).filter(Boolean)[0];
    if (v) translation = v;
  }
  // 单词释义缺失时兜底取 ec.web_trans（网络释义）
  if (!translation && !dict.length && data && data.ec && Array.isArray(data.ec.web_trans)) {
    translation = data.ec.web_trans.slice(0, 4).join('；');
  }

  // 词形变化（复数/过去式…）
  const wfs = [];
  if (head && Array.isArray(head.wfs)) {
    for (const item of head.wfs) {
      if (item && item.wf && item.wf.name && item.wf.value) wfs.push(item.wf.name + ' ' + item.wf.value);
    }
  }

  if (!translation && !dict.length && !phonetics.us && !phonetics.uk) throw new Error('youdao empty');
  return { ok: true, provider: 'youdao', translation, dict, phonetics, audio, wfs };
}

// ---------------- 免密钥兜底：Google gtx / clients5 / MyMemory ----------------
async function googleGtx(q, tl) {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
    encodeURIComponent(tl) +
    '&dt=t&dt=bd&dj=1&q=' +
    encodeURIComponent(q);
  const res = await withTimeout(url);
  if (!res.ok) throw new Error('gtx HTTP ' + res.status);
  const data = await res.json();
  const translation = (data.sentences || []).map((s) => s.trans || '').join('');
  const dict = (data.dict || []).map((d) => ({
    pos: d.pos || '',
    terms: (d.terms || []).slice(0, 6),
  }));
  if (!translation && !dict.length) throw new Error('gtx empty');
  return { ok: true, provider: 'google', translation, dict };
}

async function googleClients5(q, tl) {
  const url =
    'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=' +
    encodeURIComponent(tl) +
    '&q=' +
    encodeURIComponent(q);
  const res = await withTimeout(url);
  if (!res.ok) throw new Error('clients5 HTTP ' + res.status);
  const data = await res.json();
  let translation = '';
  if (Array.isArray(data)) {
    if (typeof data[0] === 'string') translation = data[0];
    else if (Array.isArray(data[0])) {
      translation = data[0].map((x) => (Array.isArray(x) ? x[0] : x)).join('');
    }
  }
  if (!translation) throw new Error('clients5 empty');
  return { ok: true, provider: 'google', translation, dict: [] };
}

async function myMemory(q, tl) {
  const url =
    'https://api.mymemory.translated.net/get?q=' +
    encodeURIComponent(q) +
    '&langpair=en|' +
    encodeURIComponent(tl);
  const res = await withTimeout(url);
  if (!res.ok) throw new Error('mymemory HTTP ' + res.status);
  const data = await res.json();
  const translation = data && data.responseData && data.responseData.translatedText;
  if (!translation) throw new Error('mymemory empty');
  return { ok: true, provider: 'mymemory', translation, dict: [] };
}

// ---------------- 有道生词本收藏 ----------------
// 复用浏览器里已登录 dict.youdao.com 的 Cookie（background fetch credentials:'include'
// 会自动携带）调用网页版生词本自身的 addword 接口；未登录返回 {"message":"nouser"}。
function gmtDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return (
    WD[d.getDay()] + ' ' + MO[d.getMonth()] + ' ' + p(d.getDate()) + ' ' + d.getFullYear() + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
    ' GMT+0800 (中国标准时间)'
  );
}

async function addWordbook(word) {
  const q = (word || '').trim().slice(0, 100);
  if (!q) return { ok: false, error: 'empty' };
  const url =
    'https://dict.youdao.com/wordbook/ajax?action=addword&q=' + encodeURIComponent(q) +
    '&date=' + encodeURIComponent(gmtDate()) + '&le=eng';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let res;
  try {
    res = await fetch(url, {
      signal: ctrl.signal,
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  if (data && typeof data.code !== 'undefined') {
    if (Number(data.code) !== 0) throw new Error('code ' + data.code);
    return { ok: true };
  }
  // 未登录等异常不带 code 字段：如 {"message":"nouser"}
  if (data && data.message && /nouser|nologin|error|fail/i.test(String(data.message))) {
    throw new Error(String(data.message));
  }
  if (data === null) throw new Error('bad-response');
  return { ok: true };
}
