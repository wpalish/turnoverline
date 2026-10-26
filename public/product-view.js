const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
const stamp = value => value ? value.slice(0, 16).replace('T', ' ') + ' UTC' + (value.match(/[+-]\d\d:\d\d$/)?.[0] || '+00:00') : 'Не задано';
const action = (text, fn, context) => {
  const button = el('button', text, 'secondary');
  button.type = 'button';
  if (context) button.setAttribute('aria-label', text + ': ' + context);
  button.addEventListener('click', fn);
  return button;
};
export const productMeta = {
  defaultSection: 'tasks',
  navigation: ['tasks', 'stays', 'properties'],
  labels: { tasks: 'Подготовка', stays: 'Заезды', properties: 'Объекты' },
  headings: {
    tasks: ['Передача между заездами', 'Выезд → подготовка → следующий гость. Каждая работа в своём окне.'],
    stays: ['Заезды и окна', 'Интервалы проживания и связанные работы по каждому объекту.'],
    properties: ['Объекты', 'Инструкции, заезды и подготовка в одном месте.'],
  },
};

export function nextStay(stay, stays) {
  return stays.filter(item => item.id !== stay.id && item.property === stay.property && item.status !== 'cancelled' && Date.parse(item.start) >= Date.parse(stay.end)).sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
}
export function groupHandoffs(stays, tasks) {
  const groups = stays.map(stay => {
    const open = tasks.filter(task => task.stay === stay.id && task.status === 'open' && !task.archived);
    return {stay, deadline: open.length ? Math.min(...open.map(task => Date.parse(task.due))) : null};
  });
  return {
    current: groups.filter(group => group.deadline !== null)
      .sort((a, b) => a.deadline - b.deadline || Date.parse(a.stay.end) - Date.parse(b.stay.end))
      .map(group => group.stay),
    history: groups.filter(group => group.deadline === null)
      .sort((a, b) => Date.parse(b.stay.end) - Date.parse(a.stay.end))
      .map(group => group.stay),
  };
}
function taskLine(task, open) {
  const line = el('article', undefined, 'handoff-task' + (task.status === 'done' ? ' is-done' : ''));
  const mark = el('span', task.status === 'done' ? 'Выполнена' : 'Открыта', 'task-mark');
  const main = el('div', undefined, 'task-main');
  main.append(el('h3', task.task), el('p', task.assignee, 'assignee'), el('p', 'Срок · ' + stamp(task.due), 'task-due'));
  if (task.archived) main.append(el('span', 'Архив', 'state-tag'));
  line.append(mark, main, action('Открыть работу', () => open('tasks', task), task.task));
  return line;
}
function handoff(stay, tasks, data, open) {
  const next = nextStay(stay, data.stays);
  const property = data.properties.find(item => item.id === stay.property);
  const section = el('section', undefined, 'handoff');
  const heading = el('div', undefined, 'handoff-heading');
  const title = el('div');
  title.append(el('h2', property?.name || 'Объект не найден'), el('p', 'После заезда ' + stay.code + (stay.archived ? ' · архив' : '') + (stay.status === 'cancelled' ? ' · отменён' : ''), 'muted'));
  heading.append(title, action('Открыть заезд', () => open('stays', stay), stay.code));
  section.append(heading);
  const window = el('dl', undefined, 'handoff-window');
  for (const [label, value] of [['Выезд', stamp(stay.end)], ['Следующий заезд', next ? stamp(next.start) : 'Пока не запланирован']]) {
    const item = el('div');
    item.append(el('dt', label), el('dd', value));
    window.append(item);
  }
  section.append(window);
  if (property?.note) {
    const instruction = el('details', undefined, 'property-instruction');
    instruction.append(el('summary', 'Инструкция объекта'), el('p', property.note));
    section.append(instruction);
  }
  if (!tasks.length) section.append(el('p', 'Работы после этого заезда ещё не назначены.', 'handoff-empty'));
  for (const task of [...tasks].sort((a, b) => Date.parse(a.due) - Date.parse(b.due))) section.append(taskLine(task, open));
  return section;
}

export function productView({ host, key, rows, data, open }) {
  if (key === 'tasks') {
    const list = el('div', undefined, 'handoff-list');
    const stayIds = new Set(rows.map(task => task.stay));
    const groups = groupHandoffs(data.stays.filter(stay => stayIds.has(stay.id)), data.tasks);
    for (const stay of groups.current) list.append(handoff(stay, rows.filter(task => task.stay === stay.id), data, open));
    if (groups.history.length) {
      const history = el('details', undefined, 'handoff-history');
      history.open = !groups.current.length;
      history.append(el('summary', `История подготовки · ${groups.history.length}`));
      const previous = el('div', undefined, 'handoff-list');
      for (const stay of groups.history) previous.append(handoff(stay, rows.filter(task => task.stay === stay.id), data, open));
      history.append(previous);
      list.append(history);
    }
    host.append(list, el('p', '«Выполнена» — сохранённая ручная отметка. Готовность объекта и фактическое заселение проверяет управляющий.', 'view-footnote'));
    return true;
  }
  if (key === 'stays') {
    const list = el('div', undefined, 'handoff-list');
    for (const stay of [...rows].sort((a, b) => Date.parse(a.end) - Date.parse(b.end))) {
      const section = handoff(stay, data.tasks.filter(task => task.stay === stay.id && !task.archived), data, open);
      section.querySelector('.handoff-heading > div').append(el('p', 'Заезд · ' + stamp(stay.start), 'stay-arrival'));
      list.append(section);
    }
    host.append(list);
    return true;
  }
  if (key === 'properties') {
    const list = el('div', undefined, 'property-list');
    for (const property of rows) {
      const item = el('article', undefined, 'property-row');
      const body = el('div');
      body.append(el('h2', property.name), el('p', property.note || 'Инструкции пока не добавлены.', 'property-note'));
      const stays = data.stays.filter(stay => stay.property === property.id && !stay.archived);
      body.append(el('small', `Заездов вне архива: ${stays.length}`));
      if (property.archived) body.append(el('span', 'Архив', 'state-tag'));
      item.append(body, action('Открыть объект', () => open('properties', property), property.name));
      list.append(item);
    }
    host.append(list);
    return true;
  }
  return false;
}

export function editorContext({ collection, row, data, open }) {
  if (!row || collection.key !== 'tasks') return null;
  const stay = data.stays.find(item => item.id === row.stay);
  if (!stay) return null;
  const context = handoff(stay, [], data, open);
  context.classList.add('editor-handoff');
  context.querySelector('.handoff-empty')?.remove();
  return context;
}
