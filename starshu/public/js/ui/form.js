// 表单校验：给必填但为空的控件打红框，并把视口滚动到第一个错误项。
// 纯 DOM 操作，不依赖任何视图，供各表单页复用。

export function markRequiredInvalid(container, ids) {
  let first = null;
  ids.forEach((id) => {
    const el = container.querySelector('#' + id);
    if (el && !String(el.value).trim()) {
      el.setAttribute('aria-invalid', 'true');
      if (!first) first = el;
      el.addEventListener('input', function clr() { el.removeAttribute('aria-invalid'); }, { once: true });
    }
  });
  if (first) first.focus();
  return !!first;
}

// ---------- 分类 ----------
