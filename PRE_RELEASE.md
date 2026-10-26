# TurnoverLine · pre-release candidate

26 October 2026. Implemented and locally verified for the scoped workflows below. Draft PR only; no merge or deployment. This is a local candidate for review, with operational release checks still required.

## Product changes

Работы сгруппированы по объекту и окну выезд→следующий заезд. Открытая подготовка идёт первой по сроку; завершённые и архивные группы отделены в историю. Инструкция и ответственный связаны с реальной задачей.

Design direction: **Диспетчер передачи объекта между заездами**. Current visual decisions and tokens are in DESIGN.md. Actions share the heading, search/archive/count share a toolbar, and workflow help follows primary records. UI uses actual saved data.

## Verified

- Node 24.19.0 design-increment suite (historical): **9/9 passed**, zero failed/skipped/cancelled; JavaScript syntax and whitespace checks passed.
- Browser: Срок после следующего заселения отклонён, форма осталась открыта. После исправления срока задача сохранена как выполненная. Основной экран проверен с открытыми задачами и отдельной завершённой историей.
- Captured and inspected at 390×844, 768×1024 and 1440×1000. No page-level horizontal overflow on the captured working screens. Visible button/input/select/summary targets measured at least44px high (native check/radio controls are checked through their labelled hit areas).
- Visible keyboard focus and no-result search/reset were checked in the nine server workspaces. Computed text contrast on captured primary screens met4.5:1 for normal /3:1 for large text; this is a scoped check, not a complete accessibility certification.
- New browser modules load through an exact static allowlist. Existing domain, role, CSRF, origin, revision, persistence and restore suites remain passing. Stale commands return **HTTP400**, not409.

Evidence is in the parent task's outputs/pre-release/evidence/turnoverline/, test log and machine-readable checks. Browser fixtures use synthetic data; HTTP fixture checks and UI checks are recorded separately. No external operational outcome is inferred.

## Remaining release checks

Выполнение — ручная отметка сотрудника, которая не подтверждает готовность объекта или заселение.

Before a real pilot: configure and verify production HTTPS/origin/session cookie settings, hosting/restart behavior, backup and restore on the actual host, account/access procedures and retention. Screen-reader testing, real-device touch/zoom, OS reduced-motion emulation, initial-network-failure injection and load testing were not performed in this increment. For the browser-only SabaqLoop, validate browser storage/export and device policy instead of server deployment settings. Existing limits in README.md and PRODUCT.md apply.

## Design review

Apple-design, frontend-ui-engineering, Impeccable and interface-polish guidance informed this increment. The mechanical style detector produced suggestions for redundant side stripes and warm palettes. Stripes in the server workspaces were thinned/removed; three deliberate product palettes were retained after contrast checks. The detector output is preserved; it is not reported as a zero-warning scan. No new dependency or external service is required.

## Запуск, доступ и полная копия · 26 октября 2026

- Свежий полный прогон: **35/35**, без failed/skipped/cancelled; [лог](docs/release-hardening/test-output.txt), [машинная проверка](docs/release-hardening/verification.json). Внешние npm-зависимости не добавлены; схема пяти таблиц сохранена.
- Добавлены read-only preflight, проверка Node/Origin/bind/production path/владельца и приватности каталога, основной БД и WAL/SHM/journal, umask0077, безопасные ошибки запуска и управляемое завершение HTTP/SQLite. Реальный file-based холодный запуск → health → SIGTERM → перезапуск сохранил вход/сеанс. HTTPS-origin cookie проверена через локальный backend с ожидаемым Host; реальный TLS здесь не поднимался.
- Администратор видит аккаунты, действующие сеансы и UTC-сроки; отзыв защищён Origin/CSRF/ролью, сохраняет текущий собственный сеанс и записывает аудит без токенов. В CUA отозваны два синтетических сеанса, список обновился до0, обе прежние cookie получили401; вход текущего администратора сохранился. [1440px](docs/release-hardening/accounts-desktop.png), [390px](docs/release-hardening/accounts-mobile.png). Кнопки от44px, переполнения страницы на этих экранах нет.
- Подтверждённая сервером операция остаётся подтверждённой при отказе последующего GET: старые действия убраны, предупреждение отделено от результата; повтор списка не повторяет POST. Orta/Dalel обрабатывают401 возвратом к входу без reload; это дополнительно проверено в CUA для этих двух продуктов.
- Полная online SQLite backup → restore в новый файл проверена на существующей синтетической QA-базе: все пять таблиц совпали со снимком, предметные записи/ревизия/история сохранены; прежний вход, health и cookie после перезапуска восстановленной копии работают. Аккаунты/сеансы/аудит входят в SQLite, а не в UI JSON. Копии0600, без шифрования/подписи; hard-link/fsync/POSIX требуются. Сами БД и секреты не включены в отчёт или sourceZIP.

Команды, различие JSON/SQLite, безопасный перенос и границы — [OPERATIONS.md](OPERATIONS.md). Шаблоны Caddy/systemd поставлены, не установлены и не исполнялись. На целевом хосте остаются DNS/TLS, синтаксическая проверка конфигурации/службы, доступ извне, restore/cutover, retention и реальные правила доступа. Сброса пароля/отключения пользователя нет: отзыв сеансов не мешает повторному входу с прежним паролем. Screen reader, реальные touch/zoom и нагрузка не проверялись.
