# 06 Сделать продукт воспроизводимым и передать настоящую демонстрацию
Status: todo

Новый человек запускает Partfolk по README без внутренних agent-файлов, изучает публичный контракт и проверяет пример независимой командой. Рабочая ссылка, исходный код, доказательства и текст заявки соответствуют одной версии. Пользователь самостоятельно проверяет браузер, открывает репозиторий и отправляет заявку.

## 06.1 Документировать рабочий продукт, схему и воспроизводимый запуск
Status: todo
Requirements: R02, R14, R15, R16, R17
Depends on: 05.2
Owner: SUBAGENT to assign
Paths: README.md, LICENSE, arkiv/schema.md, arkiv/friction.md, docs/protocol.md, docs/operations.md

Подготовленные фактические материалы9October2026: MIT LICENSE, docs/protocol.md и docs/operations.md уже написаны по текущим контрактам; schema/friction актуализированы. Это частичная подготовка, не завершение06.1: финальный README, clean checkout launch и подтверждённые live/deployment ссылки ожидают оставшихся04/05. По прямому запросу пользователя сегодня новые этапы не запускаются.

**Результат.** README объясняет Partfolk одной понятной фразой, затем показывает реальную полезную работу, способы запуска обоих клиентов, проверку Arkiv и точные ограничения. Документация является инструкцией к финальной реализации, не альтернативным планом. Документировать факты известных записей/операций, не придумывать friction задним числом ради конкурса.

**Вход и владение.** Читать финальные code/scripts, public schema, evidence manifests, реальный review, официальные требования hackathon и текущий repo state. Писать перечисленные public documentation paths; manifests, CI, package scripts и shared code исправляет владелец по loan MAIN. README links заполнять реальными доступными URL; не создавать «успешный» demo address из желаемого имени. LICENSE — MIT с фактическим правообладателем, не вымышленным автором. Copyright owner брать из подтверждённых данных проекта; если они отсутствуют, это конкретное поле handoff, а не автоматически приписанная личность.

**Содержание.** Чётко разделить local practice, самостоятельную public работу и опубликованный synthetic example. Описать режимы/chain, публичность и expiration, injected wallet, поддержанный trust boundary, установка/runtime/env names без значений секретов, команды dev/build/check/start/desk/verify, architecture diagram только если помогает пониманию, seven entity types/attrs/payload references/lifecycle и exact consent. Объяснить concurrent writes/reconciliation, временную недоступность RPC, уникальность current state, продление lifetime и очистку pending, ограничения физического доверия/Sybil. Attribution перечисляет реальные зависимости и внешние материалы; LLM workflow описывается правдиво.

### 06.1.1 Написать README, публичную схему и фактический friction log
Status: todo

1. Сопоставить финальную реализацию с evidence и устранить устаревшие названия Convene/старые контракты в public docs, сохраняя историю research вне продукта.
2. README: one-liner и кому полезно; реальная demo ссылка после 06.2; Small Works и custom workflow; самостоятельный запуск без wallet для чтения/local practice; publication setup; команды двух клиентов и verify; architecture/Arkiv necessity; security/trust limits; known limitations; license/credits. При ещё отсутствующем deployment честно указать, что URL ожидает 06.2, а не оставлять фиктивный линк для итогового выпуска.
3. `arkiv/schema.md` и `docs/protocol.md`: точные type names, атрибуты, payload fields/units, stable identity, protocol/hash domain separation, creator/owner policy, roots/states/proposals/activations/discovery links, atomic primitive и его проверенное ограничение, cursor/block snapshot rules, TTL/consent deadlines и reader error taxonomy.
4. `arkiv/friction.md`: конкретные наблюдения SDK/RPC с датой, minimal repro и impact/workaround/remaining limit. Отличать текущий SDK behavior от предположения и local fixture от live network. Не помещать private keys или чувствительные логи.
5. `docs/operations.md`: настройка network/env, safe dev signer boundary, pending write reconciliation, deploy/runtime configuration, read-only health/verification и обслуживание срока публичных demo records. MAIN связывает здесь финальные команды checkpoint/launch, но обычный продукт не требует установленного skill.

**Приёмка.** README отвечает «что получится и как попробовать» до протокольных деталей. Все команды соответствуют package scripts, links указывают существующие артефакты/адреса, references доказывают заявленные claims. Schema совпадает с validator и read/write code; преимущества Arkiv показаны через независимого владельца/клиент, без обещания магической private database или multi-owner lock.

**Передача.** Один scoped documentation checkpoint с установленной MIT license и окончательными schema/friction. MAIN затем может обновить только подтверждённые deployment links в рамках 06.2; архитектурные расхождения возвращаются владельцу, а не скрываются текстом.

### 06.1.2 Повторить запуск в чистой среде по написанной инструкции
Status: todo

1. MAIN готовит отдельный чистый checkout финального repository state без `.local`, `node_modules`, build/cache, secrets, runtime agent helpers и файлов из внешнего workspace. Не удалять рабочую среду пользователя; никакой destructive очистки для демонстрации «чистоты».
2. Следуя только README, выполнить установку по lockfile и все обязательные обычные проверки; собрать production code, запустить app и отдельный Partner Desk. Проверить HTTP reachability отдельно от содержательных domain/server checks.
3. Из чистой среды воспроизвести no-wallet local/custom domain path и read-only verification публичного примера. Проверить, что остановленный studio не ломает самостоятельный reader/Desk. Production artifacts не содержат dev private keys, local signer route или required ссылок на внешние исследовательские/agent пути.
4. Исправить обнаруженные undocumented prerequisites в docs или вернуть implementation fix владельцу и повторить только затронутый цикл. Пользовательские browser/visual шаги перечислить отдельно и не запускать самостоятельно.

**Приёмка.** Другой человек способен получить работающий продукт и независимое доказательство, располагая README, Git repo и описанными public prerequisites. Сохранены точные commit/runtime/commands и результаты. HTTP 200 лишь подтверждает доступность endpoint; core capabilities имеют содержательную проверку 04/05.

**Передача.** Один checkpoint: reproducibility result и исправленные инструкции. Сломанный clean launch или зависимость от невыданного private asset блокируют delivery; требующая личного wallet запись честно отмечена как пользовательская операция.

## 06.2 Развернуть финальную версию и подготовить честную сдачу пользователю
Status: todo
Requirements: R16, R17, R18
Depends on: 06.1
Owner: SUBAGENT to assign
Paths: none

**Результат и полномочия.** MAIN доводит утверждённый выпуск до реально работающей публичной ссылки, проверяет сервер/HTTP/API и готовит точный handoff. Push в существующий private origin уже разрешён; публичность GitHub repo и финальная отправка формы принадлежат пользователю. Настоящий deploy выполняется в пределах предоставленной авторизации; отсутствие provider login/token указывается конкретно и не заменяется заявлением «развёрнуто». Read-only release worker проверяет готовность и возвращает evidence MAIN; нужные manifests/docs/config edits назначаются отдельно владельцам с точными путями. Внешний `devfolio/ANSWERS.md` создаёт MAIN вне Git продукта.

**Вход.** Финальный verified commit, README, production deployment command/provider contract, evidence 04.2, официальный порядок полей Devfolio и подтверждённые ограничения конкурса. Сроки/ссылки сверить с официальным источником непосредственно перед сдачей. По текущему записанному условию дедлайн 18 октября 22:59 UTC, то есть 19 октября 03:59 Asia/Qyzylorda; demo должна быть доступна как минимум до 23 октября с запасом, видео не длиннее трёх минут. Эти данные не заменяют актуальную сверку.

**Handoff states.** Local working, committed, pushed, deployed, server-verified, user-visual-verified, repository-public и submitted — разные факты. В отчёте записать каждый отдельно. Не закрывать `deployed`, если auth отсутствует, или `user-visual-verified`, если агент только читал код. Publishing не отправляет сообщения третьим лицам и не заполняет финальную форму автоматически.

### 06.2.1 Проверить и развернуть конкретный commit без утечки локальной среды
Status: todo

1. MAIN сверяет scope/working tree/index и отсутствие секретов, внешних research/devfolio/agent artifacts в public commit. Выполнить единый утверждённый checkpoint с реальными проверками и точными путями. Сохранить commit hash; push в configured private origin, без force/reset. При ошибке push сохранить уже сделанный commit и повторить только push после устранения причины.
2. Выполнить документированный deployment для подтверждённого production target с public RPC/config и выключенными dev signers. Если нужны credentials, сначала подготовить все артефакты/конкретную команду, затем вернуть точный необходимый user action; не изобретать альтернативную платную инфраструктуру без основания.
3. Проверить реальный HTTPS адрес: landing/product/Desk endpoints и version/health, safe cache policy для свежести состояния, отсутствие local-only routes. Выполнить remote server/API проверки текущего публичного fixture и schema/protocol version; URL не объявляется рабочим из одного успешного deploy log.
4. Проверить public records lifetime через независимый reader и согласованность deploy commit/evidence/README. Обновить README ссылками только на фактические адреса через владельца docs. Не открывать browser tabs автоматически.

**Приёмка.** Рабочая публичная ссылка обслуживает ожидаемый commit, dataset читается и даёт объяснимый текущий результат, synthetic records живут требуемый срок. Нет production signer/key exposure и неподтверждённых claims. Для pending authorization существует точный готовый artifact/command и ограниченный блокер; задача не помечается завершённой в части deployment.

**Передача.** Read-only release evidence для MAIN плюс actual deploy/push records. Итог содержит URLs, commit, дата/server checks и статус пользовательской проверки, а не «всё готово» при неисполненном существенном gate.

### 06.2.2 Подготовить заявку, план видео и пользовательскую приёмку
Status: todo

1. MAIN создаёт `devfolio/ANSWERS.md` вне репозитория продукта с ответами в точном порядке официальной формы. Включить проверенные product description, problem/how it works, Arkiv-specific use, architecture/security, Open Source and Censorship Resistance evidence using the same independent-client proof, setup/demo/repository/verification links, schema/friction, реальные limitations и честное раскрытие AI-инструментов. Неподтверждённое поле пометить конкретным требуемым действием; не выдавать «TBD» как финальный готовый ответ.
2. Подготовить только сценарий/тайминг видео до трёх минут: понятная проблема; конфликт Cedar; Oak делает план возможным; согласие отличается от feasibility; withdrawal/repair требует новых решений; самостоятельный Partner Desk/CLI показывает реальную роль Arkiv; ссылка и полезный результат. Пользователь записывает и визуально показывает приложение; агент не снимает экран, не симулирует clicks и не создаёт поддельные кадры.
3. Передать пользователю компактный порядок визуальной проверки: landing first action, mobile narrow screen, English-only, keyboard/focus/error recovery, полный учебный путь, свой draft/public boundary, plan/export presentation, отдельный Desk и финальный print/output. Ссылки на реальные local/public адреса и TESTING позволяют пользователю записать находки без повторного пересказа.
4. MAIN читает все пользовательские findings, назначает адресные ремонты и подтверждает невизуальные результаты; только пользователь подтверждает visual fixes. Разрешённые исправления проходят обычный checkpoint/redeploy; submission links и commit актуализируются.
5. Показать два самостоятельных действия пользователя перед отправкой: изменить visibility репозитория на public и отправить финальную Devfolio форму после проверки. Пользователь добавляет настоящее video URL и персональные/team поля, если они неизвестны агенту. Проверка доступности public repo выполняется read-only после сообщения пользователя об открытии.

**Приёмка.** Финальный handoff самодостаточен: что работает; actual demo/repo/evidence links; как запустить/проверить; что подтверждено командами; что остаётся пользователю; точные внешние блокеры. Answers и видео outline опираются на реализованную версию, не приписывают визуальную приёмку, реальных участников или физическое исполнение. Внешний вид, реальная навигация, injected-wallet interaction и понятность первого посещения остаются непроверенными, пока пользователь не сообщил результат. Пользовательская отправка не считается сделанной без пользователя.

**Передача.** Read-only delivery checkpoint, внешний submission draft и video outline от MAIN, актуальный TESTING и явные статусы deploy/publicity/submission. Этап кода и документации может быть принят отдельно от user-owned final submission; канонический STATE не должен скрывать незавершённую часть исходного запроса.




