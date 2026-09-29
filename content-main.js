// 运行于 MAIN world（页面环境），document_start 阶段执行。
// 将页面中所有 Shadow DOM 强制创建为 open 模式，
// 使内容脚本得以访问沉浸式翻译等扩展注入的字幕覆盖层（否则 closed root 无法探测）。
(() => {
  if (window.__ytstShadowPatched) return;
  window.__ytstShadowPatched = true;
  const original = Element.prototype.attachShadow;
  if (!original) return;
  Element.prototype.attachShadow = function (init) {
    try {
      const patched = Object.assign({}, init, { mode: 'open' });
      return original.call(this, patched);
    } catch (e) {
      return original.apply(this, arguments.length > 1 ? arguments : [init]);
    }
  };
})();
