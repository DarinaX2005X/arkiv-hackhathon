# Partfolk
Summary: Собрать людей, место и оборудование в выполнимый общий план, согласовать его и провести проект.

## Выбранный продукт и граница реализации

Partfolk — рабочее место для творческих коллективов, студенческих клубов и небольших сообществ, которые вместе с партнёрами проводят выставку, мастерскую или другое общее дело. Организатор задаёт возможные даты и потребности. Каждый участник или партнёр предлагает собственное время, помещение или оборудование. Продукт находит целые совместимые варианты, собирает явное согласие владельцев на конкретный план, помогает заменить выбывший вклад и довести работу до завершения.

Название: Partfolk. Слоган: «Каждый приносит свою часть». Знак: [составная P](./identity/partfolk-mark.svg). Дизайн: [DESIGN](./DESIGN.md). Подробные этапы: [человеческий план](./PLAN-HUMAN.md) и [технический план](./PLAN.md).

Это выбранное MAIN направление после проверки конкурентов, не заявление о гарантированной победе. Пакет подготовлен и независимо проверен до продуктового кода. Исходное прямое поручение самостоятельно выбрать концепцию и перейти к реализации без остановки на планировании задаёт автономное продолжение поверх общего approval gate VibeMachina. Это не утверждение о том, что пользователь отдельно одобрил название Partfolk. Bootstrap SDK и проверочные synthetic транзакции разрешены исходным поручением и выполнены отдельно. Исходные условия и пользовательские поправки сохранены в BRIEF; прикреплённые внешние инструкции не входят в продуктовый Git.

## Сравнение принципиально разных направлений

| Направление | Полезный результат | Почему решение такое |
| --- | --- | --- |
| Co-sign: командный выпуск press kit | Собрать материалы и согласия авторов, выпустить пакет | Picflow/Pixieset уже закрывают review, approvals и delivery; подпись сама по себе не создаёт достаточного нового сценария |
| OpenCall: полный конкурс с прозрачным судейством | Заявки, оценки, результат, аудит | Найдены JuryX, Juryza и JudgePass с прямыми похожими механизмами; обычная прозрачность оценивания недостаточна |
| Partfolk: совместный проект из независимых вкладов | Вычислить полный вариант, согласовать точную версию, провести и восстановить | Выбран за связанный обычный процесс и штатную самостоятельность участников/клиентов; механика должна пройти три строгих proof gates |

Аудит ближайших конкурентов: [Hylo](https://www.hylo.com/features), [SignUpGenius](https://www.signupgenius.com/resources/what-is-signupgenius-guide), [Timefold](https://timefold.ai/products/task-scheduling), [Mobilizon](https://docs.mobilizon.org/about/). Утверждение ограничено проверенными источниками: отсутствие полного сочетания в них не доказывает всемирную уникальность. Пользовательские возражения к Patchbay привели к его полному отказу; игровые направления исключены по прямому выбору пользователя.

## Почему это отдельный продукт

Сегодня такой группе приходится сводить ответы из чата, доступность ресурсов и таблицу задач. Список желающих не отвечает на вопрос, существует ли полный выполнимый вариант с учётом времени и совместимости. Partfolk соединяет подбор полного варианта, контроль собственных обещаний и проведение проекта. В примере один человек может либо установить выставку, либо привезти оборудование одновременно; приложение должно заметить это и показать, чья дополнительная помощь сделает план возможным.

Hylo уже объединяет сообщества, предложения, запросы и проекты; SignUpGenius закрывает запись в слоты; Timefold умеет решать ограничения и минимизировать изменения. Мы не называем эти отдельные механизмы новыми. Проверяемое отличие предлагаемого продукта — полный совместимый план из независимо управляемых вкладов, согласие всех на точную версию и работа партнёров через самостоятельные клиенты с теми же подлинными данными. Если независимый Partner Desk остаётся декоративной второй страницей первого backend, отличие не доказано и работа не завершена.

Конкурсные треки: Open Source основной и Censorship Resistance дополнительный. Оба опираются на один самостоятельный Partner Desk/CLI и открытый протокол. CR означает независимость от Studio host/API, с явной зависимостью от Arkiv/RPC и сохранением прав владельцев/координатора. Основание сверено с официальной rubric; искусственных функций ради второго трека нет. India исключён пользователем.

## Зачем Arkiv в рабочем процессе

Библиотека владеет собственным предложением зала и своими решениями сразу для нескольких групп. Организатор не может подтвердить новое время за библиотеку. Библиотека использует самостоятельный Partner Desk, творческий коллектив — Partfolk Studio, а независимый читатель — CLI. Все читают и публикуют прямо в Arkiv по открытому протоколу. Собственные базы аккаунтов клиентов не определяют истину. Обновление владельца видно другим клиентам после свежего чтения сети.

Обычная центральная база тоже позволила бы сделать хороший планировщик. Её администратор, однако, управлял бы общей базой обещаний и доступом конкурирующих клиентов. Здесь самостоятельность владельцев и клиентов является штатным поведением, которое нужно показать действием и транзакциями. Это не гарантия физической явки или истинности описания ресурса.

## Первые три минуты судьи

Обязательная цель исходного brief: понять продукт за3–5секунд, увидеть убедительный работающий механизм за2–3минуты. Это отдельный короткий proof tour: изменить реальный ввод и увидеть конфликт/новый вариант; открыть подлинный предварительно опубликованный пример с реальными согласиями; проверить независимое решение/отзыв и обновлённый статус. Готовые onchain состояния явно датированы и не изображают согласия, сделанные судьёй. Полная самостоятельная практика ниже занимает около5минут и остаётся доступной; timing подлежит пользовательской проверке.

## Зафиксированные решения поверх подробных сценариев

- Протокол `partfolk/1`, chain 7738577, namespace `partfolk`, SDK 0.8.1. Историческое слово Convene в feasibility probe не является брендом продукта.
- Любое изменение существенных условий требует нового согласия ВСЕХ участников нового плана. Незатронутые старые согласия не переносятся.
- Дата, время, требования, выбранные предложения, распределение ресурсов, условия и исполняемые пункты плана входят в канонический hash. Фильтры экрана и отчёты о выполнении его не меняют.
- Минимальное изменение — проверяемый лексикографический критерий: сохранить совместимых владельцев, затем дату/вариант, затем назначения и объёмы. Ограниченный поиск не выдаётся за доказанный оптимум.
- Время — целые UTC milliseconds с явным IANA timezone для показа; интервалы полуоткрытые. Количества — положительные целые в именованных единицах. Личная занятость использует общий ресурс self capacity=1.
- В обычном продукте нет глобального маркетплейса, CRUD сообществ, чата, платежей, карт или рейтингов. Выбор вкладов ограничен явно приглашёнными/добавленными publisher roots конкретного проекта. Публичная ссылка не означает приватность.
- Полный пример работает локально без кошелька, с видимым переключением synthetic ролей. Он использует те же solver/verifier/state-machine правила. Локальные согласия нельзя импортировать как чужие публичные решения.
- Публичный режим читает сеть без входа; запись требует кошелька действительного владельца и Tiramisu. Общего публичного signer нет. Для записи демо используются отдельные локальные synthetic кошельки только в CLI, в пределах общего лимита 0.1 test GLM; секреты не попадают в браузер/Git.
- Полный onchain пример в интерфейсе отделён от локальной практики; fake local data не смешивается с network evidence.
- По прямому уточнению пользователя UI English-only целиком, включая ошибки, help, экспорт и accessibility labels. Русской версии и переключателя языка нет. README и конкурсные schema/friction на английском. Planning docs и обсуждение могут оставаться русскими.
- Учёт завершения различает reported/acknowledged; незавершённые возвраты остаются видимыми при закрытии. Во время ремонта сохраняется уже выполненная история, а новое предложение описывает оставшуюся работу.
- Никакой автоматизации браузера или визуальной проверки агентами. Пользователь тестирует UI; агенты проверяют код, предметные правила, сервер и HTTP/API.

## Архитектура и границы

React + TypeScript + Vite, две независимые сборки Studio и Partner Desk. Чистый общий domain/protocol пакет не зависит от React или SDK. Arkiv adapter реализует строгие схемы, запросы одного snapshot, readonly provenance, consume-and-replace, reconciliation. Local adapter реализует тот же Repository контракт для практики и пользовательских черновиков. UI не вызывает SDK напрямую. CLI использует тот же протокол, но независимый процесс и только официальный RPC.

Семь типов: project_root, project_state, publisher_root, book_state, proposal, plan_activation, project_link. Связи предложений/запросов обеспечивают обычные приглашения; уникальная активная версия отдельно защищает от повторного использования старых согласий. Уникальный действующий state обязателен; ноль — unavailable, несколько — conflict. Никакого latest-wins. Одновременные изменения одного владельца защищаются заменой readonly state через atomic create(new)+delete(exact old); техническое основание проверяется отдельным probe до реализации. Между разными владельцами атомарного бронирования нет: Ready является вердиктом полного свежего snapshot.

Политика данных: только публичные описания проектов/вкладов. Демо целиком вымышлено. Нет имён реальных людей, адресов, телефонов, приватных календарей и их хешей. Публикация требует явного preview. Удаление/истечение не обещает стирания скачанных копий или истории сети.

Приложение хранит draft, выбранный контекст и pending intent/hash локально с версией формата. Ошибку storage показывает, не превращает её в успешное сохранение. Сетевая ошибка сохраняет last-known данные с датой и unverified статусом. Отмена кошелька сохраняет ввод. Unknown outcome сначала reconciles original operation; слепой повтор create запрещён.

Корни и proposal демо живут 180 дней, текущие состояния 90 дней при отсутствии более длинных обязательств. Приложение проверяет, что state живёт дольше каждого grant; при необходимости предлагает корректный срок до подписи. Approval имеет собственный срок и не оживает от продления entity. Renewal только владельцем. Ни срок записи, ни доступность архива не выдаются за постоянство.

## Разработка и доставка

Все продуктовые файлы внутри этого repo. MAIN владеет manifest/lock, shared contracts, canonical memory, integration, Git. Существенные задачи выполняются работниками в непересекающихся путях. Предлагаемые обычные команды после реализации: npm ci; npm run dev (loopback); npm run check (types+domain/integration tests+две сборки); npm run verify -- <project-root>; npm run evidence:estimate. Команды не считаются существующими до реализации и проверки. Deployment статический с history fallback; внешнего backend и постоянных секретов нет.

Origin private: https://github.com/DarinaX2005X/arkiv-hackhathon.git, main. Частые проверенные scoped commits и push разрешены. Пользователь сам делает repo public и отправляет Devfolio. Публичный рабочий сайт, доказательства, воспроизводимый README/MIT, schema/friction и английский submission draft обязательны. Для доступности хостинга может потребоваться вход пользователя. Demo video/screenshot capture выполняет пользователь; агент готовит сценарий и точные ссылки.

## Принятые исправления протокола

Все пять исправлений независимого аудита приняты в PROTOCOL: lifecycle отдельно от текущего согласия; owner-controlled release; attestations отдельно от grants; resumable root initialization; точная граница canonical hash. Доски уже находятся в зале до10:00, водитель одновременно доставляет произведения для выставки. Противоречивые ранние описания ниже читаются с этими конкретными уточнениями.

## Подробные пользовательские сценарии

Следующий раздел консолидирован MAIN из независимой проработки. Решения выше являются окончательными при разночтениях; proposed route names уточняются в PLAN.

## Product promise

**Turn your group's project into a plan with the people, place and equipment it needs.**

Short explanatory line: **Offer what you can. Find a workable plan. Agree together.**

The first audience is an existing creative collective working with a library or makerspace. They have people and resources already; they lack a dependable way to combine everyone's conditions into one feasible plan. Partfolk does not depend on an audience arriving from a public marketplace.

The meaningful operation is **Find a plan**: assemble complete alternatives from participant-owned offers, show the particular gap when none works, obtain everyone's agreement to one exact version, and repair the plan after a withdrawal. Counting signups does not complete this operation.

The product does not collect money, make legally binding bookings, enforce attendance or verify that a physical resource exists. It records the contributor's offer and agreement accurately, checks the declared conditions, and makes incomplete or changed arrangements visible.

## Three independent jobs

| Job | Person and trigger | Material they bring | Usable result | Next action |
| --- | --- | --- | --- | --- |
| Assemble a project | An organizer wants to hold an exhibition and needs to learn whether the group can actually do it. | An outcome, possible dates, resource needs, collaborators. | A feasible proposed plan, or a specific list of missing resources/conflicting commitments and alternative configurations. | Invite missing help, refine a requirement, choose a plan and request agreement. |
| Offer help on my terms | A participant or partner has time, space or equipment and needs to control its use across several projects. | Their own offer, availability, capacity and conditions. | A reusable contribution listing plus a clear view of requests, proposed assignments and current agreements. | Accept a particular complete plan, decline it, change future availability or withdraw. |
| Carry out and recover a project | A coordinator or contributor is preparing an agreed project, or somebody can no longer do their part. | The accepted plan and real progress. | A current run sheet, visible responsibility for each part, repaired agreement when needed, and a completion record. | Perform the work, confirm handovers/returns, resolve unfinished work, or reuse the recipe. |

These jobs share the same project, offer identities, immutable-in-application plan revisions and participant decisions. A person does not copy an equipment listing or re-enter a promise when moving between them.

## The example: Small Works, a community pop-up exhibition

Every person, organization and venue label below is synthetic. No real address, phone number or contact data is needed.

The collective wants to exhibit small handmade objects. It can hold the exhibition on one of two dates. The requirements explain purpose in ordinary words; people are not asked to write rules or logical expressions.

| Part of the project | Requirement |
| --- | --- |
| Place | One public exhibition space available for setup and the exhibition. |
| Display equipment | Six display boards and one installation kit. |
| Installation | Two people from 10:00 to 12:00. |
| Transport | One person from 10:00 to 12:00 who can bring the artworks while display equipment is already at the venue. |
| Hosting | Two people from 12:00 to 16:00. |

The project uses one explicit time zone, shown beside its dates. Availability comparisons use actual instants. A resource's offer must cover the entire required interval; overlapping commitments consume its capacity. Separate, non-overlapping shifts can use the same person.

**Saturday option:** the Courtyard offer is available, but only four display boards are available. The result identifies a shortage of two boards. No weather service or safety judgment is implied.

**Sunday option:** Library partner offers the Hall, and Makerspace partner offers six boards plus an installation kit. Cedar can either install or transport during 10:00–12:00 and limits the offer to one assignment at a time. Willow can install. Ash and Elm can host. Sunday is blocked: Cedar cannot be counted twice. The explanation reads: **“One more installer or a driver would make Sunday work. Cedar can do either job, but not both at once.”**

Adding Oak's transport offer makes Sunday feasible: Cedar and Willow install, Oak transports, Ash and Elm host, and the partner offers cover the place and equipment. The system displays this concrete assignment, not only a percentage or readiness score.

After everyone accepts Sunday revision 1, Oak withdraws. The accepted revision stops being current and ready. An available Juniper installation offer gives a repair: Cedar transports, Willow and Juniper install. The change summary shows Oak leaving, Juniper joining and Cedar changing roles. Every party reviews and accepts Sunday revision 2; unchanged participants' old decisions do not silently become new consent.

## First five minutes: runnable example

These are design targets, not measured times. The example runs the same validation, feasibility and consent rules as custom work. Sample offers are openly marked synthetic and local.

| Time target | Person does | Product does | Inspectable result |
| --- | --- | --- | --- |
| 0:00–0:10 | Selects **Try an exhibition** from the landing page. | Creates or resumes a local sample copy; shows **Local practice · nothing published** and an obvious reset action. | The project goal, its two date options and a meaningful initial result. No connection dialog. |
| 0:10–0:30 | Opens **Why it does not work yet** for Sunday. | Highlights the simultaneous transport and installation assignments and Cedar's one-assignment limit. | A concrete missing-help sentence and two repair options: add one driver or add one installer. |
| 0:30–1:10 | Chooses the sample role **Oak**, selects **Offer transport**, checks Sunday 10:00–12:00 and saves. | Saves the offer locally and recomputes from actual entered data. | Sunday becomes **Plan found**, with named assignments. It does not become agreed. |
| 1:10–2:10 | Returns to **Organizer**, compares Saturday and Sunday, chooses Sunday and selects **Ask everyone to agree**. | Freezes a proposed revision, lists all required people and partners, and opens the agreement view. | Exact requirements, schedule, assignments, contributor conditions and the pending decisions. |
| 2:10–3:20 | Uses the visible sample-role selector to inspect participant and partner perspectives, then accepts as the required sample parties. | Records each local sample decision against the same revision. A **Next person waiting** action keeps the tour short without fabricating decisions. | Pending count falls from the actual required set. Only the final necessary acceptance yields **Agreed by everyone**. |
| 3:20–4:10 | Switches to Oak, selects **I can no longer help**, and confirms the clearly stated consequence. | Records the withdrawal, removes current readiness, and preserves the earlier agreement as history. | **Needs a new plan** with the transport gap and an explanation of affected work. |
| 4:10–5:00 | Adds Juniper's installation offer, selects **Find a replacement plan**, and opens the proposed repair. | Finds Cedar as transporter and Juniper as installer, presents the differences, and starts fresh decisions for all parties. | A second complete proposal with **0 of N agreed to this version**. The user has experienced both the successful mechanism and recovery. |

Agreement can continue beyond the first five minutes. The useful output in the first half-minute is the exact obstacle; in the first minute it is an executable proposed assignment. We do not compress the story by treating a computed assignment as consent.

### First five minutes with the user's own material

1. **Start your project** asks for a title and outcome, then possible dates. It defaults to the browser's time zone but makes the chosen zone visible and editable.
2. The user adds requirements with **People**, **Place**, or **Equipment**. Each asks for a short name, quantity and relevant time. A project recipe can prefill an editable exhibition structure, visibly without importing fictional contributor offers.
3. **See what is missing** immediately produces an honest unmet-needs board and a shareable invitation draft. With no offers, the result says no plan exists yet.
4. A draft can be saved locally or exported without a wallet. Local assumptions are labeled assumptions and never count as another person's offer or acceptance.
5. **Publish project** explains that published details are public and asks for the required connection. The title, dates, requirements, language and intended destination survive cancellation or failure. Successful publication returns to the same project and produces the actual invitation link.
6. A contributor following that link can inspect the project first, prepare an offer locally, then connect only when publishing their own offer or decision. An organizer cannot publish an attributed contributor promise on their behalf.

No fictional existing network, generated volunteer, fabricated reservation or presumed partner consent fills the user's own project.

## Journey A — organizer assembles and agrees a project

**Entry:** new project, reusable recipe, shared project link, or a saved local/public draft. The organizer's starting material is an intended outcome and a few requirements.

1. State the outcome and create one or more acceptable date/configuration options. A configuration can alter location type or equipment quantities when the organizer deliberately makes that tradeoff. The interface uses ordinary cards such as **Sunday indoors**; it does not expose a graph editor or a programming language.
2. Enter required people, equipment and place. Add conditions only where needed: availability, count, permitted roles and an offer's capacity. A driver and a vehicle are not silently assumed to be the same offer; the contributor says what their offer includes.
3. Review the unmet-needs board. The organizer sees who or what would make each option work and shares the relevant project/request link with existing collaborators.
4. Receive contributor-owned offers. Inspect the real publisher identity and a human label without presenting the label as verified identity. Candidate offers are distinct from accepted arrangements.
5. Select **Find a plan**. Preserve inputs and the last result during calculation. The result gives complete alternatives or reasons none works. Display the selected criteria and stable tie-breaking; do not call one proposal “best” without a stated basis.
6. Refine an option or keep a preferred assignment and recompute the rest. If keeping that assignment makes the project impossible, explain the conflict rather than discarding the choice silently.
7. Choose one exact proposal and request agreement. The proposal includes the outcome, date, time zone, requirement quantities, selected offers, assignments and applicable conditions. All required contributor owners are listed once, even if one partner supplies several items.
8. Track accepted, pending and declined decisions. A decline is not a technical error. Its optional explanation helps the organizer refine the plan, but no one must provide personal details to decline.
9. When every required owner has accepted the exact current version and the referenced offers remain current and sufficient, show **Agreed by everyone** and the ready run sheet. The organizer's own acceptance is explicit when they are one of the required contributors; selecting a proposal is not a substitute for another person's agreement.
10. Edit a plan through a new revision. The full change summary appears before requesting fresh agreement from everyone. Historical acceptance remains attached to the prior revision.

**Meaningful variation:** the library changes Sunday's available end time. If that change no longer covers the exhibition, the selected plan becomes stale and needs a new plan. An unselected offer becoming available does not alter the agreed plan.

**Recovery:** if one publication fails, keep the completed local draft and its intended operation. A retry reconciles the original operation rather than producing duplicate projects or invitations. Unknown network outcomes are presented as unconfirmed, never successful by optimistic assumption.

**Output:** the plan, its alternatives, current agreement roster and a printable/exportable run sheet. Exports state the plan version and agreement status; a proposed plan cannot be exported with a ready label.

## Journey B — participant or partner controls contributions

**Entry:** an invitation for a particular project or **My contributions** to offer something available across the group. A library or makerspace can enter through a separate, independently runnable **Partner Desk** client as its normal workspace.

1. Create an offer: **My time**, **A place**, or **Equipment**. Ask for the smallest relevant facts: what is offered, amount/capacity, availability, acceptable roles or use, and a human explanation of any supported condition.
2. Preview exactly what will be public. Private contact information is not required. Public-project work is the deliberate product scope; the software does not claim that a hidden link makes the data private.
3. Publish the offer as its owner. The offer can be discovered by multiple project clients through the same public data contract. A contributor does not recreate an account or duplicate their inventory in every organizer's workspace.
4. See project requests using that offer: what the whole project will do, the contributor's own part, everyone else required, existing commitments and possible time conflicts. Showing only “click accept” without the complete agreed package is insufficient.
5. Accept or decline one exact plan. “Interested,” “available” and “accepted this plan” remain visibly different. Accepting one project updates the capacity/conflict view for others; the application must refuse to label overlapping excessive assignments as simultaneously ready.
6. For a changed plan, see **This version needs your agreement again**, a concise difference list and the full plan. An unchanged personal assignment does not transfer the old acceptance.
7. Edit future availability or withdraw a specific contribution. The confirmation identifies affected accepted projects and what will become incomplete. Preserve the participant's right to withdraw; do not lock them into a UI because other people rely on the plan.
8. During execution, mark their assignment done and record any equipment handover or return they are responsible for. These are self-reported progress records, not independent proof of physical performance.
9. Return later to a stable portfolio of offers, requests, current accepted contributions and completed work. Copy an offer into a new availability period without carrying old project acceptances forward.

### Normal operation across independent clients

The project studio is where the creative collective composes the exhibition. The library's Partner Desk is where it manages the Hall offer and reviews requests from the exhibition and another club. The makerspace uses the same desk pattern for equipment. These clients read the same public offer identities and participant-authored decisions directly through the documented Arkiv contract; the Partner Desk does not depend on the project studio's account database or API for authority.

The observable operation is ordinary: Library partner adjusts its own availability or accepts the exact exhibition plan in Partner Desk; the collective's studio then displays that same publisher-authored change after refresh. The organizer cannot amend the library's offer. The client boundary must be demonstrably real, not two tabs rendering one administrator-owned record.

**Meaningful variation:** one person offers both installation and transport. Capacity one prevents overlap, while sequential installation and hosting remain allowed if the stated availability covers both.

**Recovery:** an offer expires, is removed by its owner, or is unreadable during a network failure. Missing/expired is different from temporarily unverified. The plan cannot remain confidently ready when a required offer is absent; during an RPC failure the last known plan is visibly not freshly verified. The user's local edits and pending decisions are retained.

**Output:** the participant's reusable offers and their own signed decisions. No organizer can replace these with a self-written “confirmed” field.

## Journey C — execution, withdrawal, completion and reuse

**Entry:** an agreed plan, a personal assignment, or an alert within the app that the current plan needs attention. Push, email and SMS are not required dependencies for the core flow; links and the in-app inbox suffice.

1. Open the run sheet by time or by responsibility. Everyone can see the same version and when its agreement was last checked. The organizer can export it for offline reference, with a warning that an exported copy does not update itself.
2. Before starting, resolve stale offers and changed/withdrawn decisions. The interface does not let a green historical state override a current gap.
3. A participant can withdraw before or during execution. The product preserves completed work while marking remaining affected work as needing a plan. A replacement proposal covers the uncompleted work explicitly; it does not rewrite the historical record of what already happened.
4. **Find a replacement plan** preserves unaffected assignments where feasible, identifies the smallest explained set of changes and presents alternatives. Preserving assignments is a preference, not permission to hide an impossible result. The coordinator can choose a different alternative.
5. Request fresh acceptance of the whole revised remaining plan from all required current parties. Removed contributors appear in history; replacement parties join the required decision set. The revision cannot inherit the prior consensus.
6. Record progress on actual assignments. Equipment handovers carry a giver record and a receiver acknowledgement where applicable. “Reported handed over” and “acknowledged received” are distinct states. The app does not adjudicate disputes or claim custody by itself.
7. Finish with a completion review: completed, cancelled or still outstanding assignments; equipment returned or outstanding; and each contributor's acknowledgement. An organizer's **Close project** action cannot turn an unacknowledged return into a confirmed return.
8. Publish a factual project outcome with optional text and contributor-authored completion records. Use **Completed with outstanding items** when appropriate; avoid a forced all-green ending.
9. **Use this project again** creates a new draft from the requirements, alternatives and helpful instructions. It references the source recipe, clears dates/decisions/progress as appropriate, and asks owners for fresh offers or availability. It does not silently carry bookings or promises into the new project.

**Meaningful variation:** a project is cancelled before launch. Preserve the cancelled plan and invite each owner to release their own active commitment; unreleased holds remain visible until owner action or their exact deadline. Published records may remain queryable/history-visible according to the underlying network; do not promise erasure.

**Recovery:** a person closes the app after sending an acknowledgement. On return, reconcile against the current public record and show whether it was recorded. Retry only after identifying whether the original operation completed.

**Output:** a truthful completion/exception record, reusable recipe and contributor history, all connected to the original plan and its revisions.

## Surfaces and destinations

Route names below are proposed destinations, not frozen implementation contracts.

| Surface | Access and entry | Durable context | Real next actions |
| --- | --- | --- | --- |
| Landing | Public. Explains the three-second promise with one concrete exhibition example. | Chosen example or start intention. | Try exhibition; start project; resume local work; open public project. |
| Local practice | No wallet. Distinct banner and role selector; sample actors exist only here. | Isolated local sample state. | Change real inputs; inspect plans; act as a sample role; reset; start own project. |
| Project studio | Read public projects without connection; publish/change only with appropriate ownership. | Project, offers, selected option, revisions and current decisions. | Edit own project; share a request; find/compare plans; request agreement; open run sheet. |
| My contributions | Local preparation plus connected public ownership. | Offers, requests, assignments and pending publication state. | Add/edit offer; inspect complete plan; accept/decline/withdraw; mark own progress. |
| Partner Desk | Independently runnable client for library/makerspace contributors. | Same participant-owned offer and decision identities, without copying into an organizer database. | Manage offers across projects; inspect collisions; accept or decline exact proposals. |
| Agreement view | Public plan-readable view; each owner can submit only their own decision. | Exact version, references and acceptance set. | Inspect changes; accept; decline; return to own contribution. |
| Run sheet | Public project context; actor-authorized progress actions. | Agreed revision, outstanding work, handovers and return records. | Export; report progress; withdraw; repair plan; review completion. |
| Recipe/result | Public source and facts, local new draft on reuse. | Requirements, context, completion status and original project reference. | Review outcome; copy recipe; select new dates and invite fresh contributions. |
| Help and public-data explanation | No connection. Linked where publication and ownership matter. | None required. | Understand local/public modes, connection, offers, consent, expiry and recovery; return to the interrupted job. |

Navigation should use the recognizable destinations **Projects**, **My contributions**, **Requests**, and **Help**. It should not expose entities, transaction queues, constraint engines or the backend's processing stages as the main navigation.

## Plan and agreement states

| State | What it means | What the person can do |
| --- | --- | --- |
| Draft | The organizer has entered material, but no complete current proposal exists. | Continue locally, add requirements, import/export own draft, publish when ready. |
| Missing help | Current offers cannot satisfy at least one option. | Inspect a precise gap/conflict, share the needed contribution, edit options. |
| Plan found | At least one current feasible assignment exists. Nobody's agreement is inferred. | Compare alternatives, inspect assignments, choose and request agreement. |
| Awaiting agreement | One exact proposed revision exists; one or more required decisions are missing. | Review, accept/decline as self, withdraw own offer, revise as organizer. |
| Declined | A required party declined this revision. | Read the optional reason, refine/replan, invite alternatives. |
| Agreed by everyone | All required owners accepted this exact revision and relevant references currently satisfy the conditions. | Use the run sheet, export, start execution, withdraw or propose a new revision. |
| Needs a new plan | A relevant input changed, a required contributor withdrew or an offer became unavailable. | Inspect the change, find replacements, request fresh agreement. |
| Cannot verify current status | Network/reference data needed for current confidence is unavailable. | Read visibly dated last-known data, retry, preserve drafts; do not treat it as a new confirmed agreement. |
| In progress | Execution has started for an agreed plan, with explicit progress and outstanding work. | Report progress, acknowledge handovers, recover remaining work. |
| Completion review | Work ended or was cancelled, with unresolved facts still visible. | Confirm own work/returns, mark exceptions, close with accurate status. |
| Completed / Completed with outstanding items / Cancelled | The outcome is recorded without erasing exceptions. | Inspect history, export, reuse the recipe. |

Plan revisions and execution records are different. Comments, progress receipts, display-only filtering and newly offered but unassigned resources do not mutate the agreed plan. Changing any field of the actual agreed package creates a new revision and requires all current parties to accept again.

## Consent and ownership invariants

- Only the actual publisher/owner of an offer can change or withdraw it under the supported ownership rules. A human label does not establish authority.
- Only a required party's own authenticated/publicly verifiable decision can count as their acceptance. Organizer-entered placeholders cannot count.
- Every acceptance names the exact plan revision and the referenced content/conditions it accepts. A mutable plan's friendly ID alone is insufficient.
- A computed feasible plan is always a proposal until its full required acceptance set is present.
- Any change to the agreed package requires a new revision and fresh agreement by every required current party, including parties whose own assignment looks unchanged.
- A contributor's overlapping allocations cannot exceed the declared capacity. An application can detect conflicting public decisions; it cannot promise atomic reservation across every independent client on Arkiv.
- Missing, expired, superseded, withdrawn or conflicting required records prevent a currently-ready claim. RPC uncertainty produces an unverified state instead of a fabricated withdrawal or agreement.
- No promise of physical attendance, actual equipment availability, legal obligation or irreversible erasure is made.
- Local practice decisions cannot enter the public mode as if real people made them. Starting public work requires real owners and genuine decisions.

## Core features that complete these jobs

The full scope is the connected loop: editable projects and alternative configurations; reusable participant-owned offers and availability; understandable feasibility and conflict explanations; complete alternative plans; owner-controlled decisions tied to exact revisions; cross-client partner participation; change/withdrawal detection; replacement proposals with fresh whole-group consent; run sheets; progress and equipment handover/return acknowledgements; honest completion; recipe reuse; local draft recovery; clear publication/error/expiry handling; real export and sharing; complete help for the supported operation.

The constraint vocabulary should cover the actual domain thoroughly: quantities, availability intervals, permitted roles/use, per-person/resource capacity, non-overlapping reuse, required combinations and named alternative configurations. Unsupported arbitrary conditions must never silently influence readiness merely because they appear in free text. Clearly identify a note that humans still need to review.

No arbitrary feature-count cap defines completion. Conversely, the following are optional future extensions, not hidden dependencies of the promised product: public marketplace discovery, geographic route optimization, maps, payments/escrow, donation campaigns, ratings, identity background checks, AI project generation, chat replacement, external calendars, email/SMS/push delivery, media hosting, ticketing, weather forecasts and dispute arbitration.

## Observable acceptance for implementation planning

1. In the exhibition sample, Sunday cannot be reported feasible while Cedar fills overlapping installer and driver requirements with capacity one. The gap explanation identifies an additional installer or driver as useful.
2. Oak's valid transport offer yields the complete Sunday assignment; an offer ending before 12:00 does not satisfy the transport requirement.
3. Saturday remains short of two boards unless the organizer intentionally changes that variant's requirement or receives more boards. Quantity is not rounded or inferred.
4. A person can install 10:00–12:00 and host 12:00–16:00 when their availability covers both; unrelated overlapping commitments cannot be ignored.
5. Freshly computed plans have no inferred acceptances. Pending, declined and accepted decisions remain distinct.
6. An organizer's attempt to submit the library's acceptance cannot count. A valid decision made in the independently runnable Partner Desk appears in the project studio through the common public data contract.
7. Changing the Sunday plan after complete agreement makes all old approvals historical. Every required party must accept the new revision; unchanged participants are not exempted.
8. An unassigned offer or a progress note does not unnecessarily invalidate agreement.
9. Oak's withdrawal stops current readiness. Juniper's installation offer permits the explained replacement with Cedar transporting. No available replacement produces an honest missing-help result.
10. A failed or cancelled connection preserves the chosen example/custom draft and destination. A publication retry cannot create a duplicate project/offer/decision after an unknown first outcome.
11. Expiry, missing references and RPC failure have distinct behavior and cannot leave an unqualified current-ready claim.
12. A completed installation remains in history during a mid-project repair. The replacement revision addresses remaining work instead of rewriting what already happened.
13. Equipment reported handed over but not acknowledged received remains visibly unacknowledged. Closing a project cannot manufacture a returned status.
14. Reusing a project copies its recipe into a new draft without copying consent, occupied dates or completion receipts.
15. Export identifies the exact plan version, time zone, assignments and current status. Proposed or stale exports cannot look like confirmed current agreements.
16. Demo role changes remain within isolated local sample state. Public actions require the real contributing account, and the mode boundary is explicit before publication.

Static, unit, domain, server and HTTP/API checks can verify these behavioral contracts. The user alone verifies visual appearance, browser interaction and whether the first-use wording is clear. No browser automation, screenshots or equivalent UI inspection is authorized for agents.






