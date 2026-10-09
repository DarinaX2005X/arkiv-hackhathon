# Состояние Partfolk
Phase: build
Approval: approved
Active stage: 04
Active task: 04.1

## Граница сессии

Пользователь9October2026 попросил завершить уже начатый функционал и переработку дизайна по десяти референсам, затем остановиться до его сообщения завтра. Уточнение: «цвет не имеет значения я про стиль». Новые этапы, реальные product broadcasts и deployment сегодня не выполняются. Автоматический запуск/напоминание не назначены. Полный утверждённый масштаб сохраняется.

Все работники передали текущие пути MAIN и остановили редактирование. MAIN завершает единый проверяемый checkpoint и push в уже авторизованный private origin; результат команды хранится в .vibemachina/runtime/checks и Git HEAD. После этого работа ждёт нового сообщения пользователя.

## Текущая реализация

01–03 связаны в работающий продукт: отдельные practice/custom/public runtimes, прямой Arkiv reader/writer, проекты и предложения, exact agreement, run sheet/returns/repair/export/reuse, самостоятельная сборка contributor view и CLI. Предыдущий code checkpoint876e5eda13388b78c58aaba6ab9ada02e7d5d08c прошёл общий gate и pushed.

Сегодня завершены текущие исправления: полный read-only просмотр потребностей до плана; сохранение visitor/wallet drafts при переходах; безопасное копирование только editable recipe в public draft; восстановление unreadable request из валидного backup с проверкой original operation; возобновление partial-reverted публикации с сохранением подтверждённой identity; chronological equipment conservation и task/requirement binding; ограниченный solver budget; последовательные timestamps локальной practice; review ALL book heads без latest-wins и union сохранением promises/work/custody; owner root/book renewal.

Guided example выполняет пять настоящих локальных действий: Oak делает план возможным, каждый sample owner согласует P1, Oak отзывает согласие, Juniper позволяет P2, все дают fresh P2 decisions. Перезагрузка и повтор действий сохраняют состояние; custom/public namespaces не затрагиваются. Полный ручной проект остаётся доступен отдельно. Public views читают каждые15s/приfocus с одним in-flight запросом и expiry confidence после60s; ошибки оставляют stale данные.

DESIGN обновлён: светлые мягкие объёмные поверхности, согласованные грани/свет/тени, округлые кнопки и утопленные поля, исходная SVG-сцена выставки. Палитра не копируется из референсов. Навигация проекта Plan/People/Run sheet; история/идентификаторы под More; contributor view под брендом Partfolk. Landing даёт одно главное действие. V01–V07 реализованы в исходниках, но визуальная приёмка пользователем ещё не подтверждена.

## Проверки и доказательства

TypeScript и целевые suites workers passed; общий checkpoint запускает полную unit suite,19 bootstrap guards, отдельный helper TypeScript,42 safety tests,92 helper tests и обе production builds. Отдельный HTTP контроль проверяет доступность server/assets; он не является browser/UI QA. Existing shared bundle-size warning требует помнить о размере загрузки, сборку не ломает.

tests/arkiv-live/runner.ts и README готовы как код для следующей сессии. Никакой invocation runner, initialization публичных signer files или product send сегодня не выполнялись. Сценарий имеет explicit phase/count, clean reviewed HEAD, frozen commands/journal/hash, independent same-block fresh CLI и общий предел0.1testGLM. Planned92sends по фазам. Перед первым использованием MAIN читает runner/safety и выполняет readonly/estimate; реальные записи только MAIN после проверки, без автоматического перехода между фазами.

Существуют только прежние capability evidence: bootstrap tx0xd9a9eb50a203afc13c5a28df1707eca01c66fab19837eacb91c72e11c22b2ba3; atomic A create block352006 и A→B block352065; stale-A estimate rejected. Потрачено0.000326176000652352testGLM. Продуктовое публичное P1→withdraw→P2→P3 доказательство ещё НЕ выполнено. .local secrets/journals ignored, никогда не печатать/коммитить.

MIT LICENSE, docs/protocol.md, docs/operations.md готовы. Финальный README, clean checkout, итоговый независимый review, hosting и внешний submission draft ещё предстоят.

## Продолжение после сообщения пользователя

1. Прочитать весь TESTING и новые замечания пользователя. Не начинать новую работу автоматически.
2. Проверить Git HEAD, процессы и текущие адреса; сохранить полный scope и новую дизайн-систему. Не переделывать уже завершённый код без новой причины.
3. Закончить04: read-only review/run будущего public proof helper, реальные public lifecycle/evidence под имеющимся capped authorization, fresh independent Desk/CLI при выключенном Studio. Обновить canonical facts доказательством.
4. Закончить05: независимый code review и сравнение с original brief, исправить подтверждённые дефекты.
5. Закончить06: substantial README, clean clone launch, конкретный deployment artifact/provider login, HTTPS/API verification, внешний devfolio/ANSWERS и сценарий видео. Пользователь самостоятельно делает визуальную проверку, открывает GitHub visibility и отправляет Devfolio.

## Постоянные ограничения и сервисы

Продукт English-only. Русский чат/planning допустимы. Пользователь полностью владеет visual/browser testing: никакого CUA/browsercontrol/Playwright/Selenium/Puppeteer/headless/renderers/screenshots/UI automation и автоматических tabs. Это относится ко всем работникам.

Open Source primary + Censorship Resistance secondary; claim ограничен независимостью от Studio host/API, не от Arkiv/RPC/indexer и полномочий владельцев. Артефакты/тексты не утверждают реальные физические события или пользователей.

Последние адреса: Studio http://127.0.0.1:5173/ ; standalone contributor view http://127.0.0.1:4174/desk.html ; VibeMachina dashboard http://127.0.0.1:4177/ . Vite standalone preview обслуживает dist-desk после последней сборки. Пользователь открывает ссылки самостоятельно. Deployment отсутствует; Vercel global shim существует, но target module отсутствует, authentication пока не проверена рабочим CLI. Не выдавать local URLs за public demo.

Product/Git folder arkiv/; внешние исходные instructions/research/devfolio остаются за его пределами. MAIN owns Git/checkpoints/integration и broadcasts. Existing private origin push разрешён; user owns GitHub public visibility/final submission.
