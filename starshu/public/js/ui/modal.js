// 模态框（Modal）：居中弹层，用于新建/编辑表单。

export function modal(html) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal">${html}</div>`;
  document.body.appendChild(mask);
  return mask;
}

export function closeModal(m) { m.remove(); }
