# 03 Провести проект, согласовать изменения и повторить удачную работу
Status: done

Этап завершает человеческую работу после найденного плана: участники выполняют свои части, передают и возвращают оборудование, восстанавливают оставшуюся работу после отзыва, фиксируют фактический итог и начинают новый проект на основе рецепта. Отдельный Partner Desk позволяет библиотеке или мастерской управлять своими предложениями через другой клиент в обычной работе. Лендинг и справка делают эти возможности понятными без знания Arkiv.

Общие ownership, protocol, UI, locale, consent и verification правила из начала этапа 02 применяются без изменения. MAIN переносит их один раз в общий канонический PLAN, а не размножает отдельные источники истины в каждом stage file. Задачи ниже не дают работникам права на общие пути.

## 03.1 Провести проект, заменить выбывший вклад и сохранить честный итог
Status: done
Requirements: R06, R09, R10, R11, R12, R13
Depends on: 01.1, 01.2, 01.3, 02.1, 02.2
Owner: SUBAGENT to assign
Paths: src/features/execution/

Пользовательский результат: organizer и contributors используют единый runbook, отмечают работу и подтверждают handover/return каждый со своей стороны, исправляют план после withdrawal, закрывают проект с видимыми незавершенными пунктами и переиспользуют его recipe без старых обещаний. Scope включает export выбранного текущего/исторического плана с честным статусом; не включает юридический арбитраж или физическую гарантию.

Входы: exact agreed/proposed/stale plan revision, execution records и actor из common context; withdrawal context из 02.2; текущие доступные offers и foundation repair operation. Выходы: owner-authored progress/acknowledgement records, новый proposed remaining-work plan, completion/cancellation result, validated reusable project draft и реальные экспортные файлы. Executor не исправляет consensus самостоятельно, не создает альтернативную модель задач и не маркирует чужую работу выполненной от чужого имени.

State contract: еще нет agreed plan; awaiting consent; ready runbook; network status unverified; in progress; assignment reported done; awaiting other party acknowledgement; confirmed handover; outstanding return; withdrawn contribution; repair impossible/found/proposed/awaiting all; completion review; completed with outstanding items; cancelled. Completion не должна требовать лжи ради возможности закрыть проект.

### 03.1.1 Превратить согласованный план в ясные действия и двустороннюю передачу
Status: done

1. Построить runbook по фактическим времени, роли, ресурсам и dependencies из canonical model. **Мои задачи** фильтрует без потери ссылки на общий план. Нет универсального Kanban board или выдуманного таймлайна.
2. Показать exact version и актуальность проверки. Если текущие ссылки нельзя проверить, оставить last-known data с датой и явным статусом. Для proposed/stale версии не показывать подтвержденную готовность лишь из-за просмотра route.
3. Подключить допустимые actor progress commands. Собственное **Выполнено** означает self-report в пределах доменной модели; оно не заменяет согласие второго человека.
4. Для выдачи и возврата borrowed equipment показать две стороны: reported handover и recipient acknowledgement. Кто, что и на какой stage подтверждает, берется из плана. Кто-то отметил выдачу, но другой еще не подтвердил получение — отдельный постоянный статус, не исчезающий toast.
5. После mutation обновить assignment, resource status и project summary через общие state/invalidation rules. Unknown outcome остается незавершенной проверкой и не разрешает blind duplicate acknowledgement.

Проверка: presenter/controller tests проверяют порядок/группировку реальных временных данных, own-only commands, отсутствие inferred receiver ack, разные состояние given/received/returned, и unchanged historical content. Typecheck, execution feature tests, build. Domain-owned dual-ack invariants не копируются в feature; fixtures проходят через их реальный resolver.

Checkpoint: usable runbook и complete one-resource handover/return sequence. Пользователь проверяет, понимает ли разницу между «отправитель отметил» и «получатель подтвердил», а агент фиксирует только доказанные state transitions.

### 03.1.2 Восстановить оставшуюся работу после отзыва с новым согласием всех
Status: done

1. Принять withdrawal/change context и явно показать, какая потребность больше не покрыта. Сохранить уже выполненную работу и предыдущие agreement/progress records; отзыв не стирает факты исполнения.
2. **Найти замену** запускает общий repair solver над оставшейся работой и текущими offers. Сохранение прежних assignments является объясненным preference, а не разрешением на невозможный результат.
3. Для fixture Oak withdraw + Juniper installation показать рабочую перестановку Cedar на transport, Juniper на installation, Willow unchanged. Показать также случай без замены с конкретным отсутствующим ресурсом, без выдуманного нового участника.
4. Сравнить старый и новый remaining-work plan в реальных строках: добавленные/удаленные участники, смены ролей, сроки/количества и причины. Измененная версия передается общему proposal command и согласованию 02.2.
5. Новый required cohort начинает свежий цикл целиком. Все текущие участники, включая unchanged Library/Makerspace/hosts, должны принять exact revision; удаленный участник остается в history, а не в новом обязательном cohort. Completion/progress не разрешают скрыто переносить прежнее согласие.
6. При invalidated repair input сохранить выбранные предпочтения и предложить новый расчет. Не экспортировать прежний вариант как действующий repair. Cancellation calculation допустима только при поддержке общего controller.

Проверка: positive repair fixture дает complete replacement и нужный diff; withdrawal без Juniper не дает current-ready; already-completed installation сохраняет запись в mid-project scenario; all-party acceptance resets; поздний результат старого repair не заменяет новый input. Typecheck, feature tests, build и targeted foundation repair regression suite через согласованную команду MAIN.

Checkpoint: end-to-end withdrawal → honest gap → actual repair → new full consent loop. Закрытие невозможно, если **Найти замену** только открывает пустую форму или если неизмененные actors автоматически остаются accepted.

### 03.1.3 Закрыть работу с исключениями, выгрузить результат и начать следующий проект
Status: done

1. Completion review перечисляет выполненную/отмененную/оставшуюся работу и оборудование с confirmed/outstanding returns. Отдельно видны owner reports и acknowledgements; общая кнопка закрытия не производит чужие подтверждения.
2. Разрешить правдивые final outcomes по domain contract: completed, completed with outstanding items, cancelled. Cancellation release/update проходит через общий actor-authorized protocol; это не обещание удалить публичную историю.
3. **Использовать как основу** создает новый локальный draft с requirements, полезными конфигурациями и source reference. Сбросить даты согласно форме нового события, selected live assignments, old acceptances, progress и занятые интервалы. Прежние offers допустимы как ссылки для запроса актуального участия, но не брони.
4. Сделать реальные download/export действия через общую validated serialization: UTF-8 JSON package проекта/плана/результата и самостоятельный печатный HTML run sheet с локальными стилями, без внешних изображений и runtime-зависимостей. PDF generator не входит в эту задачу. Файл содержит версию, time zone, статус, assignments и исключения. Proposed/stale/unknown версия явно подписана как такая.
5. Download failure не показывает success. Доступный local draft export помогает восстановлению; данные проходят проверку при import в project path, и corrupt файл не частично превращается в якобы валидный план.
6. Возвращение к закрытому проекту восстанавливает фактический final record и outstanding items. Новый draft открывается в 02.1, с понятным источником и без потери своего предыдущего проекта.

Проверка: completion with one unacknowledged return сохраняет исключение; organizer не может выставить receiver ack; cancel records cancellation; owner release or exact expiry ends its hold according to PROTOCOL; recipe clone не переносит consent/assignments/progress; export round-trip сохраняет units, timezone, exact IDs/status и parsable UTF-8 English-only labels. Tests проверяют содержимое файла без визуального рендеринга. Typecheck, feature tests, build.

Checkpoint: whole execution job от runbook до reusable new draft. Handover содержит реальные экспортные примеры и ожидаемую структуру, не screenshot. UI печати и визуальная удобность экспорта ожидают пользовательской проверки.

## 03.2 Дать библиотеке и мастерской собственный независимый Partner Desk
Status: done
Requirements: R07, R08, R12, R13, R14
Depends on: 01.1, 01.2, 01.3, 02.2
Owner: SUBAGENT to assign
Paths: src/desk/, desk.html, vite.desk.config.ts

Пользовательский результат: партнер ведет собственные предложения и отвечает на запросы нескольких проектов в отдельном клиенте, не заходя в организационную панель коллективов и не дублируя данные в их аккаунтной базе. Library меняет availability Hall или принимает exact exhibition plan в Desk; project studio при чтении получает ту же owner-authored запись.

Независимость здесь часть ежедневного продукта. Client может разделять open-source schema/domain/adapters и переиспользовать presentation components 02.2, но сборка/точка входа запускаются отдельно и не обращаются к main application's backend/API ради чтения/авторства. Тот же Arkiv RPC является внешней общей инфраструктурой; не обещать независимость от сети или on-chain RPC. Demo/local/public boundaries остаются явными, никакой фальшивой имитации cross-client активности.

Writable paths только `src/desk/`, `desk.html`, `vite.desk.config.ts`. MAIN добавляет `build:desk`/serve scripts, зависимости и общие adapter factories в свои файлы. Worker не модифицирует `src/features/contributions/` параллельно и не импортирует main app entry/router/provider singleton. Требуемую shared extraction запрашивает у MAIN с конкретным contract diff.

Входы: own account, offer IDs, project/revision invite links и explicit mode. Результаты: те же protocol partfolk/1 entities/decisions и согласованная state presentation. Access не определяется display organization name. Error/read-only/ownership/missing reference/conflict/unknown transaction состояния совпадают по смыслу с main application.

### 03.2.1 Собрать отдельный вход и открыть текущие предложения партнера
Status: done

1. Создать standalone HTML/entry и Vite config, использующие выбранный foundation stack и shared tokens/fonts без копий. Собственный минимальный shell: Partfolk Partner Desk, аккаунт/режим, **Мои предложения** и **Запросы**.
2. Инициализировать repository/controller factories напрямую в Desk context. Не подключать runtime main shell и его server routes. Build config отделяет output и позволяет отдать Desk как отдельный static site; пути base/assets не предполагают root main origin.
3. Открытие invitation сохраняет project/revision target через connection. Вручную открыть публичный project/offer можно через валидированный ID/link input без глобального search marketplace.
4. Показать предложения владельца и project-scoped requests через canonical querying/resolve layer, с real publisher labels и available capacity. Empty states дают создание собственного offer или открытие invitation.
5. English-only и узкий экран сохраняют всю поддержку personal decisions; не создавать «технический verifier» вместо рабочего стола обычного партнера.

Проверка: typecheck, Desk feature tests, main build и separate build:desk. Source/import graph или bundle analysis подтверждает отсутствие зависимости от main app server endpoints/entry. HTTP checks реального static Desk entry/assets проверяют отдельный запуск и deep-link behavior; route 200 не объявляется доказательством owner workflow. Ни одного browser automation шага.

Checkpoint: standalone launch с честным чтением собственных/public records и сохранением invite destination. MAIN получает scripts/config integration instructions и фактический output path; не выдуманный deployed URL.

### 03.2.2 Выполнять обычные предложения и согласования с видимым результатом в studio
Status: done

1. Подключить offer create/edit/availability и exact agreement views 02.2 через shared контекст. Все команды идут тем же проверенным adapter/controller, при этом независимый клиент не спрашивает main app, имеет ли actor право согласиться.
2. Провести Library scenario: read Hall offer → открыть выставочный plan revision → увидеть весь пакет/конфликты → accept как actual owner → получить подтвержденный result → studio повторным независимым чтением разрешает тот же decision.
3. Провести Makerspace scenario: изменить relevant equipment availability/withdraw собственный вклад → studio показывает stale/needs repair вместо прежнего ready. Иная подпись display name не позволяет создать accepted решение от имени владельца.
4. Одновременные несовместимые публичные решения передаются общему conflict resolver; Desk показывает недостаточность данных/конфликт, не объявляет сеть системой атомарного бронирования.
5. После interrupted write восстановить операция→receipt→record через тот же reconciliation. Main site может быть недоступен, но Desk не заменяет реальную RPC недоступность фиктивным успехом.

Проверка: two-client integration использует две независимые repository/controller instances из того же public protocol contract, обмен идет через реальное авторизованное Tiramisu read/write evidence когда оно разрешено/доступно, а не через shared in-memory store. MAIN объединяет это с уже необходимой on-chain evidence 01.3, без неавторизованного массового seed. Отдельный HTTP/API/network dependency check подтверждает отсутствие main backend calls. Unit fixture проверяет wrong-owner/stale revision и unknown outcome. Typecheck, feature tests, build:desk и основной build.

Checkpoint: нормальная межклиентская работа доказана идентичными queried entity/decision references и resolver result, с честным списком live vs fixture evidence. Пользователь получает два реальных адреса для собственного теста после запуска MAIN. Без этого Desk не закрывается как «независимый» только на основании второй страницы.

## 03.3 Объяснить продукт, довести первый вход и дать полезную справку
Status: done
Requirements: R01, R12, R13, R14
Depends on: 01.1, 01.2, 01.3
Owner: SUBAGENT to assign
Paths: src/features/landing/, src/features/help/

Пользовательский результат: обычный человек сразу понимает, что можно собрать людей, место и оборудование в выполнимый план; пробует механизм без регистрации, переходит к своему проекту и в любой важной точке понимает публичность, ownership, consent, version changes, expiry и ограничения физических обещаний. Landing, example и application являются разными осмысленными местами, а не одной панелью, вставленной вниз hero.

Exclusive paths: `src/features/landing/` и `src/features/help/`, с feature catalogs, semantically necessary assets и tests. MAIN регистрирует routes, navigation, logo/fonts и global footer composition. Worker не создает новую i18n систему и не переписывает общую дизайн-систему. Ссылки используют route helpers/contract из 01.1; финальная связность CTA подтверждается при интеграции 02.1/02.2/03.1/03.2, без placeholder pages.

Входы: первый визит, returning draft summary из общего context, English copy, help topic/deep link и interrupted operation destination. Результаты: сохраненный выбор example/custom path, функциональный переход на текущую работу, понятные help sections и настоящее открытие действующего independent Desk URL. Не нужны внешние маркетинговые API, сбор email, analytics-зависимости, придуманные отзывы, fake statistics или глобальный каталог.

### 03.3.1 Показать один понятный проект и довести человека до реального примера
Status: done

1. Сверстать утвержденный header/hero: **Bring people, places and equipment into one workable plan.** Основной CTA **Try the example**, второй **Create a project**. Для returning user видимое **Продолжить мой проект** ведет к фактически сохраненному объекту.
2. Использовать визуальный предмет coverage sheet с предметными потребностями Small Works и реальными demo data contract. Статичная иллюстрация не изображает live network progress; интерактивное действие ведет в настоящий пример или вызывает тот же локальный domain mechanism, без canned completion.
3. Показать одну связную последовательность: не хватает вклада → найден полный план → каждый соглашается → при отзыве видна замена → результат можно повторить. Не раздувать маркетинговую сетку независимых функций.
4. Передать выбранный example/destination/locale в общий router/controller. Вход не требует wallet; custom/public boundary случается только у конкретной публикации.
5. Реализовать адаптивную композицию по approved tokens, без карточек фиктивных клиентов, decorative trust metrics, фотографий людей без основания и looping showoff motion. Reduced motion сохраняет немедленный смысл.

Проверка: static semantic/content review, English-only key parity, route-target unit checks на реальные exported route contract, перенос selected example/locale через navigation command. Typecheck, feature tests при наличии meaningful routing/presenter logic, общий build. HTTP после интеграции подтверждает доступность landing и example destination, но не визуальную понятность.

Checkpoint: landing реально приводит к useful example/own draft. User check отдельно оценивает трехсекундную понятность и отличие «план найден» от «люди согласились»; результат не предполагается на основании code review.

### 03.3.2 Объяснить публичность, согласие и восстановление рядом с действием
Status: done

1. Создать help topics с реальными якорями/deep links: локальная практика и свой draft; публикация публичного проекта; предложения и capacity; версия плана и согласие; withdrawal и replacement; проведение/возврат вещей; expiry/missing/unknown data; independent Partner Desk.
2. В явном human copy объяснить: опубликованные данные публичны; подпись показывает автора записи, не проверенную личность; вычисленная совместимость не гарантирует явку/вещь; кошелек нужен для собственного публичного действия; истечение записи не равно стиранию истории; неизвестный write status нужно сначала проверить.
3. Для changed-plan help прямо указать повторное согласие всех текущих участников. Не повторять прежний design draft, допускавший перенос untouched approvals. Для actor-controlled ownership объяснить нормальную выгоду: партнер сам меняет свое предложение, другой организатор не может сделать это за него.
4. Contextual Help сохраняет operation/draft и возвращает в прежнее место. Не ставить обязательную длинную документацию между человеком и первым полезным результатом.
5. Добавить короткое техническое пояснение partfolk/1 и links к действительным schema/source/docs после их появления. Arkiv уместен здесь; entity/nonce/RPC terms не засоряют обычные формы. Ссылка на еще несуществующий source не становится dead CTA.

Проверка: статический review утверждений против foundation protocol и текущего PROJECT, link/anchor coverage, English-only parity включая errors/aria, сохранение return destination в controller tests. Проверить, что текст не обещает privacy hidden links, permanent storage, atomic booking, legal guarantee, identity verification или гарантированную победу. Typecheck/build. Дополнительные tests ради статичных параграфов не создавать.

Checkpoint: usable help связан с конкретными действиями и честными ограничениями. Handover перечисляет topics и места вызова MAIN/feature owners; не включает автооткрытие браузера.

### 03.3.3 Замкнуть навигацию, footer и публичный путь между приложением и Desk
Status: done

1. Подключить утвержденные navigation destinations: Projects, My contributions, Requests, Help и доступный Partner Desk. Не создавать Explore или Communities CRUD ради пункта меню.
2. Footer содержит product identity, language, Help/data explanation, действующие repository/docs links и Desk link. Отсутствующий внешний URL не заменяется фиктивным; MAIN передает реальный адрес при delivery integration.
3. Сохранить текущий example/project и return intention при переходах между landing/help/application. Переход к отдельному Desk сообщает реальный destination и передает только публичные validated IDs, не приватные browser storage данные.
4. Проверить empty/missing-link/unknown project contexts: человек получает понятный путь обратно к workspace или примеру, а не необъяснимую пустую страницу. Все видимые CTA выполняют действие и имеют accessible name.
5. Передать MAIN human test itinerary: открыть landing → sample conflict → собственная форма → help → назад без потери draft → own contribution → agreement → runbook → Desk. Это инструкция для пользователя, не сценарий автоматизации.

Проверка: route/link contract coverage, static navigation/accessibility semantics, English-only catalog completeness, full build + build:desk после интеграции. HTTP проверяет реальные entry/deep-link/assets addresses и отсутствие broken own internal links в доступном статическом/route manifest. Не ходить автоматически по UI и не создавать screenshots. Конечная closed-loop проверка поведения использует уже существующие controller/domain tests; route 200 не заменяет их.

Checkpoint: whole product можно найти и понять, нет decorative dead ends. Закрытие задачи требует integrated destinations 02.1/02.2/03.1/03.2, даже если собственные feature files были готовы раньше. MAIN делает финальный checkpoint после handover и чтения TESTING; неудостоверенная визуальная часть остается явно пользовательской проверкой.




Implementation handed back and integrated9October2026. Static/domain/controller checks and both builds passed; visual/browser acceptance remains user-owned and unverified. Actual product Tiramisu proof belongs to04.2, not these local/mocked checks.

