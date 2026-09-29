// 内容脚本（隔离世界）：YouTube 字幕选词 + 有道查词弹窗（翻译/收藏生词本） + 沉浸式翻译“仅英文”开关。
// 本扩展以有道词典为主导：拖选/双击一律弹本扩展的有道弹窗，不交给外部划词插件。
(() => {
  'use strict';
  if (window.__ytstInit) return;
  window.__ytstInit = true;

  const CAPTION_SEL = '.ytp-caption-segment, .captions-text, .ytp-caption-window-container';
  const CJK_RE = /[\u2E80-\u2EFF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;
  const WORD_RE_SRC = "[A-Za-z][A-Za-z'’\\-]*";
  const TL = 'zh-CN';
  const IT_MARK_SEL =
    '[id*="immersive-translate"],[class*="immersive-translate"],[id*="immersive_translate"],[class*="immersive_translate"]';
  const PLAYER_SEL = '.html5-video-player, #movie_player';

  const state = {
    enOnly: false,
    ccWasOffBefore: false,
    itHosts: new Set(), // 检测到的沉浸式翻译字幕容器（Element 或 ShadowRoot）
    popup: null,
    drag: null,
    toggleEl: null,
    mx: null,
    my: null,
    lastUpAt: 0, // 上一次松手时间/位置：用于识别双击的第二次按下
    lastUpX: -1,
    lastUpY: -1,
  };

  // ---------------- 存储 ----------------
  const storage = {
    async get(key, def) {
      try {
        if (window.chrome && chrome.storage && chrome.storage.local) {
          const r = await chrome.storage.local.get(key);
          return key in r ? r[key] : def;
        }
      } catch (_) {}
      try {
        const v = localStorage.getItem('ytst:' + key);
        return v === null ? def : JSON.parse(v);
      } catch (_) {
        return def;
      }
    },
    async set(key, val) {
      try {
        if (window.chrome && chrome.storage && chrome.storage.local) {
          await chrome.storage.local.set({ [key]: val });
          return;
        }
      } catch (_) {}
      try {
        localStorage.setItem('ytst:' + key, JSON.stringify(val));
      } catch (_) {}
    },
  };

  // ---------------- 调试（把最近事件镜像到 <html> 的 data 属性，便于自动化检查） ----------------
  const dbgLog = [];
  function dbg(msg) {
    dbgLog.push(msg);
    if (dbgLog.length > 24) dbgLog.shift();
    try {
      document.documentElement.setAttribute('data-ytst-dbg', dbgLog.join(' | '));
    } catch (_) {}
  }

  // ---------------- 基础工具 ----------------
  function isWatchPage() {
    return !!document.querySelector('video');
  }

  function stopEvent(e) {
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  // 元素是否位于字幕上下文（原生字幕或已登记的沉浸式翻译覆盖层，可穿透 shadow 边界）
  function captionContextChain(el) {
    if (!el) return false;
    if (el.closest && el.closest(CAPTION_SEL)) return true;
    let node = el;
    while (node) {
      if (state.itHosts.has(node)) return true;
      const parent = node.parentNode;
      if (parent instanceof ShadowRoot) {
        if (state.itHosts.has(parent)) return true;
        node = parent.host;
      } else {
        node = parent instanceof Element ? parent : null;
      }
    }
    return false;
  }

  function nodeInCaptionContext(node) {
    if (!node) return false;
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return el ? captionContextChain(el) : false;
  }

  function caretFromPoint(x, y) {
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      return r ? { node: r.startContainer, offset: r.startOffset } : null;
    }
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    return null;
  }

  // 命中某坐标处的字幕文本节点。沉浸式翻译覆盖层可能设置 pointer-events:none，
  // 命中测试前临时翻转为可命中，测完立即还原。
  // endInclusive=true 用于划选的“松手端”：采用字符单元规则（见 charOffsetAt）。
  function textAtPoint(x, y, endInclusive) {
    const flipped = [];
    for (const item of state.itHosts) {
      const el = item instanceof ShadowRoot ? item.host : item;
      if (el instanceof Element && getComputedStyle(el).pointerEvents === 'none') {
        el.style.pointerEvents = 'auto';
        flipped.push(el);
      }
    }
    try {
      // 真实命中最上层元素：若字幕上面还压着别的浮层（其他弹窗、控制条等），
      // 用户点的是浮层而不是字幕——返回 null 让事件原样通过。否则下面的几何兜底会
      // “透视”字幕矩形（字幕被盖住矩形依然存在），误吞浮层上的点击。
      const topEl = document.elementFromPoint(x, y);
      if (topEl && !captionContextChain(topEl)) {
        // 覆盖层登记的是宿主的 ShadowRoot；宿主元素本身也要视为字幕上下文
        let hostOk = false;
        try {
          const root = topEl instanceof Element ? shadowRootOf(topEl) : null;
          hostOk = !!(root && state.itHosts.has(root));
        } catch (_) {}
        if (!hostOk) return null;
      }
      const caret = caretFromPoint(x, y);
      if (caret && caret.node && caret.node.nodeType === Node.TEXT_NODE && (caret.node.nodeValue || '').trim()) {
        const el = caret.node.parentElement;
        if (el && captionContextChain(el)) {
          let rect = null;
          try {
            rect = el.getBoundingClientRect();
          } catch (_) {}
          if (endInclusive) {
            const hit = charOffsetAt(el, rect, x, y, true);
            if (hit) return { node: hit.node, offset: hit.offset, el, rect };
          }
          return { node: caret.node, offset: caret.offset, el, rect };
        }
      }
      // caretRangeFromPoint/caretPositionFromPoint 命中 shadow 内文本时只会返回文档树节点，
      // 无法穿透 shadow root（实测 elementFromPoint 已命中宿主，caret 仍是 BODY），
      // 因此对已登记的覆盖层做纯几何兜底：找包含 (x,y) 的行，再取出最近的字符偏移。
      return textAtPointInShadow(x, y, endInclusive);
    } finally {
      for (const el of flipped) el.style.pointerEvents = 'none';
    }
  }

  function textAtPointInShadow(x, y, endInclusive) {
    const items = [...state.itHosts];
    for (let i = items.length - 1; i >= 0; i--) {
      let lines;
      try {
        lines = collectTextLines(items[i]);
      } catch (_) {
        continue;
      }
      const hostEl = items[i] instanceof ShadowRoot ? items[i].host : items[i];
      const stripLike = hostEl instanceof Element && looksOverlayBox(hostEl);
      const candidates = stripLike ? lines : linesOverPlayer(lines);
      for (let j = candidates.length - 1; j >= 0; j--) {
        const el = candidates[j];
        let r;
        try {
          r = el.getBoundingClientRect();
        } catch (_) {
          continue;
        }
        if (!r.width || !r.height) continue;
        if (y < r.top - 8 || y > r.bottom + 8) continue;
        // 松手点略超出行首/行尾（拖选时经常发生过冲）时夹回行内继续取字，
        // 否则行尾几个字母会选不中；超出太多才算脱靶
        if (x < r.left - 48 || x > r.right + 48) continue;
        const hit = charOffsetAt(el, r, Math.min(Math.max(x, r.left), r.right), y, !!endInclusive);
        if (!hit) continue;
        if (!captionContextChain(el)) continue;
        return { node: hit.node, offset: hit.offset, el, rect: r };
      }
    }
    return null;
  }

  // 行元素内与坐标 (x, y) 最近的字符位置（Range 折叠 caret 测量）。
  // - inclusive=true 用于划选的“松手端”：按“字符单元”取终点——松手点压在哪个字符上，
  //   选区就包含到哪个字符（与浏览器原生选区一致）。此前用“最近 caret 边界 + 空白归并”，
  //   松手落在词尾字母或词后的空格上时，归并的平局规则会把终点退到词尾字母之前，
  //   丢掉最后一个字母（“最后几个字母有时选不中”的根因）。
  // - y 参与选行：文本换行成多行时，先按 caret 的纵向位置锁定 y 所在（或最近）的一行，
  //   再在该行内按 x 二分——否则不同行的相同 x 有二义性，终点可能落到别的行。
  function charOffsetAt(el, rect, x, y, inclusive) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const positions = [];
    let n;
    while ((n = walker.nextNode())) {
      const t = n.nodeValue || '';
      if (!t.trim()) continue;
      for (let k = 0; k <= t.length; k++) positions.push({ node: n, off: k });
    }
    const total = positions.length - 1;
    if (total < 0) return null;
    const safeRect = rect || { left: 0, top: 0, width: 0, height: 0 };
    const caretBox = (o) => {
      const p = positions[Math.max(0, Math.min(o, total))];
      const rng = document.createRange();
      rng.setStart(p.node, p.off);
      rng.collapse(true);
      const r = rng.getBoundingClientRect();
      if (!r.width && !r.height) return null;
      return { cx: r.left + r.width / 2, top: r.top, bottom: r.bottom };
    };
    const textOf = (o) => {
      const p = positions[Math.max(0, Math.min(o, total))];
      return p.node.nodeValue[p.off] || '';
    };
    const nudge = (o) => {
      if (!/\s/.test(textOf(o))) return o;
      let lo = o;
      let hi = o;
      while (lo > 0 && /\s/.test(textOf(lo))) lo--;
      while (hi < total && /\s/.test(textOf(hi))) hi++;
      return o - lo <= hi - o ? lo : hi;
    };
    // 量出全部 caret；中段空矩形（内联元素边界处折叠 Range 无矩形）用最近有效值插值补齐，
    // 否则二分会在空值处提前中断，同样表现为“行尾几个字母选不中”。
    const boxes = new Array(total + 1);
    for (let k = 0; k <= total; k++) boxes[k] = caretBox(k);
    let prevB = null;
    for (let k = 0; k <= total; k++) {
      if (boxes[k]) prevB = boxes[k];
      else if (prevB) boxes[k] = { cx: prevB.cx, top: prevB.top, bottom: prevB.bottom };
    }
    let nextB = null;
    for (let k = total; k >= 0; k--) {
      if (boxes[k]) nextB = boxes[k];
      else if (nextB) boxes[k] = { cx: nextB.cx, top: nextB.top, bottom: nextB.bottom };
    }
    if (!boxes[0] || !boxes[total]) {
      // 整行 caret 都量不出来：按横向比例估算
      const off = Math.max(0, Math.min(total, Math.round(((x - safeRect.left) / Math.max(1, safeRect.width)) * total)));
      const p = positions[off];
      return { node: p.node, offset: p.off };
    }
    // 行分组：纵向 band 相近的连续 caret 算一行，锁定 y 所在（或最近，30px 内）的行
    let lo = 0;
    let hi = total;
    if (typeof y === 'number' && total > 0) {
      const rows = [];
      let start = 0;
      for (let k = 1; k <= total; k++) {
        if (Math.abs(boxes[k].top - boxes[k - 1].top) > 4 || Math.abs(boxes[k].bottom - boxes[k - 1].bottom) > 4) {
          rows.push({ start, end: k - 1, top: boxes[k - 1].top, bottom: boxes[k - 1].bottom });
          start = k;
        }
      }
      rows.push({ start, end: total, top: boxes[total].top, bottom: boxes[total].bottom });
      let best = null;
      let bestDist = Infinity;
      for (const row of rows) {
        const d = y < row.top ? row.top - y : y > row.bottom ? y - row.bottom : 0;
        if (d < bestDist) {
          bestDist = d;
          best = row;
        }
      }
      if (best && bestDist <= 30) {
        lo = best.start;
        hi = best.end;
      }
    }
    const c0 = boxes[lo].cx;
    const cT = boxes[hi].cx;
    let off;
    if (cT < c0) {
      off = Math.max(lo, Math.min(hi, Math.round(((x - safeRect.left) / Math.max(1, safeRect.width)) * (hi - lo) + lo)));
    } else {
      let a = lo;
      let b = hi;
      while (b - a > 1) {
        const mid = (a + b) >> 1;
        if (boxes[mid].cx < x) a = mid;
        else b = mid;
      }
      if (inclusive) {
        // 字符单元包含：取“首个 cx >= x 的边界”为终点 = x 左侧全部字符 + x 压着的字符
        off = x <= boxes[a].cx ? a : b;
      } else {
        off = Math.abs(boxes[a].cx - x) <= Math.abs(boxes[b].cx - x) ? a : b;
        off = nudge(off);
      }
    }
    const p = positions[off];
    return { node: p.node, offset: p.off };
  }

  // 某坐标处的英文单词 Range（双击取词）
  function wordRangeAt(x, y) {
    const at = textAtPoint(x, y);
    if (!at) return null;
    const text = at.node.nodeValue || '';
    const offset = Math.max(0, Math.min(at.offset, text.length));
    const re = new RegExp(WORD_RE_SRC, 'g');
    let best = null;
    let bestDist = Infinity;
    let m;
    while ((m = re.exec(text))) {
      if (offset >= m.index && offset <= m.index + m[0].length) {
        best = m;
        bestDist = 0;
        break;
      }
      const dist = m.index > offset ? m.index - offset : offset - (m.index + m[0].length);
      if (dist >= 0 && dist < bestDist) {
        best = m;
        bestDist = dist;
      }
      if (m.index > offset + 1) break;
    }
    if (!best || bestDist > 1) return null;
    let start = best.index;
    let end = start + best[0].length;
    while (end > start + 1 && /[-'’]$/.test(text.slice(start, end))) end--;
    const range = document.createRange();
    range.setStart(at.node, start);
    range.setEnd(at.node, end);
    return range;
  }

  // 两个坐标之间的文本 Range（划选短语）。
  // 按下端用最近边界，松手端用“字符单元包含”（见 charOffsetAt）；
  // 松手点漂出文本行（拖动时上下晃动超出 ±8px）时，投影回按下端命中的那一行再取字，
  // 避免整次划选作废。
  function rangeBetweenPoints(x1, y1, x2, y2) {
    const a = textAtPoint(x1, y1);
    if (!a) return null;
    let b = textAtPoint(x2, y2, true);
    if (!b && a.el && a.rect) {
      const r = a.rect;
      if (y2 >= r.top - 28 && y2 <= r.bottom + 28) {
        const cx = Math.min(Math.max(x2, r.left), r.right);
        const hit = charOffsetAt(a.el, r, cx, y2, true);
        if (hit) b = { node: hit.node, offset: hit.offset };
      }
    }
    if (!b) return null;
    try {
      const ra = document.createRange();
      ra.setStart(a.node, a.offset);
      ra.setEnd(a.node, a.offset);
      const rb = document.createRange();
      rb.setStart(b.node, b.offset);
      rb.setEnd(b.node, b.offset);
      const cmp = ra.compareBoundaryPoints(Range.START_TO_START, rb);
      const first = cmp <= 0 ? a : b;
      const last = cmp <= 0 ? b : a;
      const r = document.createRange();
      r.setStart(first.node, first.offset);
      r.setEnd(last.node, last.offset);
      return r.collapsed ? null : r;
    } catch (_) {
      return null;
    }
  }

  // ---------------- 高亮 ----------------
  function setHighlight(ranges) {
    try {
      if (typeof Highlight !== 'undefined' && window.CSS && CSS.highlights) {
        CSS.highlights.set('yt-sub-sel', new Highlight(...ranges));
        return true;
      }
    } catch (_) {}
    return false;
  }

  function clearHighlight() {
    try {
      if (window.CSS && CSS.highlights) CSS.highlights.delete('yt-sub-sel');
    } catch (_) {}
  }

  // 画高亮（不建原生选区）。有道主导版：拖选/双击都配合本扩展弹窗使用，
  // 不产生原生选区就不会触发其他划词插件（欧陆词典等），不会叠出两个框。
  function selectRangeVisual(range) {
    clearHighlight();
    return setHighlight([range]);
  }

  function clearSelectionUI() {
    clearHighlight();
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && !sel.isCollapsed) {
        if (nodeInCaptionContext(sel.anchorNode) && nodeInCaptionContext(sel.focusNode)) {
          sel.removeAllRanges();
        }
      }
    } catch (_) {}
  }

  // ---------------- 事件 ----------------
  function insidePopup(e) {
    return !!(state.popup && e.composedPath && e.composedPath().includes(state.popup.host));
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    if (insidePopup(e)) return;
    const at = textAtPoint(e.clientX, e.clientY);
    dbg('md@' + e.clientX + ',' + e.clientY + (at ? ':hit' : ':miss'));
    if (at) {
      state.drag = { x: e.clientX, y: e.clientY, moved: false };
      hidePopup();
      clearHighlight();
      stopEvent(e); // 阻止播放器响应（暂停/控制条）
      // 阻止浏览器形成原生选区（拖选/双击选词都是 mousedown 的默认行为）：
      // 欧陆词典等划词插件以选区为锚，不形成选区它们就不会弹框；
      // 本扩展的取词走几何命中 + 高亮，不依赖原生选区。
      e.preventDefault();
      // 双击的第二次按下：preventDefault 取消浏览器默认的“双击选词”，
      // 保持取词行为全部由本扩展接管（弹窗内高亮 + 有道翻译 + 收藏）。
      const now = performance.now();
      if (
        now - state.lastUpAt < 450 &&
        Math.abs(e.clientX - state.lastUpX) < 8 &&
        Math.abs(e.clientY - state.lastUpY) < 8
      ) {
        e.preventDefault();
      }
    } else {
      state.drag = null;
      if (state.popup) hidePopup();
      clearSelectionUI();
    }
  }

  function onMouseMove(e) {
    state.mx = e.clientX;
    state.my = e.clientY;
    if (!state.drag) return;
    if (Math.abs(e.clientX - state.drag.x) + Math.abs(e.clientY - state.drag.y) > 4) {
      state.drag.moved = true;
    }
  }

  function onMouseUp(e) {
    if (insidePopup(e)) return;
    if (!state.drag) return;
    const drag = state.drag;
    state.drag = null;
    // 记录松手时间/位置，供 onMouseDown 识别双击的第二次按下
    state.lastUpAt = performance.now();
    state.lastUpX = e.clientX;
    state.lastUpY = e.clientY;
    if (drag.moved) {
      // 有道主导：拖选一律走本扩展弹窗（整句/短语有道翻译 + 收藏）。
      // 用几何兜底构建 range（原生字幕与覆盖层通用），高亮尽力而为。
      const range = rangeBetweenPoints(drag.x, drag.y, e.clientX, e.clientY);
      if (range) {
        const t = (range.toString() || '').trim();
        if (t) {
          selectRangeVisual(range);
          showPopupForRange(range, t);
          return;
        }
      }
    }
    // 纯单击：仅拦截，不取词
  }

  function onDblClick(e) {
    if (e.button !== 0) return;
    if (insidePopup(e)) return;
    const at = textAtPoint(e.clientX, e.clientY);
    dbg('dc@' + e.clientX + ',' + e.clientY + (at ? ':hit' : ':miss'));
    if (!at) return;
    stopEvent(e); // 防止双击触发全屏；第二次按下已在 mousedown 里 preventDefault
    const range = wordRangeAt(e.clientX, e.clientY);
    dbg('dc-word:' + (range ? range.toString() : 'null'));
    if (!range) return;
    selectRangeVisual(range); // 仅高亮：不建原生选区，不触发其他划词插件
    const text = range.toString().trim();
    if (text) showPopupForRange(range, text);
  }

  function onClick(e) {
    if (insidePopup(e)) return;
    const at = textAtPoint(e.clientX, e.clientY);
    if (at) stopEvent(e); // 点击字幕上的词不触发播放/暂停
  }

  // 播放控制键：按下时顺带关闭查词弹窗（事件本身不拦截，YouTube 的暂停/快进照常生效）
  const DISMISS_KEYS = new Set([
    ' ', 'k', 'j', 'l', // 播放/暂停、快退/快进 10s
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', // 快退/快进 5s、音量
    'Home', 'End', 'm', 'f', 't', 'i', 'c', 'n', 'p', // 片头片尾、静音、全屏、剧场、小窗、字幕、上下集
  ]);
  for (let d = 0; d <= 9; d++) DISMISS_KEYS.add(String(d)); // 数字跳转百分比

  // 字幕上是否还挂着原生选区（欧陆词典等划词插件的面板以它为锚）
  function captionSelectionAlive() {
    try {
      const sel = window.getSelection();
      return !!(
        sel &&
        sel.rangeCount &&
        !sel.isCollapsed &&
        nodeInCaptionContext(sel.anchorNode) &&
        nodeInCaptionContext(sel.focusNode)
      );
    } catch (_) {
      return false;
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      if (state.popup) hidePopup();
      clearSelectionUI();
      return;
    }
    if (!state.popup && !captionSelectionAlive()) return;
    // 焦点在输入框/可编辑区域时是在打字，不关弹窗
    const t = e.target;
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(String(t.tagName || '')))) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (DISMISS_KEYS.has(k)) {
      // 关掉本扩展弹窗，并清掉字幕上可能残留的原生选区（外部划词插件的面板以它为锚）。
      // 按键事件本身不拦截，YouTube 的暂停/快进照常生效。
      if (state.popup) hidePopup();
      clearSelectionUI();
    }
  }

  // ---------------- 有道查词弹窗 ----------------
  const POPUP_HTML =
    '<style>' +
    ':host{all:initial}' +
    '*{box-sizing:border-box;margin:0;padding:0;font-family:Roboto,"Segoe UI","Microsoft YaHei",sans-serif}' +
    '.box{position:absolute;pointer-events:auto;background:#202124;color:#e8eaed;border:1px solid #3c4043;' +
    'border-radius:12px;padding:10px 12px;max-width:360px;min-width:200px;box-shadow:0 8px 28px rgba(0,0,0,.55);' +
    'font-size:14px;line-height:1.5;z-index:2147483647}' +
    '.head{display:flex;align-items:center;gap:8px}' +
    '.word{font-weight:600;font-size:15px;flex:1;word-break:break-word;user-select:none;-webkit-user-select:none}' +
    '.icon{background:none;border:none;color:#9aa0a6;cursor:pointer;font-size:15px;padding:2px 5px;border-radius:6px;line-height:1}' +
    '.icon:hover{color:#fff;background:#3c4043}' +
    '.phon{margin-top:4px;color:#8ab4f8;font-size:12px;display:none;gap:12px;flex-wrap:wrap}' +
    '.phon .py{display:inline-flex;align-items:center;gap:4px}' +
    '.phon .sp{background:none;border:none;color:#8ab4f8;cursor:pointer;font-size:12px;padding:0 2px}' +
    '.phon .sp:hover{color:#fff}' +
    '.body{margin-top:6px;color:#bdc1c6;max-height:200px;overflow:auto;user-select:none;-webkit-user-select:none}' +
    '.trans{color:#e8eaed}' +
    '.dict-row{margin-top:4px}' +
    '.pos{color:#8ab4f8;margin-right:6px;white-space:nowrap}' +
    '.wfs{margin-top:5px;color:#9aa0a6;font-size:12px}' +
    '.tip{color:#9aa0a6;font-size:13px}' +
    '.provider{margin-top:5px;font-size:11px;color:#5f6368}' +
    '.save{display:block;width:100%;margin-top:8px;background:#2b7bd3;color:#fff;border:none;border-radius:8px;' +
    'padding:7px 0;font-size:13px;cursor:pointer;font-weight:600}' +
    '.save:hover{background:#3a8ae0}' +
    '.save:disabled{opacity:.6;cursor:default}' +
    '.save.done{background:#2e7d32}' +
    '.savetip{margin-top:4px;font-size:11px;color:#f28b82;display:none}' +
    '.links{margin-top:7px;display:flex;gap:12px;border-top:1px solid #3c4043;padding-top:6px}' +
    '.links a{color:#8ab4f8;text-decoration:none;font-size:12px;cursor:pointer}' +
    '.links a:hover{text-decoration:underline}' +
    '</style>' +
    '<div class="box">' +
    '<div class="head"><span class="word"></span>' +
    '<button class="icon speak" title="朗读（有道发音，失败时用本地语音）">🔊</button>' +
    '<button class="icon copy" title="复制">⧉</button></div>' +
    '<div class="phon"></div>' +
    '<div class="body"><span class="tip">查询中…</span></div>' +
    '<div class="provider"></div>' +
    '<button class="save" title="收藏到有道词典生词本（需已在浏览器登录 dict.youdao.com）">＋ 收藏到有道生词本</button>' +
    '<div class="savetip"></div>' +
    '<div class="links">' +
    '<a class="lk-youdao" target="_blank" rel="noopener">有道词典</a>' +
    '<a class="lk-bing" target="_blank" rel="noopener">必应</a>' +
    '<a class="lk-google" target="_blank" rel="noopener">谷歌翻译</a>' +
    '</div></div>';

  function normalizeAnchor(rect) {
    if (!rect || (!rect.width && !rect.height)) {
      const x = typeof state.mx === 'number' ? state.mx : window.innerWidth / 2;
      const y = typeof state.my === 'number' ? state.my : window.innerHeight * 0.75;
      return { left: x, right: x, top: y, bottom: y, width: 0, height: 0 };
    }
    return rect;
  }

  function showPopupForRange(range, text) {
    let rect = null;
    try {
      rect = range.getBoundingClientRect();
    } catch (_) {}
    showPopup(text, normalizeAnchor(rect));
  }

  function showPopup(text, anchor) {
    hidePopup();
    const mount = document.fullscreenElement || document.documentElement;
    const host = document.createElement('div');
    host.style.cssText =
      'position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = POPUP_HTML;
    // 弹窗内的鼠标事件不穿透到播放器
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'mousemove']) {
      host.addEventListener(type, (e) => e.stopPropagation());
    }
    mount.appendChild(host);
    state.popup = { host, shadow, anchor, text, audio: null, phonetics: null };
    fillPopupBase(text);
    positionPopup();
    requestLookup(text);
  }

  function hidePopup() {
    const p = state.popup;
    state.popup = null;
    if (p) p.host.remove();
    clearHighlight();
  }

  function positionPopup() {
    const p = state.popup;
    if (!p) return;
    const box = p.shadow.querySelector('.box');
    const r = box.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const a = p.anchor;
    let left = Math.min(Math.max(8, a.left + a.width / 2 - r.width / 2), Math.max(8, vw - r.width - 8));
    let top = a.top - r.height - 10;
    if (top < 8) top = a.bottom + 10;
    if (top + r.height > vh - 8) top = Math.max(8, vh - r.height - 8);
    box.style.left = Math.round(left) + 'px';
    box.style.top = Math.round(top) + 'px';
  }

  function fillPopupBase(text) {
    const p = state.popup;
    const $ = (s) => p.shadow.querySelector(s);
    $('.word').textContent = text;
    const enc = encodeURIComponent(text);
    $('.lk-youdao').href = 'https://dict.youdao.com/result?word=' + enc + '&lang=en';
    $('.lk-bing').href = 'https://www.bing.com/dict/search?q=' + enc;
    $('.lk-google').href = 'https://translate.google.com/?sl=auto&tl=zh-CN&text=' + enc + '&op=translate';
    $('.speak').addEventListener('click', (e) => {
      e.stopPropagation();
      speak(p);
    });
    $('.copy').addEventListener('click', async (e) => {
      e.stopPropagation();
      let ok = true;
      try {
        await navigator.clipboard.writeText(text);
      } catch (_) {
        ok = fallbackCopy(text);
      }
      const btn = $('.copy');
      btn.textContent = ok ? '✓' : '⧉';
      setTimeout(() => {
        btn.textContent = '⧉';
      }, 1200);
    });
    // 收藏到有道词典生词本：走 background 用浏览器里已登录的 Cookie 调用
    // 网页版生词本的 addword 接口；未登录时在按钮下方提示。
    $('.save').addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = $('.save');
      const tip = $('.savetip');
      tip.style.display = 'none';
      btn.disabled = true;
      btn.textContent = '收藏中…';
      let ok = false;
      let err = '';
      try {
        if (window.chrome && chrome.runtime && chrome.runtime.id) {
          const r = await new Promise((resolve) => {
            try {
              chrome.runtime.sendMessage({ type: 'ytst-wordbook', word: text }, (res) =>
                resolve(res || { ok: false, error: 'no-response' })
              );
            } catch (ex) {
              resolve({ ok: false, error: String(ex) });
            }
          });
          ok = !!r.ok;
          err = r.error || '';
        } else {
          err = 'not-extension';
        }
      } catch (ex) {
        err = String(ex);
      }
      btn.disabled = false;
      if (ok) {
        btn.textContent = '✓ 已收藏到生词本';
        btn.classList.add('done');
        setTimeout(() => {
          btn.textContent = '＋ 收藏到有道生词本';
          btn.classList.remove('done');
        }, 2500);
      } else {
        btn.textContent = '＋ 收藏到有道生词本';
        tip.textContent =
          err === 'not-extension'
            ? '收藏功能需在扩展环境中使用，并先登录 dict.youdao.com'
            : '收藏失败：请先在浏览器登录 dict.youdao.com' + (err ? '（' + err + '）' : '');
        tip.style.display = 'block';
        positionPopup();
      }
    });
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  // 朗读：优先有道 dictvoice 发音（有道美音），失败或无发音时退回本地 TTS
  function speak(p) {
    const audio = p && p.audio && (p.audio.us || p.audio.uk);
    if (audio) {
      try {
        const a = new Audio(audio);
        a.volume = 1;
        const play = a.play();
        if (play && play.catch) play.catch(() => speakTTS(p.text));
        return;
      } catch (_) {}
    }
    speakTTS(p.text);
  }

  function speakTTS(text) {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = 0.9;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch (_) {}
  }

  async function requestLookup(text) {
    let res = null;
    try {
      if (window.chrome && chrome.runtime && chrome.runtime.id) {
        res = await new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage({ type: 'ytst-lookup', text, tl: TL }, (r) =>
              resolve(r || null)
            );
          } catch (_) {
            resolve(null);
          }
        });
      }
    } catch (_) {
      res = null;
    }
    if (!state.popup || state.popup.text !== text) return; // 已被新的取词取代
    if (!res) res = await pageLookup(text);
    if (state.popup && state.popup.text === text) renderLookup(res);
  }

  // 非扩展环境（如本地测试页）的兜底：直接在页面内请求（可能受 CORS 限制）
  async function pageLookup(text) {
    const enc = encodeURIComponent(text);
    try {
      const r = await withTimeout(
        fetch(
          'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
            TL +
            '&dt=t&dt=bd&dj=1&q=' +
            enc
        ),
        6000
      );
      if (r.ok) {
        const data = await r.json();
        const translation = (data.sentences || []).map((s) => s.trans || '').join('');
        const dict = (data.dict || []).map((d) => ({
          pos: d.pos || '',
          terms: (d.terms || []).slice(0, 6),
        }));
        if (translation || dict.length) return { ok: true, provider: 'google', translation, dict };
      }
    } catch (_) {}
    try {
      const r = await withTimeout(
        fetch('https://api.mymemory.translated.net/get?q=' + enc + '&langpair=en|' + TL),
        6000
      );
      if (r.ok) {
        const data = await r.json();
        const translation = data && data.responseData && data.responseData.translatedText;
        if (translation) return { ok: true, provider: 'mymemory', translation, dict: [] };
      }
    } catch (_) {}
    return { ok: false };
  }

  async function withTimeout(promise, ms) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error('timeout')), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function renderLookup(res) {
    const p = state.popup;
    if (!p) return;
    const body = p.shadow.querySelector('.body');
    const phonEl = p.shadow.querySelector('.phon');
    const provider = p.shadow.querySelector('.provider');
    const esc = (s) =>
      String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    // 音标与有道发音（渲染前先清掉上一次的残留）
    p.audio = null;
    p.phonetics = null;
    phonEl.style.display = 'none';
    phonEl.innerHTML = '';
    if (res && res.ok) {
      if (res.phonetics && (res.phonetics.us || res.phonetics.uk)) {
        p.phonetics = res.phonetics;
        p.audio = res.audio || null;
        const seg = (label, phone, idx) =>
          phone || res.audio && res.audio[idx]
            ? '<span class="py">' +
              (label ? esc(label) : '') +
              (phone ? '/' + esc(phone) + '/' : '') +
              (res.audio && res.audio[idx]
                ? '<button class="sp" data-audio="' + esc(res.audio[idx]) + '">🔊</button>'
                : '') +
              '</span>'
            : '';
        phonEl.innerHTML = [seg('us', res.phonetics.us, 'us'), seg('uk', res.phonetics.uk, 'uk')].join('');
        phonEl.style.display = 'flex';
        for (const b of phonEl.querySelectorAll('.sp')) {
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            try {
              new Audio(b.getAttribute('data-audio')).play().catch(() => {});
            } catch (_) {}
          });
        }
      }
      let html = '';
      if (res.translation) html += '<div class="trans">' + esc(res.translation) + '</div>';
      for (const d of res.dict || []) {
        if (d.terms && d.terms.length) {
          html +=
            '<div class="dict-row"><span class="pos">' +
            esc(d.pos) +
            '</span>' +
            esc(d.terms.join('；')) +
            '</div>';
        }
      }
      if (res.wfs && res.wfs.length) {
        html += '<div class="wfs">' + esc(res.wfs.join(' · ')) + '</div>';
      }
      body.innerHTML = html || '<span class="tip">无结果</span>';
      const names = { youdao: '有道词典', google: 'Google 翻译', mymemory: 'MyMemory' };
      provider.textContent = '来源：' + (names[res.provider] || res.provider);
    } else {
      body.innerHTML =
        '<span class="tip">自动翻译不可用（可能网络受限），可点击下方词典链接查询。</span>';
      provider.textContent = '';
    }
    positionPopup();
  }

  // ---------------- 沉浸式翻译：发现覆盖层 + “仅英文”开关 ----------------
  function collectTextLines(rootNode) {
    const out = [];
    const all = rootNode.querySelectorAll('p,div,span,li,h1,h2,h3,h4,font,b,i,em,strong');
    // 一次性自底向上标记“含有带文本后代”的祖先，替代原先对每个元素
    // querySelectorAll('*') 的 O(n²) 扫描（字幕每次刷新都会跑，是卡顿来源之一）
    const hasTextyDesc = new Set();
    for (let i = all.length - 1; i >= 0; i--) {
      if (!(all[i].textContent || '').trim()) continue;
      let p = all[i].parentElement;
      while (p && p !== rootNode && !hasTextyDesc.has(p)) {
        hasTextyDesc.add(p);
        p = p.parentElement;
      }
    }
    for (const el of all) {
      if (!(el.textContent || '').trim()) continue;
      if (!hasTextyDesc.has(el)) out.push(el);
    }
    return out;
  }

  function nearPlayer(el) {
    const player = document.querySelector(PLAYER_SEL);
    if (!player) return false;
    if (player.contains(el)) return true;
    const pr = player.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    // 覆盖层通常悬停于播放器之上或紧邻其周围，放宽到 250px
    return (
      r.top < pr.bottom + 250 &&
      r.bottom > pr.top - 250 &&
      r.left < pr.right + 250 &&
      r.right > pr.left - 250
    );
  }

  // 拿到元素的 shadow root（含 closed——chrome.dom 专为内容脚本提供此能力）
  function shadowRootOf(el) {
    try {
      if (el.shadowRoot) return el.shadowRoot;
      if (window.chrome && chrome.dom && chrome.dom.openOrClosedShadowRoot) {
        return chrome.dom.openOrClosedShadowRoot(el);
      }
    } catch (_) {}
    return null;
  }

  // 形状像字幕覆盖层：悬在播放器区域上的扁宽条
  function looksOverlayBox(el) {
    try {
      const player = document.querySelector(PLAYER_SEL);
      if (!player) return false;
      const pr = player.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      if (r.width < pr.width * 0.3) return false; // 太窄（悬浮球/图标）
      if (r.height > 260 || r.height < 14) return false; // 不是扁条（面板/点状）
      return true;
    } catch (_) {
      return false;
    }
  }

  const itObservers = new Map();
  const itOpaque = new Map(); // 登记时判定：true = 读不到内部文本行，只能整体隐藏宿主

  // 隐藏改用 !important 样式表 + data 属性：沉浸式翻译每次换字幕都会重写行元素的
  // 内联样式（甚至重建元素），内联 display:none 会被覆盖；样式表规则则始终生效。
  // ShadowRoot 各自注入一份，light DOM 由文档级一份统一覆盖。
  function ensureHiddenStyle(root) {
    if (root instanceof ShadowRoot) {
      if (!root.querySelector('#ytst-hidden-style')) {
        const st = document.createElement('style');
        st.id = 'ytst-hidden-style';
        st.textContent = '[data-ytst-hidden]{display:none!important}';
        root.appendChild(st);
      }
      return;
    }
    if (!document.getElementById('ytst-hidden-style')) {
      const st = document.createElement('style');
      st.id = 'ytst-hidden-style';
      st.textContent = '[data-ytst-hidden]{display:none!important}';
      (document.head || document.documentElement).appendChild(st);
    }
  }

  // 让字幕可被原生划选（形成 window.getSelection()）：YouTube 播放器整体是
  // user-select:none，外部划词插件（欧陆词典等）读不到任何选中文字。
  // user-select 只对“选区起点所在元素”的最终计算值生效，!important 即可压过播放器的 none。
  function ensureSelectStyle() {
    if (document.getElementById('ytst-select-style')) return;
    const st = document.createElement('style');
    st.id = 'ytst-select-style';
    st.textContent =
      '#movie_player .ytp-caption-segment,.ytp-caption-segment,.captions-text,' +
      '.ytp-caption-window-container,.ytp-caption-window{user-select:text!important;' +
      '-webkit-user-select:text!important}';
    (document.head || document.documentElement).appendChild(st);
  }

  function registerITContainer(node, opaque) {
    if (state.itHosts.has(node)) return;
    state.itHosts.add(node);
    itOpaque.set(node, !!opaque);
    ensureHiddenStyle(node instanceof ShadowRoot ? node : null);
    const obs = new MutationObserver(() => {
      state.dirty = true;
      scheduleApplyEnOnly();
    });
    obs.observe(node, { childList: true, subtree: true, characterData: true, attributes: true });
    itObservers.set(node, obs);
    scheduleApplyEnOnly();
    dbg('register:' + (node instanceof ShadowRoot ? 'shadow' : 'dom:' + (node.className || node.id)) + (opaque ? ':opaque' : ''));
  }

  let applyTimer = 0;
  let fallbackTick = 0;
  function scheduleApplyEnOnly() {
    if (applyTimer) return;
    applyTimer = setTimeout(() => {
      applyTimer = 0;
      applyEnOnly();
    }, 60);
  }

  function pruneITHosts() {
    for (const item of [...state.itHosts]) {
      const el = item instanceof ShadowRoot ? item.host : item;
      const gone = !el || !el.isConnected;
      const unmarked =
        item instanceof Element &&
        !/immersive[-_]?translate/i.test((item.id || '') + ' ' + (typeof item.className === 'string' ? item.className : ''));
      if (gone || unmarked) {
        const obs = itObservers.get(item);
        if (obs) {
          obs.disconnect();
          itObservers.delete(item);
        }
        itOpaque.delete(item);
        state.itHosts.delete(item);
      }
    }
  }

  // 文本行类别：纯中文 / 纯西文 / 混合
  function lineKindOf(t) {
    const hasC = CJK_RE.test(t);
    const hasL = /[A-Za-z]/.test(t);
    if (hasC && !hasL) return 'cjk';
    if (hasL && !hasC) return 'latin';
    return 'mixed';
  }

  // 只保留实际渲染在播放器区域上的文本行（覆盖层可能挂在全屏容器或零尺寸宿主上）
  function linesOverPlayer(lines) {
    const player = document.querySelector(PLAYER_SEL);
    if (!player) return [];
    const pr = player.getBoundingClientRect();
    const M = 80;
    return lines.filter((el) => {
      try {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        return (
          r.top < pr.bottom + M &&
          r.bottom > pr.top - M &&
          r.left < pr.right + M &&
          r.right > pr.left - M
        );
      } catch (_) {
        return false;
      }
    });
  }

  // 双语判定：渲染在播放器上的行里既有纯中文行又有纯西文行 → 返回纯中文行数组
  function bilingualOverPlayer(node) {
    let lines;
    try {
      lines = collectTextLines(node);
    } catch (_) {
      return null;
    }
    const over = linesOverPlayer(lines);
    const cjk = [];
    let latin = 0;
    for (const el of over) {
      const k = lineKindOf((el.textContent || '').trim());
      if (k === 'cjk') cjk.push(el);
      else if (k === 'latin') latin++;
    }
    return { cjk, latin };
  }

  function scanForIT() {
    ensureSelectStyle(); // 自愈：样式节点若被页面清掉（SPA 导航等）则补回
    if (!isWatchPage()) {
      pruneITHosts();
      ensureToggle();
      return;
    }
    let markedCount = 0;
    const rej = {};
    const rejDetail = [];
    const noteRej = (why, el) => {
      rej[why] = (rej[why] || 0) + 1;
      if (rejDetail.length < 3) {
        try {
          const r = el.getBoundingClientRect();
          const tag = String(el.id || el.className || el.tagName).slice(0, 24);
          rejDetail.push(why + ':' + tag + ':' + Math.round(r.width) + 'x' + Math.round(r.height));
        } catch (_) {
          rejDetail.push(why);
        }
      }
    };
    // 1) 带 immersive-translate 标记的元素：以"渲染在播放器上的双语行"为准
    try {
      const els = document.querySelectorAll(IT_MARK_SEL);
      markedCount = els.length;
      for (const el of els) {
        if (state.popup && el === state.popup.host) continue;
        if (state.itHosts.has(el)) continue;
        let covered = false;
        for (const item of state.itHosts) {
          const holder = item instanceof ShadowRoot ? item.host : item;
          if (holder instanceof Element && holder.contains(el)) {
            covered = true;
            break;
          }
        }
        if (covered) {
          noteRej('covered', el);
          continue;
        }
        const root = shadowRootOf(el);
        const contentNode = root || el;
        const bi = bilingualOverPlayer(contentNode);
        if (bi && bi.cjk.length && bi.latin) {
          registerITContainer(contentNode);
          continue;
        }
        // 读不到内容、但宿主形状是播放器上的扁宽条 → 整体隐藏 + 打开原生英文字幕
        if (!root && nearPlayer(el) && looksOverlayBox(el)) {
          registerITContainer(el, true);
          continue;
        }
        noteRej(bi === null ? 'unreadable' : bi.cjk.length ? 'noLatin' : 'noCjk', el);
      }
    } catch (_) {}
    // 2) 兜底：不带标记的 shadow host，其 shadow 内也有播放器上的双语行
    // （全文档 TreeWalker + 逐元素矩形测量代价高，每 5 轮跑一次即可）
    if (fallbackTick++ % 5 === 0) {
      try {
        const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
        let n;
        while ((n = walker.nextNode())) {
          if (state.popup && n === state.popup.host) continue;
          if (state.itHosts.has(n)) continue;
          if (!nearPlayer(n)) continue;
          const root = shadowRootOf(n);
          if (!root || state.itHosts.has(root)) continue;
          const bi = bilingualOverPlayer(root);
          if (bi && bi.cjk.length && bi.latin) registerITContainer(root);
        }
      } catch (_) {}
    }
    dbg(
      'scan marked=' + markedCount + ' hosts=' + state.itHosts.size + ' rej=' + JSON.stringify(rej) +
        (rejDetail.length ? ' ' + rejDetail.join(',') : '')
    );
    pruneITHosts();
    ensureToggle();
  }

  function applyEnOnly() {
    const opaqueHosts = [];
    let nLines = 0;
    let nOver = 0;
    let nCjk = 0;
    let nHidden = 0;
    let nUnhidden = 0;
    for (const item of state.itHosts) {
      if (item instanceof ShadowRoot) ensureHiddenStyle(item); // 样式被覆盖层重建清掉时补回
      if (itOpaque.get(item)) {
        if (item instanceof Element) opaqueHosts.push(item);
        continue;
      }
      let lines;
      try {
        lines = collectTextLines(item);
      } catch (_) {
        continue;
      }
      // 宿主是扁宽条时按行隐藏即可；若是全屏容器/ShadowRoot，只隐藏渲染在播放器上的行
      const stripLike = item instanceof Element && looksOverlayBox(item);
      const over = linesOverPlayer(lines);
      nLines += lines.length;
      nOver += over.length;
      for (const el of lines) {
        const t = (el.textContent || '').trim();
        const isCjk = CJK_RE.test(t) && !/[A-Za-z]/.test(t);
        if (isCjk) nCjk++;
        // 被隐藏的行 rect 为 0，会被 linesOverPlayer 过滤掉——不能因此撤掉它的隐藏，
        // 否则会形成「隐藏 → 判定不在播放器上 → 取消隐藏 → 又判定在播放器上 → 再隐藏」的振荡，
        // 表现就是「仅英文」时有时生效、有时又变回双语。
        const alreadyHidden = !!(el.dataset && el.dataset.ytstHidden);
        if (state.enOnly && isCjk && (stripLike || over.includes(el) || alreadyHidden)) {
          el.dataset.ytstHidden = '1';
          nHidden++;
        } else if (alreadyHidden) {
          delete el.dataset.ytstHidden;
          nUnhidden++;
        }
      }
    }
    dbg(
      'apply en=' + (state.enOnly ? '1' : '0') + ' hosts=' + state.itHosts.size +
        ' lines=' + nLines + ' over=' + nOver + ' cjk=' + nCjk + ' hid=' + nHidden +
        ' unhid=' + nUnhidden + (opaqueHosts.length ? ' opaque=' + opaqueHosts.length : '')
    );
    // 读不到内部文本行的宿主：整体隐藏覆盖层，并打开 YouTube 原生英文字幕（原生字幕同样可选词）。
    // 可读宿主当前没有中文行只说明译文还没异步渲染出来，交给 MutationObserver/周期兜底，不再误触发整体隐藏。
    if (state.enOnly) {
      for (const el of opaqueHosts) el.dataset.ytstHidden = '1';
      if (opaqueHosts.length && state.ccWasOffBefore === null) {
        state.ccWasOffBefore = setNativeCC(true) === false;
      }
    } else {
      for (const el of opaqueHosts) {
        if (el.dataset.ytstHidden) delete el.dataset.ytstHidden;
      }
      if (state.ccWasOffBefore) setNativeCC(false);
      state.ccWasOffBefore = null;
    }
  }

  function setNativeCC(enable) {
    try {
      const btn = document.querySelector('.ytp-subtitles-button');
      if (!btn || btn.getClientRects().length === 0) return null;
      const pressed = btn.getAttribute('aria-pressed') === 'true';
      if (enable && !pressed) btn.click();
      if (!enable && pressed) btn.click();
      return pressed; // 点击前的状态
    } catch (_) {
      return null;
    }
  }

  // ---------------- 模式切换按钮 ----------------
  function updateToggleLabel() {
    if (!state.toggleEl) return;
    state.toggleEl.textContent = state.enOnly ? '字幕：仅英文' : '字幕：双语';
    state.toggleEl.title =
      '字幕选词助手：切换沉浸式翻译字幕的显示模式（仅英文=隐藏中文行；若其结构不可访问，则隐藏其覆盖层并改用 YouTube 原生英文字幕）';
  }

  function ensureToggle() {
    const player = document.querySelector(PLAYER_SEL);
    if (!isWatchPage() || !player) {
      if (state.toggleEl) {
        state.toggleEl.remove();
        state.toggleEl = null;
      }
      return;
    }
    if (state.toggleEl && player.contains(state.toggleEl)) {
      updateToggleLabel();
      return;
    }
    if (state.toggleEl) state.toggleEl.remove();
    const btn = document.createElement('div');
    btn.style.cssText =
      'position:absolute;top:64px;right:12px;z-index:2300;background:rgba(15,15,15,.85);color:#eee;' +
      'border:1px solid rgba(255,255,255,.2);border-radius:999px;padding:5px 12px;font-size:12px;' +
      'font-family:Roboto,"Microsoft YaHei",sans-serif;cursor:pointer;user-select:none;opacity:.8;';
    btn.addEventListener('mousedown', (e) => e.stopPropagation());
    btn.addEventListener('mouseup', (e) => e.stopPropagation());
    btn.addEventListener('dblclick', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.enOnly = !state.enOnly;
      applyEnOnly();
      updateToggleLabel();
      storage.set('enOnly', state.enOnly); // 持久化异步进行，不阻塞模式应用
      if (!state.itHosts.size) {
        flashToast('未检测到沉浸式翻译字幕覆盖层（请确认其“视频字幕翻译”已开启；诊断：控制台执行 document.documentElement.getAttribute("data-ytst-dbg")）');
      }
    });
    player.appendChild(btn);
    state.toggleEl = btn;
    updateToggleLabel();
  }

  function flashToast(msg) {
    const player = document.querySelector(PLAYER_SEL);
    if (!player) return;
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText =
      'position:absolute;top:64px;left:50%;transform:translateX(-50%);z-index:2301;background:rgba(15,15,15,.9);' +
      'color:#eee;border:1px solid rgba(255,255,255,.2);border-radius:8px;padding:6px 14px;font-size:13px;';
    player.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  // ---------------- 启动 ----------------
  async function init() {
    state.enOnly = !!(await storage.get('enOnly', false));
    state.dirty = false;
    state.ccWasOffBefore = null;
    document.addEventListener('fullscreenchange', hidePopup);
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('dblclick', onDblClick, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('yt-navigate-finish', () => setTimeout(scanForIT, 600));
    ensureSelectStyle();
    scanForIT();
    setInterval(() => {
      // 页面在后台标签页、或用户正在拖选时：跳过全量扫描，避免选词操作卡顿
      if (document.hidden || state.drag) return;
      scanForIT();
    }, 2000);
    // 周期补偿：覆盖层可能在任何时刻改写样式/重建行元素，脏标记驱动重跑 applyEnOnly
    setInterval(() => {
      if (state.enOnly && state.dirty && !state.drag) {
        state.dirty = false;
        applyEnOnly();
      }
    }, 800);
    console.log('[YouTube字幕选词助手] 已加载');
  }

  init();
})();
