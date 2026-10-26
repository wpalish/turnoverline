const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};

export function workspaceGuide(screen, { config, state, active, journey, navigate }) {
  history.replaceState(null, '', '#section=' + encodeURIComponent(active));
  const previous = screen.querySelector('.workflow-guide');
  const guide = node('details', undefined, 'workflow-guide');
  guide.open = previous ? previous.open : false;
  const summary = node('summary', journey.title);
  guide.append(summary, node('p', journey.description, 'workflow-intro'));
  const steps = node('ol', undefined, 'workflow-steps');
  for (const step of journey.steps) {
    const definition = config.collections.find(item => item.key === step.key);
    if (!definition) continue;
    const count = state.data[step.key].filter(row => !row.archived).length;
    const item = node('li');
    const action = node('button', definition.title, 'workflow-link');
    action.type = 'button';
    if (active === step.key) action.setAttribute('aria-current', 'step');
    action.addEventListener('click', () => navigate(step.key));
    item.append(action, node('p', step.description), node('span', `Вне архива: ${count}`, 'workflow-count'));
    steps.append(item);
  }
  guide.append(steps);
  const navigation = document.getElementById('navigation');
  const current = navigation?.querySelector('[aria-current="page"]');
  if (current && matchMedia('(max-width: 600px)').matches)
    navigation.scrollLeft = current.offsetLeft - navigation.offsetLeft - (navigation.clientWidth - current.clientWidth) / 2;
  if (previous) previous.replaceWith(guide);
  else screen.insertBefore(guide, screen.children[2] || null);
}

export function recordSummary(host, shown, total) {
  let counter = document.getElementById('record-count');
  if (!counter) {
    counter = node('p', undefined, 'record-count');
    counter.id = 'record-count';
    counter.setAttribute('role', 'status');
    counter.setAttribute('aria-live', 'polite');
    host.before(counter);
  }
  counter.textContent = `Показано: ${shown} из ${total}`;
}

export function emptyRecords(host, {config, state, active, query, journey, create, clear, navigate, canCreate}) {
  const collection = config.collections.find(item => item.key === active);
  const all = state.data[active];
  const empty = node('div', undefined, 'empty-records');
  if (all.length) {
    empty.append(node('h2', query ? 'Поиск не дал результатов' : 'Записи находятся в архиве'));
    empty.append(node('p', 'Проверьте запрос или покажите записи вместе с архивом. Сохранённые данные остаются на месте.'));
    const reset = node('button', 'Показать все записи', 'secondary');
    reset.type = 'button';
    reset.addEventListener('click', clear);
    empty.append(reset);
  } else {
    const step = journey.steps.find(item => item.key === active);
    empty.append(node('h2', `Пока нет записей: ${collection.title.toLocaleLowerCase('ru')}`));
    empty.append(node('p', step?.description || collection.description || config.description));
    const missing = collection.fields.find(field => field.ref && !state.data[field.ref]?.some(row => !row.archived));
    if (missing) {
      const dependency = config.collections.find(item => item.key === missing.ref);
      empty.append(node('p', `Сначала добавьте данные в раздел «${dependency.title}»: они нужны для поля «${missing.label}».`, 'muted'));
      const next = node('button', `Открыть «${dependency.title}»`, 'primary');
      next.type = 'button';
      next.addEventListener('click', () => navigate(missing.ref));
      empty.append(next);
    } else if (canCreate) {
      const next = node('button', collection.addLabel || 'Создать первую запись', 'primary');
      next.type = 'button';
      next.addEventListener('click', create);
      empty.append(next);
    } else {
      empty.append(node('p', collection.createDisabled ? 'Записи поступают через опубликованную форму. Откройте раздел «Формы» и проверьте публичную ссылку.' : 'Данные для этого этапа подготавливает администратор.', 'muted'));
    }
  }
  host.append(empty);
}

export function labelTable(host) {
  const table = host.querySelector('table');
  if (!table) return;
  const labels = [...table.querySelectorAll('thead th')].map(cell => {
    cell.scope = 'col';
    return cell.textContent;
  });
  for (const row of table.querySelectorAll('tbody tr')) {
    [...row.children].forEach((cell, index) => {cell.dataset.label = labels[index] || '';});
    for (const button of row.querySelectorAll('button')) {
      if (['Открыть', 'Изменить'].includes(button.textContent.trim()))
        button.setAttribute('aria-label', `${button.textContent}: ${row.cells[0].textContent.slice(0, 120)}`);
    }
  }
}
