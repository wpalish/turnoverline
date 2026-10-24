import {
  F,
  S,
  R,
  C,
  live,
  rows,
  byId,
  unique,
  required,
  minor,
  amount,
  interval,
  noOverlap,
  changed,
  immutable,
  admin,
  totalLines,
  summary,
  clock,
  label,
} from "./core/rules.js";
const definition = {
  slug: "turnoverline",
  reference: 77,
  title: "TurnoverLine",
  description:
    "Уборка и обслуживание между заездами с проверкой окна до следующего гостя. Без OTA-интеграций.",
  limitations:
    "Одна организация · Собственный сервер · Ручной ввод · Без банковских и внешних интеграций",
  collections: [
    C("properties", "Объекты", [
      F("name", "Объект"),
      F("note", "Инструкция", "textarea", { required: false }),
    ]),
    C(
      "stays",
      "Заезды",
      [
        R("property", "Объект", "properties"),
        F("code", "Код бронирования без паспорта"),
        F("start", "Заезд", "datetime"),
        F("end", "Выезд", "datetime"),
        S("status", "Состояние", [
          ["booked", "Запланирован"],
          ["cancelled", "Отменён"],
        ]),
      ],
      { labelField: "code" },
    ),
    C("tasks", "Подготовка", [
      R("stay", "После какого заезда", "stays"),
      F("task", "Работа"),
      F("assignee", "Ответственный"),
      F("due", "Срок", "datetime"),
      S("status", "Состояние", [
        ["open", "Открыта"],
        ["done", "Выполнена"],
      ]),
    ]),
  ],
  validate(state, before, command, actor) {
    unique(rows(state, "stays"), "code", "Код заезда");
    noOverlap(
      rows(state, "stays"),
      "property",
      "start",
      "end",
      (x) => x.status !== "cancelled",
    );
    for (const t of live(state, "tasks")) {
      const stay = byId(state, "stays", t.stay);
      required(
        Date.parse(t.due) >= Date.parse(stay.end),
        "Подготовка должна быть после выезда.",
      );
      const next = rows(state, "stays")
        .filter(
          (s) =>
            s.property === stay.property &&
            s.status !== "cancelled" &&
            Date.parse(s.start) >= Date.parse(stay.end),
        )
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
      if (next)
        required(
          Date.parse(t.due) <= Date.parse(next.start),
          "Работа не помещается до следующего заезда.",
        );
    }
  },
  summarize(state) {
    return rows(state, "stays").map((s) =>
      summary(
        s.code + " · " + byId(state, "properties", s.property).name,
        ...live(state, "tasks")
          .filter((t) => t.stay === s.id)
          .map(
            (t) =>
              t.task +
              " · " +
              t.assignee +
              " · " +
              clock(t.due) +
              " · " +
              label(definition, "tasks", "status", t.status),
          ),
        "Готовность проверяется по реальным отметкам исполнителя, без автоматического заселения.",
      ),
    );
  },
};
export default definition;
