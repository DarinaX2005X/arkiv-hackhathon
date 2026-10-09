# План Partfolk

## Результат

Полный связанный путь: создать свой проект или открыть практику → собрать собственные предложения участников → получить объяснимые совместимые варианты → согласовать точную версию → провести работу и подтвердить передачи → заменить выбывший вклад → завершить с честными исключениями → экспортировать и использовать рецепт снова. Самостоятельный Partner Desk и CLI используют реальные записи Arkiv. Первая вертикальная поставка не заменяет этот полный объём.

Авторитетный scope: [PROJECT](./PROJECT.md), поведение и identity: [DESIGN](./DESIGN.md), требования: [REQUIREMENTS](./REQUIREMENTS.md). Понятное объяснение каждой задачи: [PLAN-HUMAN](./PLAN-HUMAN.md). Подробный протокол: [PROTOCOL](./PROTOCOL.md).

## Общие контракты

MAIN интегрирует shared declarations до зависимых задач. `src/domain/types.ts` содержит JSON DTO и discriminated unions; `src/domain/` не зависит от React, browser globals или SDK. `src/data/types.ts` определяет Repository. Feature modules используют общий context/controller, не SDK и не чужую localStorage. Exported DTO не содержат bigint; metadata block/wei сериализуются десятичными строками, Unix milliseconds — безопасными целыми.

Repository возвращает явный Result либо типизированную ошибку, никогда пустой успешный список при ошибке RPC. Контракт: listProjects; loadProject(rootKey, snapshot?); loadPublisher(rootKey,snapshot?); prepareProjectDraft; createProject; registerPublisher; replaceProject(expectedHeads,newState); replaceBook(expectedHeads,newBook); publishProposal; activateProposal; listOwnPublishers; listIncomingOffers; listRequests; publishProjectLink; reconcile(operation); exportPacket. Независимые Arkiv и Local adapters реализуют одинаковую доменную семантику. Для Local ключи имеют отдельный tagged формат local:*, невозможный в onchain arguments. Public roots имеют bytes32 key.

ProjectAggregate включает root, единственный project state и plan_activation либо диагностический конфликт, proposal history, приглашённые publisher roots и их current books, полное описание snapshot/receipt/data provenance. Прочитанные raw entity проверяются ДО попадания в trusted aggregate. User actions хранят frozen operation ID, canonical input, expected predecessor keys, signer/chain and submitted hash. UI не создаёт новый operation при unknown result.

Домен экспортирует validate/canonicalize/hash, solve(input,pins,budget), independentlyValidatePlan, deriveReadiness(snapshot,now), allocation/capacity checks, planDiff, remainingWork, execution verdict и reuseRecipe. Solver returns candidates, конкретные missing/conflict причины, exhausted/optimality; UI переводит typed reasons. Сортировка и hash не зависят от locale. Новая версия material terms всегда очищает требование текущего согласия всех; old evidence остаётся historical.

Маршруты Studio: /, /demo, /workspace, /projects/new, /projects/:id с вкладками needs/plans/agreement/runbook/history, /contributions, /requests, /help. Hash routing допустим для переносимого static hosting, но canonical router выбирается foundation и одинаков для всех feature links. Desk — отдельный HTML entry и отдельный dist-desk с прямым RPC. Public project link включает только root key; локальный id не выдаётся за совместный публичный проект.

Shared UI: Button,Field,Select,Checkbox,Dialog,Notice,Tabs,Loading/Empty/Error,RequirementRow,ContributionRow,PlanDiff, status labels. Примитивы получают полностью локализованные строки; feature catalogs colocated, общий i18n typed. Feature owns только свой каталог. MAIN интегрирует route/i18n registry. Shared tokens/font assets/mark в одной основе; нет worker-local палитр.

Команды foundation: npm run dev; npm run typecheck; npm run test:unit -- [path]; npm run build; npm run build:desk; npm run check (types+tests+bothbuilds); npm run verify -- <root>. Базовые bootstrap node tests остаются runnable без сборки. Checkpoint через существующий VibeMachina helper с реальным check wrapper и explicit paths. Все команды документируются как реальные только после успешного запуска.

## Этапы

| Этап | Результат | Файл | Зависимости |
| --- | --- | --- | --- |
| 01 | Общие контракты, настоящий solver и надёжное хранение | [01](./stages/01-foundation.md) | Reviewed complete package under explicit autonomous build instruction; successful atomic feasibility |
| 02 | Собрать свой проект и договориться с владельцами | [02](./stages/02-projects.md) | 01.1–01.3; 02.1 и 02.2 parallel after contracts |
| 03 | Провести проект, подключить партнёра и объяснить продукт | [03](./stages/03-complete-work.md) | Execution after 02.1–02.2; Desk after 02.2; landing after 01.1 |
| 04 | Интегрированный продукт и реальное независимое доказательство | [04](./stages/04-integration.md) | Whole 02–03; live proof after reviewed adapters |
| 05 | Независимая проверка исходного обещания и исправления | [05](./stages/05-review.md) | Integrated full suite; confirmed defects repaired |
| 06 | Воспроизводимый запуск, публичный сайт и конкурсный пакет | [06](./stages/06-delivery.md) | Review complete; visual status stated honestly |

## Владение и проверки

MAIN: canonical .vibemachina, package/lock, shared contracts, route/i18n registries, checkpoint configuration, Git, integration and bounded fixes. A worker may receive an explicit temporary loan of named shared files only while dependent writers are stopped. No simultaneous shared-file edits. Every task handoff lists paths, commands/results, known limitations and one meaningful next user check. MAIN reads entire TESTING after each task and before checkpoints/dispatch; preserved user text is never replaced.

Unit/domain tests cover real invariants and adversarial cases; component behavior is checked through data/control contracts and static accessibility review. No browser automation or renderer inspection. HTTP 200 proves reachability only. A feature requiring visual acceptance remains user-unverified until the user checks it. Evidence separates local simulation, mocked failure checks and actual network operations.

## Autonomous selection and delivery authority

The original human instruction explicitly delegates independent selection and says to fix the concept and proceed to implementation without stopping at planning. This user instruction overrides the generic VibeMachina approval gate. MAIN presents this complete reviewed package before dispatch and proceeds under that authorization; it does not claim the user separately approved the Partfolk name or infer consent from silence. Record the actual original instruction and package fingerprint in STATE. Wallet setup and bounded SDK feasibility are already authorized and separate. Repo stays private until user changes visibility; user submits final Devfolio. MAIN prepares deployment and exact release materials, requesting only missing host authentication when necessary.

