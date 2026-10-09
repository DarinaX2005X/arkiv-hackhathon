# Состояние Partfolk
Phase: build
Approval: approved
Active stage: 04
Active task: 04.1

## Сейчас

Пользователь9October2026 явно одобрил концепцию и полный масштаб: «План Partfolk в целом сильный, концепцию и масштаб сохраняем»; «Продолжай разработку Partfolk по существующему плану и `$vibemachina`». Четыре точечных исправления включены в существующие задачи без нового цикла планирования и без сокращений. PROTOCOL переписан как единый контракт; DESIGN/PLAN/stages синхронизированы с activation, отсутствием глобального каталога и English-only.

01.1 foundation передал shared DTO/Repository, context/storage/router/UI/fonts; пути возвращены MAIN. 01.2 domain/local готов к интеграции:79 domain tests, generic solver и независимые validation/consent/execution/recovery. 01.3 direct Arkiv adapter/wallet/CLI реализованы; fault review продолжается. 02.1 projects и02.2 contributions готовы к первой интеграции, работники заканчивают controller tests. 03.1 execution и03.3 landing/help в работе после передачи стабильных контрактов. MAIN подключает route registry, раздельные practice/custom/public runtimes и wallet controls; затем самостоятельный Desk.

Точечные гарантии: immutable predecessor chain с fresh P1→P2→P3/diffs; same-live-root empty-book recovery после явного owner acknowledgement, иначе new publisher/readmission; изменённый draft recipe не получает старое Agreed; equipment reservation занимает время до возврата. Каждая новая активация требует всех fresh decisions. Closure consumes activation atomically. Domain audit fixes cover forged completion, transfer/return credit association and cross-project custody isolation.

## Авторизация и треки

Open Source primary + Censorship Resistance secondary, по официальной rubric и external research/partfolk-dual-track.md. Один нормальный самостоятельный Desk/CLI и существующее доказательство03.2/04.2 служат обоим трекам. CR ограничен независимостью от Studio host/API; общая Arkiv/RPC инфраструктура, истечение и права владельцев остаются явными. India исключена. Весь продукт English-only. Русский чат/planning prose допустимы.

Push в private origin разрешён. Пользователь сам меняет GitHub visibility и отправляет Devfolio. Визуальные/browser проверки целиком пользовательские. NO CUA/browser-control/headless/renderers/screenshots/UI automation и никаких автоматических tabs у всех работников. Невизуальная проверка не подменяет эти статусы.

## Проверено

SDK0.8.1/viem2.57.4; Node22.13/npm10.9.2. Bootstrap tx0xd9a9eb50a203afc13c5a28df1707eca01c66fab19837eacb91c72e11c22b2ba3. Atomic createA block352006 tx0x0170cf0c6534e5b1bdaf470a8acc119f45949629283cd751e332f668f84069fd; replaceAwithB block352065 tx0x80e46f7b11e8e413f75a696484524b976f95bb4da695816ed56cd6737268925a; staleA estimate exactEntityNotFound, onlyB block352164. No paid stale send/mined rollback proof. Total actual0.000326176000652352testGLM within0.1 ceiling. Public evidence under arkiv/evidence. Secrets/journals remain ignored.local, never printed/committed. Rootalonebroadcast.

Foundation14tests +19bootstrapguards/build/HTTP assets passed earlier. Domain79tests passed. Arkiv reader50, wallet/controller23, verification/error52 mocked tests passed; these are not live product proof. Shared action6tests passed. Contributions8controller tests passed. Project editor47tests passed. Full integration suite will run after worker handoff; no shipped/UI quality claim from partial checks.

## Сервисы и следующие действия

VibeMachina dashboard http://127.0.0.1:4177/ работает. Studio http://127.0.0.1:5173/ and standalone Desk http://127.0.0.1:4174/desk.html are running. Root/desk/module/font/logo HTTP200 verified; no browser opened. User has links for visual review. Complete03execution/Desk/landing; then04integration/realnetwork proof,05blindoriginalbrief review/fixes,06cleanlaunch/docs/deploy/submissiondraft. Existing full six-stage plan retained. Hosting authentication still unresolved; prepare concrete release first.

MAIN owns canonical docs/shared paths/package/Git/checkpoints/integration. Workers own bounded feature/domain/data paths. Read TESTING at boundaries; currently no user findings. Product/Git stays arkiv/; external suppliedinstructions/research/devfolio stay outside. Last pushed37c93e1 planning; product implementation currently uncommitted while modules converge. Do not add unrelated unfinished files into scoped checkpoints.

Current integrated handoff:01–03code complete; rootStudio route/runtime/wallet wiring complete, independentDesk built. Fullcheck339unit+19bootstrap and bothbuilds passed, then23 additionalruntime tests and targetedfeatureupdates passed. Corecheckpoint runs currentfullsuite beforecommit. Publicproof runner design underway, no productbroadcast yet. Fresh blindoriginalbrief reviewer active, read-only. Runtime reset now creates a fresh practice app namespace so old pendingcommands/drafts cannotreplay against reseededkeys.

