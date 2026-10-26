import { productMeta, productView, editorContext } from './product-view.js';
import {workspaceGuide,recordSummary,emptyRecords,labelTable} from './workspace-guide.js';
const journey={"title": "От объекта к подготовке заезда", "description": "Сначала заведите объект и интервалы проживания, затем назначайте подготовку в допустимое окно.", "steps": [{"key": "properties", "description": "Добавьте объект, для которого учитываются заезды и подготовка."}, {"key": "stays", "description": "Укажите начало и конец проживания, проверьте состояние заезда."}, {"key": "tasks", "description": "Назначьте подготовку после выезда и до следующего гостя. Выполнение отмечается вручную."}]};
const screen = document.getElementById("screen"),
  notice = document.getElementById("notice"),
  navigation = document.getElementById("navigation");
let config,
  user,
  state,
  active,
  sequence = 0,
  showArchived = false,
  query = "";
const E = (tag, text, cls) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
function message(text, error = false) {
  notice.className = error ? "error" : "";
  notice.textContent = text;
  if (error) notice.focus();
}
async function run(fn, button) {
  message("");
  const originalLabel = button?.textContent;
  if (button) { button.textContent = originalLabel === "Войти" ? "Вход…" : button.type === "submit" ? "Сохранение…" : "Подождите…"; button.disabled = true; button.setAttribute("aria-busy", "true"); }
  try {
    await fn();
  } catch (e) {
    if (screen.querySelector('[data-loading]')) {
      screen.replaceChildren(E("h1", "Рабочее пространство не загрузилось"), E("p", "Проверьте подключение к серверу и повторите загрузку."), button("Повторить загрузку", () => location.reload(), "primary"));
    }
    message(e.message, true);
  } finally {
    if (button) { button.textContent = originalLabel; button.disabled = false; button.removeAttribute("aria-busy"); }
  }
}
function button(label, fn, cls = "secondary") {
  const b = E("button", label, cls);
  b.type = "button";
  b.addEventListener("click", () => run(fn, b));
  return b;
}
async function api(path, method = "GET", data) {
  const r = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...(user ? { "X-CSRF-Token": user.csrf } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const value = await r.json();
  if (!r.ok) {
    if (r.status === 401 && path !== "/api/login") {
      user = null;
      state = null;
      login();
    }
    throw Error(value.error || "Не удалось выполнить запрос.");
  }
  return value;
}
function input(form, key, label, value = "", type = "text", required = true) {
  const id = "input-" + ++sequence,
    l = E("label", label),
    e = E(type === "textarea" ? "textarea" : "input");
  e.id = id;
  l.htmlFor = id;
  e.name = key;
  if (type !== "textarea") e.type = type;
  e.value = value;
  e.required = required;
  form.append(l, e);
  return e;
}
function download(name, data) {
  const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    ),
    a = E("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function chrome() {
  document.getElementById("brand").textContent = config.title;
  document.title = config.title + " — рабочий кабинет";
  document.getElementById("identity").textContent = user
    ? user.name +
      " · " +
      (user.role === "admin" ? "Администратор" : "Сотрудник")
    : "Самостоятельное размещение";
  document.getElementById("footer").textContent = config.limitations;
  navigation.replaceChildren();
  if (!user) return;
  for (const key of productMeta.navigation) {
    const collection = config.collections.find(item => item.key === key);
    const b = button(productMeta.labels?.[key] || collection.title, () => {
      active = collection.key;
      query = "";
      showArchived = false;
      render();
      const heading = screen.querySelector("h1");
      heading.tabIndex = -1;
      heading.focus();
    });
    if (active === collection.key) b.setAttribute("aria-current", "page");
    navigation.append(b);
  }
  navigation.append(
    button("Данные и доступ", settings),
    button("Выйти", async () => {
      await api("/api/logout", "POST", {});
      user = null;
      chrome();
      login();
    }),
  );
}
function login() {
  chrome();
  screen.replaceChildren(E("h1", config.title), E("p", config.description));
  const f = E("form", undefined, "panel");
  f.style.maxWidth = "480px";
  input(f, "username", "Имя пользователя").autocomplete = "username";
  input(f, "password", "Пароль", "", "password").autocomplete =
    "current-password";
  const submit = E("button", "Войти");
  submit.type = "submit";
  submit.classList.add("primary");
  const actions = E("div", undefined, "actions");
  actions.append(submit);
  f.append(
    actions,
    E(
      "p",
      "Первый аккаунт настраивает владелец сервера. Общего пароля и публичной регистрации нет.",
      "muted",
    ),
  );
  f.addEventListener("submit", (event) => {
    event.preventDefault();
    run(async () => {
      user = (
        await api("/api/login", "POST", Object.fromEntries(new FormData(f)))
      ).user;
      await load();
    }, submit);
  });
  screen.append(f);
}
async function load() {
  state = await api("/api/state");
  active = active || productMeta.defaultSection;
  render();
}
function render() {
  chrome();
  const c = config.collections.find((x) => x.key === active);
  const heading = E("div", undefined, "collection-heading"),
    title = E("div", undefined, "collection-title");
  title.append(
    E("h1", productMeta.headings[active]?.[0] || c.title),
    E("p", productMeta.headings[active]?.[1] || c.description || config.description, "page-description"),
  );
  heading.append(title);
  screen.replaceChildren(heading);
  const controls = E("div", undefined, "actions collection-actions");
  if (!c.createDisabled && (c.writeRole !== "admin" || user.role === "admin"))
    controls.append(
      button(c.addLabel || "Добавить запись", () => edit(c), "primary"),
    );
  controls.append(button("Обновить", load));
  heading.append(controls);
  const toolbar = E("div", undefined, "collection-toolbar");
  const search = E("div", undefined, "search-tools");
  const q = input(search, "search", "Поиск по записям", query, "search", false);
  q.placeholder = "Название, код или связанная запись";
  q.addEventListener("input", () => {
    query = q.value;
    renderRows();
  });
  const archivedLabel = E("label", "Показать архив", "archive-toggle"),
    toggle = E("input");
  toggle.type = "checkbox";
  toggle.checked = showArchived;
  toggle.style.width = "auto";
  toggle.addEventListener("change", () => {
    showArchived = toggle.checked;
    renderRows();
  });
  archivedLabel.prepend(toggle);
  toolbar.append(search, archivedLabel);
  screen.append(toolbar);
  const holder = E("section");
  holder.id = "records";
  screen.append(holder);
  renderRows();
  const summary = E("details", undefined, "computed-panel");
  summary.append(E("summary", "Сводка сохранённых данных"));
  for (const block of state.computed || []) {
    const entry = E("div", undefined, "entry");
    entry.append(E("h3", block.title));
    for (const line of block.lines || []) entry.append(E("p", line));
    summary.append(entry);
  }
  if (!state.computed?.length)
    summary.append(
      E("p", "Расчёт появится после сохранения записей.", "muted"),
    );
  screen.append(
    summary,
    E(
      "small",
      "Данные сохраняются на вашем сервере. Архив сохраняет историю. Снимайте резервные копии.",
    ),
  );
}
function displayValue(field, row) {
  const value = row[field.key];
  if (field.type === "reference") {
    const definition = config.collections.find((c) => c.key === field.ref);
    const reference = state.data[field.ref].find((r) => r.id === value);
    return reference
      ? reference[definition.labelField || definition.fields[0].key]
      : "Связь не найдена";
  }
  if (field.type === "select") {
    const option = field.options.find(
      (x) => (typeof x === "string" ? x : x.value) === value,
    );
    return typeof option === "string" ? option : option?.label || value;
  }
  if (field.type === "datetime" && value)
    return (
      value.slice(0, 16).replace("T", " ") +
      " " +
      (value.match(/[+-]\d\d:\d\d$/)?.[0] || "UTC")
    );
  if (field.type === "answers") {
    const form = state.data.forms.find((f) => f.id === row.form);
    const questions = (form?.questions || "")
      .split("\n")
      .filter((q) => q.trim());
    return JSON.parse(value)
      .map((answer, i) => (questions[i] || "Ответ " + (i + 1)) + ": " + answer)
      .join("\n");
  }
  return value;
}
function renderRows() {
  const navigate = key => { active=key; query=''; showArchived=false; render(); const heading=screen.querySelector('h1');if(heading){heading.tabIndex=-1;heading.focus();} };
  workspaceGuide(screen,{config,state,active,journey,navigate});

  const c = config.collections.find((x) => x.key === active),
    host = document.getElementById("records");
  host.replaceChildren();
  screen.querySelector(".agenda-filters")?.remove();
  screen.querySelector(".collection-toolbar")?.classList.remove("has-product-filters");
  const values = state.data[c.key].filter(
    (x) =>
      (showArchived || !x.archived) &&
      (
        JSON.stringify(x) +
        " " +
        c.fields.map((field) => displayValue(field, x)).join(" ")
      )
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  recordSummary(host,values.length,state.data[active].length);
  if (!values.length) {
    emptyRecords(host,{config,state,active,query,journey,navigate,create:()=>edit(c),clear:()=>{query='';showArchived=true;render();},canCreate:!c.createDisabled&&(!c.writeRole||user.role==='admin')});
    return;
  }
  if (productView({ host, key: c.key, rows: values, data: state.data,
    open: (key, row) => edit(config.collections.find(item => item.key === key), row) })) return;
  const wrap = E("div", undefined, "table-wrap"),
    table = E("table"),
    head = E("thead"),
    tr = E("tr");
  wrap.tabIndex = 0;
  wrap.setAttribute(
    "aria-label",
    "Таблица записей. Если столбцы не помещаются, прокрутите вправо.",
  );
  for (const field of c.fields.slice(0, 5)) tr.append(E("th", field.label));
  tr.append(E("th", "Действия"));
  head.append(tr);
  table.append(head);
  const body = E("tbody");
  for (const row of values) {
    const r = E("tr");
    for (const field of c.fields.slice(0, 5)) {
      let value = displayValue(field, row);
      if (field.type === "answers") {
        const cell = E("td");
        const form = state.data.forms.find((f) => f.id === row.form);
        const questions = (form?.questions || "")
          .split("\n")
          .filter((q) => q.trim());
        JSON.parse(row[field.key]).forEach((answer, index) =>
          cell.append(
            E(
              "p",
              (questions[index] || "Ответ " + (index + 1)) + ": " + answer,
            ),
          ),
        );
        r.append(cell);
      } else
        r.append(
          E("td", String(value ?? "—") + (row.archived ? " · Архив" : "")),
        );
    }
    const actions = E("td");
    actions.append(button("Открыть", () => edit(c, row)));
    r.append(actions);
    body.append(r);
  }
  table.append(body);
  wrap.append(table);
  host.append(
    E(
      "p",
      "На узком экране прокрутите таблицу вправо: там остальные столбцы и действия.",
      "table-hint",
    ),
    wrap,
  );
  labelTable(host);
}
function edit(c, row) {
  const editingRevision = state.revision;
  screen.replaceChildren(
    E("h1", row ? "Изменить: " + c.title : c.addLabel || "Новая запись"),
    E(
      "p",
      c.hint ||
        "Заполните обязательные поля. Сервер проверит связанные записи и ограничения до сохранения.",
    ),
  );
  const context = editorContext({ collection: c, row, data: state.data,
    open: (key, record) => edit(config.collections.find(item => item.key === key), record) });
  if (context) screen.append(context);
  const form = E("form", undefined, "panel record-form");
  for (const field of c.fields) {
    let value = row?.[field.key] ?? field.default ?? "";
    if (["select", "reference"].includes(field.type)) {
      const label = E("label", field.label),
        select = E("select");
      select.name = field.key;
      select.required = field.required !== false;
      select.id = "input-" + ++sequence;
      label.htmlFor = select.id;
      select.append(new Option("Выберите значение", ""));
      const options =
        field.type === "reference"
          ? state.data[field.ref]
              .filter((x) => !x.archived || (row && x.id === value))
              .map((x) => ({
                value: x.id,
                label:
                  x[
                    config.collections.find((c) => c.key === field.ref)
                      .labelField ||
                      config.collections.find((c) => c.key === field.ref)
                        .fields[0].key
                  ] + (x.archived ? " · Архив" : ""),
              }))
          : field.options.map((x) =>
              typeof x === "string" ? { value: x, label: x } : x,
            );
      for (const option of options)
        select.append(new Option(option.label, option.value));
      select.value = value;
      if (field.readOnly && row) select.disabled = true;
      form.append(label, select);
    } else if (field.type === "answers") {
      const hidden = E("input");
      hidden.type = "hidden";
      hidden.name = field.key;
      hidden.value = value;
      form.append(hidden, E("h2", field.label));
      const sourceForm = state.data.forms.find((f) => f.id === row.form);
      const questions = (sourceForm?.questions || "")
        .split("\n")
        .filter((q) => q.trim());
      JSON.parse(value).forEach((answer, index) =>
        form.append(
          E("h3", questions[index] || "Ответ " + (index + 1)),
          E("p", answer),
        ),
      );
    } else if (field.type === "datetime") {
      input(
        form,
        field.key + "__local",
        field.label,
        value ? value.slice(0, 16) : "",
        "datetime-local",
      );
      const label = E("label", "Часовой пояс: " + field.label),
        select = E("select");
      select.name = field.key + "__zone";
      select.id = "input-" + ++sequence;
      label.htmlFor = select.id;
      for (let minutes = -720; minutes <= 840; minutes += 15) {
        const sign = minutes < 0 ? "-" : "+";
        const absolute = Math.abs(minutes),
          zone =
            sign +
            String(Math.floor(absolute / 60)).padStart(2, "0") +
            ":" +
            String(absolute % 60).padStart(2, "0");
        select.append(new Option("UTC" + zone, zone));
      }
      select.value = value
        ? value.match(/[+-]\d\d:\d\d$/)?.[0] || "+00:00"
        : "+05:00";
      form.append(label, select);
    } else {
      const type =
        field.type === "textarea"
          ? "textarea"
          : ["integer", "number", "money"].includes(field.type)
            ? "number"
            : ["email", "date", "url"].includes(field.type)
              ? field.type
              : "text";
      const e = input(
        form,
        field.key,
        field.label,
        value,
        type,
        field.required !== false,
      );
      if (field.readOnly && row) e.readOnly = true;
      if (type === "number") {
        e.step = field.type === "integer" ? "1" : "0.01";
        e.min = field.min ?? 0;
        e.max = field.max ?? 1000000000;
      }
      if (field.placeholder) e.placeholder = field.placeholder;
      if (field.maxLength) e.maxLength = field.maxLength;
    }
    if (field.help) form.append(E("small", field.help));
  }
  const actions = E("div", undefined, "actions"),
    submit = E("button", "Сохранить");
  submit.type = "submit";
  submit.classList.add("primary");
  if (row?.archived || (c.writeRole === "admin" && user.role !== "admin"))
    submit.disabled = true;
  actions.append(submit, button("Вернуться", render));
  if (row && !row.archived && user.role === "admin")
    actions.append(
      button("В архив", async () => {
        state = await api("/api/command", "POST", {
          operation: "archive",
          collection: c.key,
          id: row.id,
          revision: editingRevision,
        });
        render();
      }),
    );
  form.append(actions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run(async () => {
      const data = Object.fromEntries(new FormData(form));
      for (const field of c.fields.filter((x) => x.readOnly))
        if (row) data[field.key] = row[field.key];
      for (const field of c.fields.filter((x) => x.type === "datetime")) {
        data[field.key] =
          data[field.key + "__local"] + ":00" + data[field.key + "__zone"];
        delete data[field.key + "__local"];
        delete data[field.key + "__zone"];
      }
      state = await api("/api/command", "POST", {
        operation: "save",
        collection: c.key,
        id: row?.id,
        revision: editingRevision,
        data,
      });
      render();
      message("Запись сохранена.");
    }, submit);
  });
  screen.append(form);
  const heading = screen.querySelector("h1");
  heading.tabIndex = -1;
  heading.focus();
  if (row && config.collections.find((x) => x.key === active).publicLinks) {
    const link = E("a", "Открыть публичную форму");
    link.href = location.origin + "/#public=" + row.id;
    link.target = "_blank";
    link.rel = "noopener";
    screen.append(E("p"));
    screen.lastChild.append(link);
  }
  if (row) {
    const details = E("details"),
      summary = E("summary", "История записи");
    details.append(
      summary,
      E(
        "p",
        `Создал: ${row.createdBy} · ${new Date(row.createdAt).toLocaleString()} · Изменено: ${new Date(row.updatedAt).toLocaleString()}`,
      ),
    );
    screen.append(details);
  }
}
function accountSessions(report) {
  const panel = E('section', undefined, 'panel account-sessions'),
    header = E('div', undefined, 'account-session-heading'),
    refreshButton = E('button', 'Обновить сеансы', 'secondary'),
    status = E('p', 'Загрузка аккаунтов и сеансов…', 'muted account-session-status'),
    list = E('div', undefined, 'account-session-list');
  refreshButton.type = 'button';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  header.append(E('h2', 'Аккаунты и сеансы'), refreshButton);
  panel.append(header, E('p', 'Отзыв завершает вход в браузерах выбранного аккаунта. Для вашего аккаунта текущий сеанс всегда сохраняется. Пароли и роли здесь не меняются.', 'muted'), status, list);
  screen.append(panel);
  let requestNumber = 0;
  const stamp = value => new Date(value).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  async function refresh() {
    const current = ++requestNumber;
    status.textContent = 'Обновление сведений о сеансах…';
    try {
      const result = await api('/api/accounts');
      if (current !== requestNumber || !panel.isConnected) return;
      list.replaceChildren();
      for (const account of result.users) {
        const row = E('article', undefined, 'account-session-row'),
          detail = E('div'),
          label = account.isCurrentUser ? 'Завершить другие сеансы' : 'Завершить все сеансы',
          revoke = E('button', label, 'secondary');
        detail.append(E('h3', account.name + (account.isCurrentUser ? ' · ваш аккаунт' : '')), E('p', (account.role === 'admin' ? 'Администратор' : 'Сотрудник') + ' · действующих сеансов: ' + account.activeSessions));
        const expiry = !account.activeSessions ? 'Действующих сеансов нет.' : account.earliestExpiry === account.latestExpiry ? 'Истечение: ' + stamp(account.latestExpiry) : 'Истечение сеансов: от ' + stamp(account.earliestExpiry) + ' до ' + stamp(account.latestExpiry);
        detail.append(E('small', expiry));
        revoke.type = 'button';
        revoke.setAttribute('aria-label', label + ': ' + account.name);
        revoke.disabled = account.activeSessions <= (account.isCurrentUser ? 1 : 0);
        revoke.addEventListener('click', () => run(async () => {
          revoke.textContent = 'Завершение…';
          try {
            const result = await api('/api/accounts/revoke-sessions', 'POST', {username: account.name});
            await confirmMutation('Завершено действующих сеансов: ' + result.revoked + ' · ' + result.username + (result.keptCurrent ? '. Ваш текущий сеанс сохранён.' : '.'));
          } finally { revoke.textContent = label; }
        }, revoke));
        row.append(detail, revoke);
        list.append(row);
      }
      status.textContent = 'Обновлено: ' + stamp(result.serverTime) + '. Ваш текущий сеанс истекает: ' + stamp(result.currentSessionExpires) + '.';
    } catch (error) {
      if (current === requestNumber && panel.isConnected) status.textContent = 'Не удалось загрузить сведения. Повторите кнопкой «Обновить сеансы».';
      throw error;
    }
  }
  async function confirmMutation(confirmation) {
    // The write is committed; a read failure must not turn it into a failed write.
    list.replaceChildren();
    report(confirmation);
    try { await refresh(); }
    catch {
      report(confirmation + ' Список аккаунтов и сеансов не обновлён. Нажмите «Обновить сеансы» или войдите снова.', true);
    }
  }
  accountSessions.refresh = refresh;
  accountSessions.afterMutation = confirmMutation;
  refreshButton.addEventListener('click', () => run(refresh, refreshButton));
  run(refresh, refreshButton);
}

function settings() {
  screen.replaceChildren(E("h1", "Данные и доступ"));
  const actions = E("div", undefined, "actions");
  actions.append(button("Вернуться", render));
  screen.append(actions);
  if (user.role !== "admin") {
    screen.append(
      E("p", "Копии и создание сотрудников доступны администратору."),
    );
    return;
  }
  accountSessions(message);
  screen.append(
    button("Скачать копию данных", async () =>
      download(config.slug + "-backup.json", await api("/api/backup")),
    ),
  );
  const label = E("label", "Восстановление в пустую базу"),
    file = E("input");
  file.type = "file";
  file.accept = ".json,application/json";
  label.append(file);
  screen.append(label);
  file.addEventListener("change", () =>
    run(async () => {
      if (!file.files[0]) return;
      const copy = JSON.parse(await file.files[0].text());
      const preview = E("section", undefined, "panel");
      preview.append(
        E("h2", "Проверка копии"),
        E("p", "Продукт: " + copy.product),
      );
      for (const [name, values] of Object.entries(copy.data || {}))
        preview.append(
          E(
            "p",
            name +
              ": " +
              (Array.isArray(values) ? values.length : "неверный раздел"),
          ),
        );
      preview.append(
        button("Восстановить эту копию", async () => {
          state = await api("/api/restore", "POST", copy);
          render();
          message("Копия восстановлена в пустую базу.");
        }),
      );
      screen.append(preview);
    }),
  );
  screen.append(
    E(
      "p",
      "Восстановление не заменяет существующие данные. Полная копия аккаунтов требует защищённого резервного копирования SQLite на сервере.",
      "muted",
    ),
  );
  const form = E("form", undefined, "panel");
  form.append(E("h2", "Новый сотрудник"));
  input(form, "username", "Имя латиницей");
  const pass = input(form, "password", "Пароль от 14 символов", "", "password");
  pass.minLength = 14;
  const submit = E("button", "Создать сотрудника");
  submit.type = "submit";
  submit.classList.add("primary");
  form.append(submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run(async () => {
      await api("/api/users", "POST", {
        ...Object.fromEntries(new FormData(form)),
        role: "operator",
      });
      form.reset();
      await accountSessions.afterMutation("Сотрудник создан. Передайте пароль защищённым способом.");
    }, submit);
  });
  screen.append(
    form,
    button("Показать последние 300 изменений", async () => {
      const result = await api("/api/audit");
      const details = E("details"),
        summary = E("summary", "Журнал изменений"),
        pre = E("pre", JSON.stringify(result.events, null, 2));
      details.append(summary, pre);
      details.open = true;
      screen.append(details);
    }),
  );
}
async function publicView(id) {
  const form = await api("/api/public/" + id);
  document.getElementById("brand").textContent = config.title;
  document.title = form.title + " — " + config.title;
  screen.replaceChildren(E("h1", form.title), E("p", form.description));
  navigation.replaceChildren();
  const f = E("form", undefined, "panel");
  for (const field of form.fields) {
    const e = input(
      f,
      field.key,
      field.label,
      "",
      field.type || "text",
      field.required !== false,
    );
    if (field.type === "number") {
      e.min = field.min ?? 1;
      e.max = field.max ?? 10000;
      e.step = "1";
    }
  }
  const submit = E("button", "Отправить");
  submit.type = "submit";
  submit.classList.add("primary");
  f.append(E("div", undefined, "actions"));
  f.lastChild.append(submit);
  f.addEventListener("submit", (event) => {
    event.preventDefault();
    run(async () => {
      const receipt = await api(
        "/api/public/" + id,
        "POST",
        Object.fromEntries(new FormData(f)),
      );
      screen.replaceChildren(
        E("h1", "Заявка сохранена"),
        E("p", "Номер: " + receipt.id),
      );
      if (receipt.total)
        screen.append(
          E(
            "p",
            "Предварительный расчёт: " + receipt.total + " " + receipt.currency,
          ),
          E("p", receipt.note || "Объём и условия согласуются отдельно."),
        );
    }, submit);
  });
  screen.append(
    f,
    E(
      "p",
      "Форма отправляет сведения владельцу этого сервера. Не отправляйте пароли, платёжные реквизиты или личные документы.",
      "muted",
    ),
  );
}
const loadingState = E("p", "Загрузка рабочего пространства…", "muted");
loadingState.dataset.loading = "true";
loadingState.setAttribute("role", "status");
screen.replaceChildren(loadingState);
run(async () => {
  config = await api("/api/config");
const requestedSection=new URLSearchParams(location.hash.slice(1)).get('section');if(config.collections.some(collection=>collection.key===requestedSection))active=requestedSection;
for(const [key,label] of Object.entries({"properties": "Добавить объект", "stays": "Добавить заезд", "tasks": "Назначить подготовку"})){const collection=config.collections.find(item=>item.key===key);if(collection&&!collection.addLabel)collection.addLabel=label;}
  const id = location.hash.startsWith("#public=") ? location.hash.slice(8) : "";
  if (id) {
    await publicView(id);
    return;
  }
  user = (await api("/api/session")).user;
  if (user) await load();
  else login();
});
