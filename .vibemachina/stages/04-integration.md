# 04 Проверить весь путь от предложения помощи до нового согласованного плана
Status: active

После этапа три связанные работы — собрать проект, предложить свою помощь и выполнить согласованный план — проходят через общие реальные контракты. Локальная учебная история и публичные записи проверяются отдельно. Вторая независимая программа подтверждает, что библиотека действительно управляет своим предложением, а Arkiv хранит необходимое для восстановления текущего состояния.

## 04.1 Пройти связанные сценарии, восстановление и совместную работу клиентов
Status: todo
Requirements: R03, R04, R05, R06, R07, R08, R09, R10, R11, R12, R13, R14, R18
Depends on: 01.2, 01.3, 02.1, 02.2, 03.1, 03.2, 03.3
Owner: SUBAGENT to assign
Paths: tests/integration/

**Результат и границы.** Организатор получает действительный план, участник управляет собственными предложениями и решениями, а выполнение не теряет сделанное при изменениях. Задача соединяет уже реализованные возможности и выявляет расхождения между ними. Она не подменяет визуальную приёмку пользователя и не объявляет открытый HTTP-маршрут доказательством успешного пользовательского сценария.

**Вход и владение.** Читать экспортируемые контракты domain/solver/readiness из 01.2, persistence/wallet/read-write adapters из 01.3, экспортируемые controller/adapter boundaries из 02.1/02.2; продукт является статическим frontend без обязательного backend, run sheet/export из 03.1 и независимые entry points Partner Desk/CLI из 03.2. MAIN фиксирует точные импортируемые пути при интеграции этих задач. Записывать только `tests/integration/`; исправление реализации возвращать владельцу соответствующей задачи либо получать от MAIN конкретный временный loan. Изменение общей readiness-функции требует повторной проверки всех клиентов.

**Данные и ожидаемые выходы.** Использовать синтетический Small Works с явной зоной времени и абсолютными интервалами: шесть стендов, один монтажный набор, два монтажника и один перевозчик 10:00–12:00, два ведущих 12:00–16:00, подходящее место. Суббота имеет четыре стенда; воскресенье имеет площадку и оборудование, но Cedar способен быть либо монтажником, либо перевозчиком с capacity=1. Проверять конкретные назначения, точный недостаток, набор обязательных владельцев, hash/version плана, decisions, причины невозможности и итоговый run sheet. Дополнительно создать собственный проект с иными числами, ролями и интервалами и ранее неизвестным publisher: invitation→book→offer-link→explicit admission→activation→request-link→fresh independent Desk→decision. Это исключает зашитый сценарий и скрытую зависимость от seed/localStorage.

**Состояния и восстановление.** Изменение входа делает старый вычисленный результат устаревшим; найденный план остаётся предложением. Pending/declined/withdrawn/expired/missing/conflict/unverified различимы. При обрыве ответа сохранены draft, operationId, замороженные параметры и намерение пользователя. Перезапуск восстанавливает незавершённую операцию и проверяет receipt/current state до повтора. Смена account/chain перед отправкой отменяет подготовленную отправку с сохранением черновика. Неполная загрузка страниц или RPC 429 не превращается в «предложений нет» и не оставляет текущий зелёный статус.

**Невизуальная проверка интерфейсных контрактов.** Для English-only проверить наличие всех используемых ключей, совпадающие значения состояний и смысловые подписи в server-rendered HTML, если он есть; статически проверить связанные labels, назначение кнопок и доступные сообщения ошибок. Это не доказывает focus order, touch targets, читаемость, адаптивность или first-use comprehension: они остаются в явном пользовательском checklist. Серверные security и persistence проверки проверяют реальную серверную границу, не имитируют клики.

### 04.1.1 Доказать расчёт, полное согласие и минимальное исправление на связанных данных
Status: todo

1. Прогнать общий domain через реальные adapter/server входы учебного и собственного проекта. Для субботы получить shortage=2 стенда; для воскресенья получить конфликт Cedar и объяснение «нужен ещё монтажник или перевозчик». Сохранение предпочтительного назначения не разрешает silently снять pin.
2. Добавить Oak как перевозчика 10:00–12:00: получить Cedar+Willow на монтаж, Oak на перевозку, Ash+Elm на ведение, площадку и оборудование партнёров. Тот же offer до 11:59 не закрывает интервал. Отдельный последовательный монтаж 10:00–12:00 и ведение 12:00–16:00 допустимы при достаточной доступности; наложение хотя бы части интервала при capacity=1 недопустимо.
3. Выбрать предложение и зафиксировать exact revision. Проверить полный distinct набор необходимых владельцев, отсутствие выдуманных решений, отказ принять чужим wallet и различие между declined и технической ошибкой. До последнего необходимого acceptance готовности нет. Decline/withdraw survive reload. P1-ready→P2→old P1 terms and close→reopen both create fresh activation, and old grants cannot restore Ready.
4. После всех acceptance отозвать Oak: готовность исчезает. Juniper на монтаж допускает ремонт Cedar→перевозка, Willow+Juniper→монтаж. Дельта объясняет каждое изменение; все необходимые владельцы начинают без согласия с новой версией, в том числе неизменившиеся.
5. Изменить содержательное условие выбранного offer: прошлое согласие не годится. Изменить только несвязанное предложение, фильтр отображения или progress note: точный неизменённый согласованный пакет не теряет согласие.

**Приёмка.** Автоматический integration test сравнивает assignment map, blocker codes, required owner set, canonical plan hash и readiness reason set с ожидаемыми значениями, а не только code 200 или число карточек. Для собственного проекта тот же алгоритм строит отличающийся план и обнаруживает специально внесённое противоречие. Сохранённый и заново прочитанный результат совпадает по смыслу; ключи и hash не подменяются локальными fixture-ответами.

**Передача.** Один checkpoint: связанные happy path и содержательные отрицательные случаи, команды запуска и найденные несовпадения; MAIN направляет feature defects владельцам 01–03 до перехода к следующей проверке.

### 04.1.2 Восстановить работу после сбоев и доказать независимость партнёра
Status: todo

1. На server/adapter уровне воспроизвести wallet rejection, wrong chain, account switch, отмену до отправки, timeout после принятой транзакции, закрытие процесса после сохранения pending и обрыв после создания proposal до создания нового plan_activation с потреблением точного прежнего activation. Для unknown outcome сначала найти tx/operationId и состояние; известный подтверждённый proposal использовать повторно, не создавать второй root/offer/proposal и не выдавать успех без доказательства. Сохранять known tx/proposal handles и точные predecessor keys вместе с черновиком.
2. Проверить два разделённых хранилища local practice/public draft. Учебная смена ролей меняет лишь синтетические данные. Public entry не принимает роль, подпись, owner label или acceptance, перенесённые из practice. Переход к публикации сохраняет собственные введённые поля, но не публикует от имени sample parties.
3. Одновременно принять конфликтующие запросы к одному ресурсу в двух клиентах: capacity берётся из актуальной publisher book; stale predecessor приводит к reconciliation/rebase, а не к двум готовым планам. Уже подтверждённые pending reservations учитываются ещё до согласия всех других участников проекта.
4. Запустить Partner Desk как отдельный процесс с собственной конфигурацией RPC и остановить studio server. Через его documented non-UI adapter/command boundary прочитать проект и собственную book, затем выполнить поддержанный авторизованный переход. Убедиться, что запросы не проходят через account/API studio и не читают его приватный storage. Повторно запущенный studio увидит тот же результат после нового полного snapshot.
5. Смоделировать исчезнувший/expired обязательный entity, transferred state, две live state записи одного root, обрыв страницы, unavailable historical block и RPC rate limit. Для каждого ожидается конкретное unavailable/conflict/unverified состояние; нельзя выбирать max revision или воскресить предыдущий state.

**Приёмка.** Повторный запуск поднимает тот же черновик и ровно одну доказанную операцию. Получатель видит подлинное изменение партнёра по общему публичному контракту без studio server. Есть машинная проверка query completeness и единого block B; stale cache не остаётся безусловно ready. Секретные dev signers отсутствуют в production bundle/routes; никакого локального или публичного signer service не выбрано; synthetic signing разрешено только отдельному CLI evidence runner с общим ledger/budget и reviewed allowlist.

**Передача.** Один checkpoint: fault-injection integration suite и журнал проверенных границ. Реальная публичная запись/сеть доказываются отдельно в 04.2. Отсутствующую удобную test boundary добавляет соответствующий владелец по ограниченному loan; браузерная автоматизация не является обходным путём.

### 04.1.3 Сохранить выполненное, правдиво закрыть проект и повторно использовать результат
Status: todo

1. Из согласованного проекта получить run sheet по времени и по ответственному с версией, зоной времени и отметкой проверки. После self-report завершённой установки отозвать будущую часть помощи: выполненная установка остаётся в истории, ремонт касается явно оставшихся работ.
2. Проверить handover equipment как минимум в состояниях giver-reported, receiver-acknowledged, return-reported и return-acknowledged. Несоответствие сторон остаётся видимым; coordinator close не генерирует чужое подтверждение.
3. Закрыть один проект с полным подтверждённым результатом, другой с outstanding return, третий отменить. Получить Completed, Completed with outstanding items и Cancelled с соответствующими фактами. Отмена не позволяет координатору переписать чужую book; освобождение/reconciliation релевантных обязательств следует утверждённому owner-controlled протоколу.
4. Экспортировать proposed, ready и unverified версии: документ содержит именно свой status/version, time zone, assignments, snapshot time/block и пояснение статичности. Проверить содержимое экспортированного файла программно; его печатный вид проверяет пользователь.
5. Использовать recipe: новый draft/root с требованиями, вариантами, инструкциями и provenance; без старых дат бронирования, decisions, reservations, progress и fictional owner promises. Поменять дату и состав требований, пройти новый расчёт и сохранить/заново открыть.

**Приёмка.** Ни одна операция close/export/reuse не повышает достоверность фактов. Все три job проходят последовательно с сохранением/повторным чтением и осмысленным результатом, а не обрываются на вычисленном плане. MAIN сверяет весь TESTING; пользовательские визуальные замечания получают точные изменения и статус `needs-user-check`, не закрываются агентским утверждением.

**Передача.** Один checkpoint: связанный execution/export/reuse набор проверок, перечень пользовательских проверок и оставшихся дефектов. Этап не закрывается с потерей черновика, неверным ready, подменённым согласием или неработающим основным действием.

## 04.2 Получить воспроизводимое доказательство работы Arkiv на Tiramisu
Status: todo
Requirements: R08, R14, R15, R16
Depends on: 01.3, 03.2, 04.1
Owner: SUBAGENT to assign
Paths: tests/arkiv-live/, arkiv/evidence/

**Результат.** Независимый читатель получает публичные root/entity/transaction references и по documented CLI сам восстанавливает точный план, обязательные решения и причины готовности или её потери. Доказательство показывает одновременно полезную работу Partfolk и роль Arkiv; оно не ограничивается транзакцией «hello world».

**Вход и полномочия.** Использовать проверенную chain/RPC конфигурацию 01.3, реальные synthethic fixture accounts только из утверждённой локальной среды и уже созданный независимый CLI 01.3. Читать README scripts и documented public protocol. Обновлять `tests/arkiv-live/` и только публичные данные `arkiv/evidence/`; корректировки CLI/SDK adapter передавать владельцу. Учет tx, operation IDs, расходов и восстановления общий для всех writers; не запускать второй независимый writer на тот же account. Не копировать приватные ключи, environment secrets, реальные персональные сведения или пользовательские drafts в evidence.

**Обязательный входной gate.** Переход create-successor/delete-predecessor использует native atomic batch, но не называется native CAS или общей блокировкой ресурсов всех владельцев. 01.3 должен передать фактический результат ограниченного Tiramisu probe: первый consume создаёт один successor и удаляет predecessor; повторное потребление устаревшего predecessor отвергается целиком и не оставляет второй successor. Сохранить точные A→B и stale A→C параметры, receipt/result и полный fresh read всех heads. Различать отказ на estimation и реально исполненную reverted transaction: estimation rejection сам по себе не доказывает rollback при execution. MAIN выполнил probe 9October2026: A→B успешен, stale A→C estimate вернул точный EntityNotFound(A), только B остался live; evidence arkiv/evidence/atomic-transition.json. Не заявлять тест mined rollback, которого не было. При изменении SDK/primitive требуется новая оценка основания. Не писать «подтверждено» на основании только TypeScript API или намерения сети.

**Протокол доказательства.** Каждое наблюдение хранит code commit, chain ID, RPC network name, protocol/schema version, project root, proposal entity/hash, publisher roots/state keys, tx hashes, receipt block, выбранный query block B с hash/timestamp, expected result и фактически прочитанный result. Все страницы читаются на одном B; event/receipt — ориентир для запроса, а не замена полной materialization. Evidence различает исторический snapshot и текущий статус после withdrawal/expiry. Consume/delete/expiration не дают обещания вечной queryable истории состояния: необходимые historical proofs сохраняются как явно датированные evidence artifacts. Исторический запрос допустим только при фактически доступной поддержке RPC; недоступность не маскируется текущими данными.

### 04.2.1 Подтвердить публикацию и решения независимых владельцев
Status: todo

1. Проверить prerequisites atomic gate, текущий chain ID, balances, ограниченный расходный бюджет, runtime versions, заданный lifetime и ledger незавершённых операций. Решить ранее неизвестные исходы до новой записи.
2. Опубликовать минимальный по числу записей, но полный по смыслу публичный Small Works: подлинные owner roots/books, project root/current state, immutable proposal. Только синтетические понятные labels; исходные draft/sample actors не считаются настоящим согласием.
3. Зафиксировать proposal без всех decisions и независимым CLI получить Awaiting agreement с точным недостающим набором владельцев. Последовательно опубликовать owner decisions из их разрешённых клиентов/локального демонстрационного механизма и после последнего проверить Ready на полном snapshot.
4. Отдельный процесс Partner Desk/CLI должен читать и выражать owner decision при остановленном studio server; наблюдение studio после refresh совпадает с независимым чтением. Публичный production клиент сохраняет injected-wallet authority boundary: наличие локальных demo signers не даёт ему права действовать за участников.
5. Проверить TTL actual records: корневые, текущие и proposal записи доступны на планируемый срок демонстрации с запасом, а book не истекает раньше содержащихся действующих обещаний. Продление entity life не продлевает business consent автоматически.

**Приёмка.** Есть действительные tx receipts и публично прочитанные records, проверяемые документированной командой. CLI не обращается к studio API/базе; result содержит источник, block/time, assignment map, acceptance set и status. Повторный запуск evidence generator reconcile существующий operationId и не пересоздаёт публичный пример при timeout. Нет превышения согласованного бюджета или необъяснённых pending writes.

**Передача.** Один checkpoint: public manifest, команды и read-back assertions. Отдельно перечислить полученные доказательства и всё не проверенное на реальной сети; local fixtures не выдаются за Tiramisu receipts.

### 04.2.2 Проверить потерю готовности, новое согласие и независимую сверку
Status: todo

1. Сохранить manifest согласованной версии и выполнить withdrawal Oak через его owner transition. Независимо пересчитать: текущая готовность снята, причина указывает необходимое ушедшее предложение. Studio и Desk после refresh дают совместимые результаты.
2. Создать repair с Juniper и Cedar в новой роли. До новых решений всех актуальных участников показать 0 of N для новой revision. Старые acceptance остаются историей, даже у неизменившихся владельцев. После свежего полного набора decisions независимо проверить новую готовность.
3. Проверить stale concurrent consume на безопасных отдельных synthetic fixture records и сохранить фактический receipt/revert результат без повторной траты при неизвестном исходе. Cross-project conflicting approvals не могут дать две готовности при превышении одной public book capacity; назвать границу, что protocol не предотвращает Sybil или ложные физические обещания.
4. Негативные случаи с истечением, transfer, malformed payload, incomplete pagination и RPC outage проверять безопасными fixture/injected transport тестами, если live выполнение создаёт ненужные расходы или повреждает главный демонстрационный пример. Evidence явно помечает `live network` либо `deterministic test` для каждого утверждения.
5. Прогнать verification CLI по сохранённому manifest из отдельного процесса; проверить текущую reference integrity и объяснить, почему прошлый ready snapshot может отличаться от текущего статуса. Удалить из evidence все внутренние пути, секреты и нерелевантные сырые логи.

**Приёмка.** Проверяющий воспроизводит полезную последовательность proposal → consensus → withdrawal → repaired proposal → fresh consensus. Публичные доказательства связаны с конкретными security/open-source/product claims, а не заменяют их общими рекламными фразами. Ограничения — публичность данных, TTL, truthful owners, полнота RPC snapshot и отсутствие доказательства физического исполнения — записаны рядом с соответствующим claim.

**Передача.** Один checkpoint: окончательный evidence manifest и вывод независимого verifier. Результат входит в schema/friction, README и submission только после фактической проверки. Root must gate/receipt uncertainty, неустранённый readiness дефект или неподтверждённая атомарность запрещают завершение задачи.






Targeted acceptance from the explicit user review (existing04.1/04.2 scope): fresh independent process with no cache reconstructs P1→P2→P3 and diffs; P3 restoring P1 terms still parents P2 and needs fresh consent. Expire/delete book_state while publisher_root stays live, explicitly recover empty same-root book then redeclare availability; expired/invalid root requires new identity/readmission. Edit recipe on an agreed project before activation and assert new Needs are Draft changes—not agreed while the old immutable plan is separately inspectable. Cover reservation through planned equipment return. Existing independent Desk/CLI proof supports both OS and CR, with Studio stopped and no Studio API dependence; shared RPC limits remain explicit.

