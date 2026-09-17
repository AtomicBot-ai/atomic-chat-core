# PLAN.md — выделение ядра инференса Atomic Chat в `atomic-chat-core`

Единый документ по проекту: откуда мы, что решили, как устроено ядро, в каком порядке переезжает приложение,
чем проверяем. Разделы 1–7 — план. Раздел 8 — исходная порт-спека; её факты сверяются с текущим кодом приложения.
Совместимость означает сохранение поведения, форматов и значимых полей; правила сравнения и разрешённые отличия — §5.1.
Это целевое состояние, не отчёт о готовности: реализованные проверки и пробелы отмечаются в `docs/testing-critical-flows.md`.

Соглашения: `<data>` — папка данных приложения (macOS `~/Library/Application Support/Atomic Chat/data`,
Windows `%APPDATA%\Atomic Chat\data`, Linux `~/.local/share/Atomic Chat/data`). Пути вида `src-tauri/...`,
`web-app/...`, `extensions/...` относятся к репозиторию приложения `../Atomic-Chat`. Пути вида `src/...`, `test/...` — к этому репозиторию.

**Пересмотр этапа 4 (2026-09-17):** [ADR о разделении владельцев](docs/decisions/2026-09-17-isolate-app-and-cli-owners.md)
заменяет нижеописанные общую папку/владельца, межscope-миграцию настроек и detach при полном выходе приложения.
CLI использует отдельную `<system data>/atomic-chat-cli/data`, приложение — прежнюю `<data>`; бинарь владельца
приложения `atomic-chat-app-core` живёт только до полного выхода либо истечения регистрации, CLI — до явного shutdown.
Исторические записи журнала оставлены как свидетельство прежнего плана, не как текущие критерии приёмки.

---

## 0. Порядок работы и журнал

**Как двигаемся.** Итеративно, одним небольшим шагом за раз: шаг выбирается из текущего этапа §4, формулируется до начала
(что делаем, что не трогаем, чем проверяем), выполняется, проверяется `npm run verify` (для `src/runtime/` — плюс `test:e2e`
на своей ОС), и только потом отмечается ниже. **Отсечка с отчётом владельцу — по закрытию этапа**, не после каждого шага: внутри этапа
шаги идут подряд без остановки, каждый со своей строкой в журнале. Отчёт по этапу: что сделано, что найдено, что не сделано
и почему, критерий выхода с результатом проверки. Остановка внутри этапа — только если шаг требует решения владельца
(новая зависимость, изменение решения §2/§3, ADR). Не начинать модуль, пока предыдущий не зелёный. Каждая запись журнала — одна строка: дата, шаг, результат, ссылка
на проверку. Если шаг меняет решение из §2 или §3 — сначала ADR, потом код.

**Статус этапов.**

| Этап | Статус | Примечание |
| --- | --- | --- |
| 0 | закрыт | ядро: `npm run verify` зелёный; 7 наборов фикстур, 4 реплеятся, 3 — форма до этапа 4; приложение: `make verify` красный только на трёх pre-existing проблемах вне скоупа (см. журнал 2026-09-15, последняя запись); решения владельца по прокси, `backend/` и Makefile приняты и выполнены (журнал 2026-09-15, последние записи) |
| 1 | закрыт | владелец, control API, публичный listener, CLI, e2e на бинаре, live на настоящем llama.cpp; `npm run verify` зелёный |
| 2 | закрыт кроме релизной проверки | всё, кроме запуска подписанного universal-артефакта на arm64+x64 и нотаризации — это требует настоящего релизного прогона |
| 3a | закрыт | приложение attach-ится к владельцу, heartbeat, SSE-relay, флаги отката; focused `core::atomic_core` 73/73, полный Rust suite 920/920, `make test-core-live` 6/6 против настоящего бинаря |
| 3b | закрыт после review-fix, кроме ручной приёмки | in-scope проверки зелёные; сценарии «локальный чат / агент / Codex / /models / /metrics / embeddings / auto-ctx / unload при core и legacy» требуют запущенного приложения с моделью. Полный `make verify` приложения остаётся красным на pre-existing test-quality allowlist и двух несвязанных web-тестах; см. review-fix в журнале |
| 3c | review-fix реализован; ручная приёмка открыта | core-owned install/cancel, legacy UI events, signed mirror+proxy и revisioned optimal-cache проверены контрактно; install/update/«Find optimal backend», прогресс и отмена требуют прогона текущей сборки приложения; полный `make verify` останавливает прежний test-quality allowlist |
| 3d | review-fix реализован; ручная приёмка открыта | core-owned embed route и batching/501 покрыты тестами; RAG с живой моделью не проверен; полный `make test-extensions` блокируется отсутствующим локальным JS-билдом hardware-plugin |
| 4a | закрыт | три шима реплеятся побайтово, `PENDING` пуст |
| 4b–4e | review-fix реализован; приёмка открыта | app/CLI изолированы; передача listener, восстановление после новой generation, CLI-lease и привязка cloud-ключа к конфигурации проверены на нижних слоях. `npm run verify` ядра и app live supervisor зелёные. Полный `make verify` приложения останавливается на Yarn 1.x вместо требуемого Yarn 4.5.3; UI/внешние агенты не проверены |
| 5 | review-fix реализован; приёмка открыта | ядро (FM, MLX, TurboQuant) и приложение (`runtime=all`, селекторы, импорт настроек, откат); гонка load/unload проверена e2e на собранном macOS-бинаре ядра, загрузка под переходом владельца — focused-тестами. TurboQuant live на реальном форке, FM live только путь отказа, MLX live не запускался; переключение флага в живом Tauri UI не проверено |
| 6 | не начат | — |

**Журнал.**

- 2026-09-17 (review-fix этапа 5) — Загрузка TurboQuant/MLX/FM в расширениях держит provider-lease с начала подготовки до завершения операции; передача владельца под тем же gate отклоняется при такой загрузке. В ядре acquire/unload сериализованы по модели, выгрузка sidecar дожидается начатой загрузки, повторные unload объединяются, shutdown дожидается окончания остановки child, claim снимается только после успешной выгрузки. `npm run verify` ядра зелёный: `test/e2e/stage5-sidecars.test.ts` 2/2 на собранном macOS app-core, весь бинарный e2e 38 passed / 1 skipped. Rust focused, `cargo check`/`clippy` и app live `make test-core-live` 16/16 зелёные; полный `make verify` приложения остановлен глобальным Yarn 1.x вместо 4.5.3. Живой Tauri UI-handover, MLX-модель и положительный FM-путь всё ещё не проверены.
- 2026-09-17 (этап 5e) — Live: `test/live/turboquant.test.ts` на реальном форке `b10269-1.6.0` + Qwen3.5-9B IQ4_XS прошёл (процесс запущен с `--cache-type-k/v turbo3 --flash-attn auto`, ответ через `/v1`, рост контекста до 8192, выгрузка). `test/live/foundation-models.test.ts` на `foundation-models-server`, собранном из исходников приложения во временную папку: Apple Intelligence на машине выключен (`appleIntelligenceNotEnabled`), ядро за <1 с отказывает `FOUNDATION_MODELS_UNAVAILABLE` без висящей сессии; путь с ответом не проверен. `test/live/mlx.test.ts` написан, не запускался: в `resources/bin` пустые заглушки, модели MLX нет. App live `make test-core-live` 16/16 на пересобранном `atomic-chat-app-core`, включая новый `the_core_finds_the_sidecar_servers_the_app_bundles`. Критерий «приложение + `atomic-chat-cli serve` одна модель → один процесс» устарел после ADR об изоляции владельцев (разные папки данных) и не проверялся.
- 2026-09-17 (этап 5d) — Приложение. Rust: `CoreRuntimeOwner::All` (`atomic_core.runtime = "all"`) = upstream + TurboQuant + MLX + FM; `apply_ownership`/`active_runtime` по набору; передача проверяет пустоту исходящей стороны для каждого меняющегося провайдера (FM — по таблице плагина), откат `all → llamacpp-upstream|off` той же проверкой; регистрация внешних desktop-сессий публикует только не принадлежащие ядру провайдеры и снимается целиком при `all`; `launch.rs` передаёт `--resources-dir <resources>/resources/bin`. Расширения: общий адаптер `extensions/shared/atomicCoreRuntime.ts` (провайдер-параметр, `all` = владение, `invoke` передаётся извне) и `atomicCoreSettingsSync.ts` (import → зеркало под guard → acknowledge → hardware override, мемоизация по поколению); upstream-адаптер стал обёрткой. TurboQuant: load/unload/сессии/chat/токены/устройства/auto-ctx/recreate/установка бэкенда (с `asset_name`) через ядро, импорт настроек до load, зеркало `settings:changed`. MLX: загрузка через ядро с уже восстановленным драфтером, unload/сессии/chat/auto-ctx, импорт и зеркало настроек без перезапуска сессии. FM: сессия/load/unload/chat через ядро; availability остаётся у плагина (не владеет процессом). Webview: FM-сессия сначала из резолвера. download-extension отменяет core-задачи и при `all`. Vitest-конфиги TurboQuant/MLX-расширений резолвят пакеты плагинов в `guest-js` — их `autoIncreaseCtx` наборы раньше падали на несобранном `dist-js`. Проверки: Rust приложения 987 + plugins (179/16/5), app vitest 3188, node-тесты 42/42, extensions TurboQuant 259, MLX 66, upstream 341 (включая 10 тестов общих модулей), download 23; `npm run verify` ядра зелёный. Ручной переключатель флага в UI отсутствует (как и для upstream).
- 2026-09-17 (этап 5c) — TurboQuant (`llamacpp`) в ядре тем же `LlamacppRuntime`. Rust-фикстуры `args-llamacpp` (70 кейсов из `tauri-plugin-llamacpp/src/args_fixture_dump.rs`) нашли расхождение: Vulkan-override `flash_attn auto→off` ядро применяло к обоим провайдерам, а TurboQuant его не имеет — на Vulkan-сборке терялся дефолтный turbo3 V-кэш; override ограничен `llamacpp-upstream`, MTP/DFlash принудительно выключены в argv и в плане загрузки (драфтеры не ищутся и не качаются). `backend/turboquant.ts`: матрица и id форка, фичи (Windows CUDA 12 порог 527.41, ROCm только Linux по amdkfd `gfx_target_version` + `libamdhip64.so`), категории/приоритеты с порогом VRAM 6 GiB, сортировка unified-тегов `b<build>-x.y.z` выше legacy и по рангу, имя ассета (запрос `asset_name` → дисковый кеш release-index расширения → конвенция), ремонт cudart на Windows (донор из upstream-пакета, затем pinned `b10205`). Диспетчеризация по провайдеру в `selectInstalledBackend`/`ensureBackend` (ремонт cudart перед загрузкой, сбой — предупреждение), `BackendService.install` (CDN форка без checksum — паритет, cudart после установки), optimal-cache принимает записи `llamacpp`. Каталог релизов, first-run adoption, reconcile/update и bundled baseline остаются в расширении (как для upstream после 3c). Отличие: при отсутствии настроенного пакета ядро берёт лучший совместимый установленный, расширение качало заданный. `npm run verify` зелёный.
- 2026-09-17 (этап 5b) — MLX в ядре: `runtime/mlx` (`args`, `errors`, `config` и `shard-repair` дословно из расширения, `model-files`, `MlxRuntime`). Rust-фикстуры `tests/fixtures/core-contracts/mlx-{args,errors}` (20 argv, 20 stderr) из `tauri-plugin-mlx/src/commands_fixture_dump.rs` реплеятся побайтово. Загрузка: одна за раз, авто-выгрузка остальных MLX-моделей, ремонт шарда, контекст из `config.json` с потолком 16384/4096, драфтер из overrides либо с диска (без скачивания при загрузке — расширение скачивает до вызова, CLI грузит без драфтера, как расширение при сбое), `MLX_VLM_SINGLE_MODEL=1`, раздельные маркеры готовности stdout/stderr, мгновенный kill по таймауту. auto-ctx по лестнице с сохранением драфтера/квантования, recreate, `session:died` (новое: плагин не следил за процессом). Регистрация только на macOS; `serve --provider mlx --resources-dir`; публичный сервер маршрутизирует MLX и растит контекст при переполнении mlx-vlm (`src/core.test.ts`). Каталог MLX-моделей (list/import/download, vision/audio/tools) остаётся в расширении. `npm run verify` зелёный.
- 2026-09-17 (этап 5a) — Общий `LocalRuntime` (llama.cpp реализует без изменения поведения), `SidecarTable` (очередь загрузок, журнал PID, наблюдение за выходом, выгрузка 5 с / shutdown 2 с), `log-stream`; `spawnAndAwaitReady` получил `failOnLine`, `timeoutError`, `timeoutGraceMs`, маркеры по потокам. Foundation Models в ядре: `runtime/foundation-models` (`apple/on-device`, `--port/--api-key` с секретом расширения, готовность по stdout, причина `[foundation-models] ERROR:` прерывает старт сразу, `--check` с кешем 30 мин и таймаутом 30 с, `session:died`). Rust-фикстуры `foundation-models-errors` (11) реплеятся; исправлено осознанно: «downloading or not yet ready» → `FOUNDATION_MODELS_UNAVAILABLE` (приложение давало `PROCESS_ERROR`). Новые коды `MLX_PROCESS_ERROR`, `FOUNDATION_MODELS_UNAVAILABLE`, `SERVER_START_FAILED`, `SERVER_START_TIMED_OUT`, `PROCESS_ERROR`; `GET /runtimes/foundation-models/availability`; `--resources-dir` у `atomic-chat-app-core daemon`, CLI `daemon` и `serve --provider foundation-models`. Публичный API FM не маршрутизирует (паритет). `npm run verify` зелёный.

- 2026-09-17 (дополнительный review-fix этапа 4) — Чтение прежних флагов перенесено под transition gate; ожидающий ChatGPT-login отменяется до gate; сбой записи настроек запускает обратную передачу listener, а неподтверждённый откат закрывает операции до перезапуска приложения. Потерянные ответы `/server/stop` и `/server/start` проверяются через статус: второй listener не открывается при неизвестном или уже работающем первом; подтверждённый остановленный сервер сообщается webview без секрета. При новой generation приложение повторно публикует сессии/провайдеров и поднимает только ранее запрошенный публичный API, не чаще раза на generation. App startup не присоединяется к прежнему владельцу той же версии; CLI держит регистрацию с heartbeat на время команды; cloud-ключ записывается с хешем конфигурации до настроек и не маршрутизируется при несовпадении. `npm run verify` ядра прошёл целиком (включая coverage, Bun-контракты и бинарные e2e); focused Rust ownership 13/13 и app live 15/15 после сборки нового бинаря прошли. `make verify` приложения недоступен из-за глобального Yarn 1.x без Corepack; тесты настоящего Tauri UI, live-cloud и агентов остаются открытой ручной приёмкой. Этап 5 не начат.

- 2026-09-17 (review-fix этапа 4) — Отдельные `atomic-chat-app-core` и CLI-владелец с `owner_scope`, CLI `<system data>/atomic-chat-cli/data` и отказом для app-папки, app exit/lease и безопасной заменой прошлой версии, pin `0.2.0` и проверка обоих бинарей до сборки. Исправлены сериализация cloud-реестра/ключей, ChatGPT reload после handover, единый transition gate и порядок замков extension→core, запоминание только успешного server start, публикация/поколенческое снятие внешних сессий до/после listener; rollback неоднозначного start проверяет и останавливает listener, но не трогает конкурентный `AlreadyRunning`. `npm run verify` ядра зелёный, `test/e2e/scopes.test.ts` 3/3, `make test-core-live` приложения 12/12 плюс два новых focused live-кейса замены старой версии/непроверяемого PID, `make test-rust`, `make test-web` и Rust-контракты зелёные, локальная упаковка версии/подписи прошла. `make verify` приложения упирается в существующие web test-quality нарушения, `make test-extensions` и critical coverage — в несобранный JS hardware-plugin; ручные Tauri UI и живые Codex/Claude Code/OpenCode/ChatGPT не проверены. Этап 5 не начат.

- 2026-09-15 — Каркас репозитория: манифесты, tsconfig, eslint с гейтами runtime-agnostic и test-quality, vitest на 6 проектов, `src/contracts/*` (errors, session, model-yml, settings, events, control-api), заглушки `index.ts` всех модулей, `cli/{bin,main}.ts`, тестовые слои с README, `scripts/*`, docs, CI. `bun install`, `git init` (без коммитов). `npm run verify` зелёный на macOS arm64: lint, typecheck, prettier (`*.md` исключены), 9 unit-тестов, `tsc`, Bun-бинарь `aarch64-apple-darwin`, e2e на бинаре.
- 2026-09-15 — ADR: «Core is TypeScript…», «Sidecar control protocol…» (superseded в тот же день), «Independent core owner and migration contracts» (владелец). `docs/contracts.md` переписан под §5.1.
- 2026-09-15 — Fixture-emitter `args`: в приложении `args.rs` получил `#[ignore]`-модуль `fixture_dump` (73 кейса — по одному на правило эмиссии и гейт сборки; `default_config` стал `pub(super)`); `cargo test --lib args::` 97 passed, `cargo test --lib -- --ignored dump_fixtures` пишет `tests/fixtures/core-contracts/args/{<case>,index}.json` с source-коммитом `ccf5427` и comparator `argv-exact`. Импортировано в ядро: `test/fixtures/app/args/` + `CHECKSUM`. Находка: float-поля (`defrag_thold`, `rope_*`) в Rust f32 и сериализуются с f32-округлением; порт обязан сравнивать через `Math.fround` (записано в `index.json`). `make verify` приложения на этом шаге не гонялся, только suite плагина.
- 2026-09-15 — Fixture-emitter `errors`: `error.rs` получил unix-only `#[ignore]`-модуль `fixture_dump` (40 кейсов: каждая подстрока каскада, приоритет внутри каскада, регистронезависимость, stdout-фолбэк и details-правила, сигналы 11/6 как крэш, 9/15/код 139 как не-крэш); `cargo test --lib error::` 3 passed; фикстуры `tests/fixtures/core-contracts/errors/`, comparator `error-exact`. Импортировано в ядро, `CHECKSUM` обновлён. Находки: при крэше с пустым stderr `details` = `""` (поле присутствует), а не отсутствует; Windows-коды крэша emitter не воспроизводит (unix), порт пинит их своей таблицей.
- 2026-09-15 — Fixture-emitter `runtime-device`: `runtime_device.rs` получил `#[ignore]`-модуль `fixture_dump` (31 кейс: 12 сценариев из unit-тестов + дедуп бэкендов, приоритет summary над repeating, tie-break равных буферов, max по дублю метки, `CPU_*`-метки, ненулевой GPU-буфер при 0 слоёв, единицы GiB/KiB/bytes/неизвестная, 6 подстрок `device_init_error`, битые offload-строки, пустые строки); `cargo test --lib runtime_device::` 15 passed; фикстуры `tests/fixtures/core-contracts/runtime-device/`, comparator `runtime-device-exact`. Импортировано в ядро. Запинено: при равных буферах побеждает меньшая метка; ненулевой GPU-буфер при 0 offloaded → `primary_device:"CPU"`, но `gpu_buffer_bytes` заполнен; неизвестная единица размера = байты.
- 2026-09-15 — Fixture-emitter `devices`: `device.rs` получил `#[ignore]`-модуль `fixture_dump` (22 кейса: три известные формы строк, отсутствие/регистр/пробелы заголовка, пустая секция, смешанные строки, вложенные скобки, «последняя скобка побеждает», отклонение `MB`/без запятой/`used`/без числа/без двоеточия, нули, двоеточие в имени, порядок, CRLF, повторный заголовок); `cargo test --lib device::` 30 passed; фикстуры `tests/fixtures/core-contracts/devices/`, comparator `devices-exact`, ошибка сериализуется как `{code:"DEVICE_LIST_PARSE_FAILED", message, details:<весь stdout>}`. Импортировано в ядро. Все четыре emitter'а Rust-механики готовы (`args`, `errors`, `runtime-device`, `devices`); `git status` приложения: только `args.rs`, `error.rs`, `runtime_device.rs`, `device.rs` и `tests/fixtures/core-contracts/`.
- 2026-09-15 — Порт `src/runtime/llamacpp/{args,errors,runtime-device,devices}.ts` + юниты рядом + `test/contract/{fixtures,args,errors,runtime-device,devices}.test.ts`: 170 контракт-тестов реплеят все фикстуры, 286 тестов зелёные, lint/typecheck чистые. Решения в коде: `formatRustF32` (кратчайшая f32-запись как `f32::to_string`, без `.0`), `f32Differs` через `Math.fround`; `INVALID_ARGUMENT` с `details:"Invalid version_backend format"` вместо Rust `Err(String)`; `details` всегда строка (как `Some(stderr)`); крэш на Windows по кодам `0xC0000005/FD/409` с `>>> 0`; `split_mode`/`flash_attn` в контракте — свободные строки; `dflash_block_size` убран из `LlamacppConfig` (это ключ настроек, в Rust приходит `dflash_n_max`); saturating `as u64` через `MAX_SAFE_INTEGER`.
- 2026-09-15 — Порт `src/util/rust-number.ts` (parse i32/u64/f64, format f32/f64 как Rust `Display`, saturating), `src/config/{data-folder,paths}.ts`, `src/events/emitter.ts` (seq, кольцо 1000, cursor `<instance>:<seq>`, resync при переполнении), `src/models/{model-yml,shards}.ts`, `src/models/gguf/{reader,kv-cache,support,classify}.ts` — все с юнитами; 395 тестов зелёные, lint/typecheck чистые. Находка: Rust-CLI ищет `settings.json` только в `data_dir/Atomic-Chat`, приложение для новых установок пишет его в `data_dir/chat.atomic.app` (legacy-папка предпочитается, если существует) — ядро следует приложению как writer'у. GGUF-ридер: `GgufNeedMoreData` vs `GgufParseError`, чанковое чтение 2 MiB/кап 120 MiB как в HTTP-пути Rust; `model.yml`: неизвестные ключи сохраняются, известные пишутся в порядке приложения.
- 2026-09-15 — Порт `src/downloads/{disk,protocol,verify,downloader,archive}.ts` (docs §8.2 downloads): `.tmp`/`.url`-сайдкары, Range/206 с проверкой `Content-Range`, рестарт на 200/416, 5 попыток со сбросом счётчика на каждый MiB, прогресс каждые 10 MiB, sha256 после всех файлов, удаление файла + пустой папки при провале, cancel сохраняет partials, supersede по task id, preflight (лимит пути, свободное место через `fs.statfs`, containment по canonical-префиксу), `[disk_*]`-теги; архивы через `tar`/`yauzl` с zip-slip guard, `normalizeBackendLayout`. Тесты против `test/helpers/fixture-http-server.ts` (Range, обрывы, статусы, задержки). Прокси оставлен как seam `fetchFor(item)` — риск 13, прототип отдельным шагом.
- 2026-09-15 — Порт `src/runtime/{env,paths,ports,process}.ts`: `discoverCudaPaths`/`buildProcessEnv` (Windows: exe-dir + CUDA bins в начало PATH, cwd = exe-dir — разрешённое отличие §5.1), валидация путей бинаря/модели/mmproj, split-GGUF имена, `randomFreePort` (3000–3999), `generateApiKey` = base64(HMAC-SHA256('JustAskNow', modelId+port)), `spawnManaged`/`spawnAndAwaitReady` (готовность по маркерам `listening on`/`all slots are idle`/`starting the main loop`/`http server listening` или health-poll, таймаут → `MODEL_LOAD_TIMED_OUT`, SIGTERM→5 с→SIGKILL, ошибка спавна → `IO_ERROR`). 37 тестов на реальных дочерних процессах.
- 2026-09-15 — Порт `src/speculative/*` (DFlash/Gemma-MTP/транскрипция/chat-template overrides/MLX dflash+eagle3+mtp, verbatim) и `src/settings/{schema,store}.ts` + `schema/*.json` (три `settings.json` расширений как есть; `SettingsStore` с ревизией, `.tmp`+rename, `onChange`, канонизация значений). Отклонения store от §3.4 (secrets в credentials, migrations-область) — ещё не реализованы, отмечены в `docs/testing-critical-flows.md` как Partial.
- 2026-09-15 — Порт `src/runtime/llamacpp/{policy,probe,load-plan}.ts`: `policy` — предикаты backend-id, AVX-преflight (`CPU_NO_AVX` только при положительном сигнале), `classifyBackendMismatch` (silent-fallback → runtime-cpu → suboptimal-config), `parseEnvString` (ключи `LLAMA*` отбрасываются), floor таймаута готовности 1800 с, `formatLoadError`; `probe` — `llama-server -h` с бюджетом 5 с; `load-plan` — `planLlamaLoad` как чистая оркестрация 23 шагов над инжектированными фактами (sentinel `latest/`, flash-attn для < b6325, шарды → первый шард, проверка размеров артефактов, Llama 3 template override, Gemma-MTP/DFlash драфты и гейты, `dflash_n_max`, DFlash приоритетнее MTP, clamp ctx к trained, stringly `fit`) и `nextRetry` (text-only при `MULTIMODAL_PROJECTOR_LOAD_FAILED` кроме транскрипции; без MTP по `matchesMtpLoadFailure`). `ExtensionErrorCode` добавлен в контракт ошибок. 164 теста runtime зелёные.
- 2026-09-15 — Приложение: `docs/decisions/` получил ADR #1–#3 (extract / migrate in phases / pin contracts with fixtures) и секцию в `INDEX.md`; `tests/core-contracts.test.mjs` проверяет `CHECKSUM` тем же алгоритмом, что `scripts/import-app-fixtures.mjs` (импорт теперь пишет digest в обе репы), соответствие `index.json` файлам и схему кейсов. В `Makefile` (этап 0 его не трогает) тест не подключён — запускается `node --test tests/core-contracts.test.mjs`; подключение — решение владельца. `docs/testing-critical-flows.md` обновлён под evidence этапа 0; `docs/app-e2e.md`/`docs/contracts.md` уже описывают owner-модель. `test/runtime-compat/fs.test.ts`: `fs.statfs`, `open` с mode, rename-over — зелёные под vitest и `bun test` (Bun 1.3.14).
- 2026-09-15 — Порт `src/backend/{types,version,cuda-family,archive,manifest,bundled-manifest-baseline,amd-rocm-pci-ids,select,migrate,installed,optimal-cache}.ts` (из `backend.ts`, Rust `backend.rs`, `index.ts:1070-3195`, `resolve-upstream-backend.mjs`): все I/O-seams инжектированы (`osType/arch/cpuExtensions/gpus`, `ManifestTransport[]` с гонкой через `Promise.any`, `ManifestSessionCache`, `listDevices/listInstalled`, `now`); 348 тестов, в т.ч. эквивалентность с `scripts/resolve-upstream-backend.mjs` приложения. Квирки сохранены: `parseBackendVersion("b10018-1.3.0") === 0` (§2 #15), `linux-noavx-x64 → 'avx'`, `isGpuBackendId` матчит только Vulkan. **Отклонения, требующие решения владельца (ADR):** одна `getBackendCategory` по Rust-версии вместо двух (TS-копия возвращала `'unknown'` для rocm/arm64/x64 → в `recommendedCategory` теперь `rocm`); `recheckOptimalBackend`/`detectIdealBackendType` возвращают дискриминированные исходы вместо `null`/throw (бросает вызывающий); `isBackendInstalled` по Rust-семантике (любой из двух путей), `getBackendExePath` — по TS (проверка папки `build/`); 20-с таймауты детекции оставлены вызывающему. I/O-половина (`install_bundled_backend`, сканер установленных, `verify_backend_binary`, запись optimal-cache) — этап 1. `npm run lint`/`typecheck`/`format:check` чистые, 964 unit+contract тестов зелёные.
- 2026-09-15 — `npm run verify` целиком зелёный (lint, typecheck, prettier, 964 unit+contract, coverage, `tsc`, Bun-бинарь arm64, e2e бинаря). `test/coverage-floor.json` засеян текущими значениями по 49 файлам `src/` (96 % строк; порог только вверх).
- 2026-09-15 — Fixture-emitters шимов и state-file в приложении: `core/server/{responses_shim,chat_to_responses_shim,state_file}.rs` получили `#[ignore]`-модули `fixture_dump` (58 + 62 + 12 кейсов; comparators `json-exact`, `sse-sequence` — упорядоченный `[{event,data}]` без границ чанков, `state-file-schema` — дерево + точные байты serde; placeholders `<msg_id_N>`, `<fc_id_N>`, `<chatcmpl_id_N>`, `<call_id_N>`, `<pid>`, нумерация по первому появлению). Запуск: `make stub-resources`, `TAURI_CONFIG='{"bundle":{"icon":["icons/icon.png"]}}' cargo test --no-default-features --features test-tauri --lib -- --ignored fixture_dump::dump_fixtures`. Импортировано: 305 файлов, `CHECKSUM` `549914f7…` в обеих репах; `tests/core-contracts.test.mjs` зелёный. В ядре `test/contract/deferred-sets.test.ts` проверяет только форму этих трёх наборов — replay при порте `server/` на этапе 4, это **не** засчитывается как parity. Пины для порта (в `comparator_notes` и отчёте): responses-shim игнорирует `{"error":…}`-чанк и всё равно шлёт `response.completed`, `status` всегда `completed`, `name` тул-колла конкатенируется по чанкам, `sequence_number` сквозной с `response.created`; reverse-shim форсирует `stream/store/include/parallel_tool_calls/text.verbosity/tool_choice`, id > 64 символов → 31 + `_` + sha256-префикс, `properties:{}` рекурсивно во все object-схемы, `response.incomplete` → `length`; state-file: любая ошибка парсинга (в т.ч. отсутствующее поле, port > 65535) → полные defaults, `0.0.0.0` → `127.0.0.1` в `base_url`, `api_key` никогда не читается. Write-кейсы state-file пинят структуру и сериализацию, не файловые побочные эффекты (`write_state` резолвит реальную папку данных).
- 2026-09-15 — Риск 13 (прокси загрузок): прототип на Node 22/24/25, Bun 1.3.14 и `bun build --compile`-бинаре, 19 кейсов (HTTP forward, CONNECT, auth, SOCKS5, `no_proxy` host/suffix/CIDR, invalid TLS, custom CA, client cert, Range/206 через туннель, abort, redirect). Единственный механизм, проходящий всё на обоих рантаймах и в бинаре — собственный HTTP/1.1-клиент над `node:net`/`node:tls` (~280 строк, без зависимостей) только для элементов с политикой прокси. `undici` как зависимость не помогает: в Bun подменяется пустым stub'ом, на Node работает лишь через `undici.fetch`; override `Agent.createConnection` в Bun **молча обходит прокси** (тест обязан проверять, что прокси видел соединение). Скоуп приложения уже: `ProxyConfig` = `{url,username,password,no_proxy,ignore_ssl}`, CA/client-cert/CIDR в приложении нет. Отчёт — `docs/spikes/2026-09-15-proxied-downloads-node-vs-bun.md`; ADR «Proxied downloads use a raw-socket HTTP client» записан со статусом **proposed** — реализация после решения владельца (§0: ADR перед кодом).
- 2026-09-15 — Проверка приложения. Зелёные: `tests/core-contracts.test.mjs` (3/3), `make test-hardening-contracts` (26/26), web-app `vitest` 3170 passed (после `yarn workspace @janhq/core build` — `core/dist` не был собран), Rust: главный crate 836 passed / 1 failed, плагины `llamacpp-upstream` 217 (4 ignored = emitters), `llamacpp` 179, `hardware` 12, `atomic-audio` 44, `mlx` 16 — все ok. **`make verify` красный на трёх pre-existing причинах, не связанных с этапом 0** (в `web-app/` и `core/agent/` этап ничего не менял): (1) `scripts/check-test-quality.mjs` флагует 13 тестов web-app как call-only-assertions — воспроизведено на чистом worktree HEAD `ccf5427`; (2) web-app `test:coverage` завершает с Unhandled Error `ServiceHub not initialized` из таймера `useAssistant.ts:121` во время `RunSettingsPanel.test.tsx` (все тесты при этом passed); (3) Rust `filesystem_trash_moves_directories_through_the_native_trash_api` возвращает `Error` и на этой машине падает и вне sandbox (120 с — похоже на таймаут macOS Trash API). Окружение: `yarn` в репо — 1.22 через volta, `packageManager: yarn@4.5.3` требует corepack; проверки гонялись через yarn 4.5.3, установленный в scratchpad (в систему ничего не ставилось). `tests/core-contracts.test.mjs` в `Makefile` не подключён (этап 0 `Makefile` не трогает) — решение владельца.
- 2026-09-15 — Решения владельца по отсечке этапа 0: (1) прокси — вариант «свой клиент без зависимостей»; (2) `backend/` — единая функция категории по Rust, TS-копия признана отставшей; (3) `tests/core-contracts.test.mjs` подключить в Makefile. Выполнено: ADR по прокси переведён в accepted, ADR «backend/ keeps one Rust-derived category function and explicit recheck outcomes» записан; в приложении `Makefile` `test-hardening-contracts` включает `tests/core-contracts.test.mjs` (29/29 зелёные).
- 2026-09-15 — `src/downloads/proxy-fetch.ts`: `createPolicyFetch(policy)` — HTTP/1.1-клиент над `node:net`/`node:tls`: forward-proxy для http (absolute-form), CONNECT для https, SOCKS5 с RFC 1929, `Proxy-Authorization` из полей или из URL, `no_proxy` через `shouldBypassProxy` на каждом redirect-хопе, `ignore_ssl` (из policy или из `proxy.ignore_ssl`), опциональный `ca`; тела `Content-Length`/chunked/до закрытия как `ReadableStream` с backpressure, `AbortSignal` → `AbortError`, fetch-подобные редиректы (303/301/302-POST → GET, Authorization снимается кросс-origin, лимит 10), HEAD/204/304 без тела; socks4 и неизвестные схемы отклоняются до сети. `policyFetchFor` — default `fetchFor` загрузчика (без прокси — базовый `fetch`, поведение не меняется). Тесты: `test/helpers/proxy-servers.ts` (origin http/https/self-signed на 10-летних тестовых сертификатах `test/fixtures/tls/`, forward+CONNECT прокси open/auth, SOCKS5 open/auth, журнал событий прокси) — каждый кейс проверяет, что прокси **видел** соединение; `src/downloads/proxy-fetch.test.ts` 13 кейсов, `test/runtime-compat/proxy-fetch.test.ts` зелёный под vitest и `bun test` (Bun 1.3.14). Проверка на скомпилированном бинаре — с появлением CLI-команды загрузки на этапе 1.
- 2026-09-15 (этап 1) — `src/lock/`: `process-identity.ts` (start-identity процесса без нативных аддонов: procfs на Linux, `ps -o lstart` на macOS, `Get-Process .StartTime.Ticks` на Windows; вердикты `match/mismatch/dead/unknown`, захват чужого lock только при `dead`/`mismatch` — недоказуемое никогда не считается свободным), `instance-lock.ts` (`instance.lock` создаётся эксклюзивно `wx`, запись в два шага `starting` → `ready` с `control_host/port`, восстановление stale-lock под отдельным mutex-файлом с TTL 30 с, `waitForPublishedOwner`, `release` не трогает lock, перехваченный другим instance), `control-token.ts` (32 байта base64url, режим 0600, `timingSafeEqual`, парсер `Bearer`), `process-journal.ts` (`processes.json`, атомарная запись, `scanOrphans` → `confirmed/skipped/gone`: убиваем только процесс с совпавшей идентичностью, чей владелец мёртв). 32 теста, включая гонку четырёх стартующих клиентов за stale lock (ровно один владелец) и реальные убитые процессы.
- 2026-09-15 (этап 1) — `src/models/registry.ts` (DFS-скан `<data>/llamacpp/models` как в `list_chat_models_in` и в расширении: папка с `model.yml` — лист, id через `/`, сортировка, битый yml пропускается; `get` с текстом ошибки Rust-CLI, `write`/`remove` с защитой от выхода за корень, `resolvePaths`), `src/backend/scan.ts` (`discoverBackendBinary` = `discover_llamacpp_binary_in`: версии по распарсенному build-number, бэкенды по имени, `build/bin/<exe>` перед плоским; `scanInstalledBackends`, `resolveBackendExe`, `versionBackendFromBinPath`), `src/models/gguf/read-file.ts` (чанковое чтение метаданных из файла). Находка: в ядре два парсера build-number — строгий `^b(\d+)$` в `backend/version.ts` (порт app-кода) и мягкий в `runtime/llamacpp/args.ts` (порт `ArgumentBuilder`); discovery обязан использовать мягкий, иначе сборки форка (`b10018-1.3.0`) уезжают в конец. 19 тестов.
- 2026-09-15 (этап 1) — `src/runtime/llamacpp/runtime.ts`: `LlamacppRuntime` — спавн по плану (`planLlamaLoad` → `planLlamaArgs` → `buildProcessEnv` → `spawnAndAwaitReady` с маркерами и health-poll), таблица сессий, журнал процессов до появления нагрузки, watcher выхода (`session:died`, чистка сессии и журнала), `unload`/`unloadAll` (SIGTERM→SIGKILL), `getDevices` через `--list-devices`, аккумулятор runtime-device из stderr, две повторные попытки (`nextRetry`: без mmproj, без MTP), объединение параллельных load одной модели, порт на сессию. Хелпер `test/helpers/fake-llama-server.mjs` — фейковый llama-server с настоящими строками готовности и устройств, `/health`, `/props`, `/tokenize`, `/apply-template`, `/v1/models`, `/v1/chat/completions` (SSE), режимы `oom`/`segv`/`projector-fail`/`mtp-fail`/`no-ready`/`hang`; запускается через `node <script> <argv>`, поэтому вся продакшн-цепочка (готовность, классификация выхода, kill) — настоящая. 14 тестов рантайма, 1058 unit+contract зелёных.
- 2026-09-15 (этап 1) — Control API и публичный listener: `src/server/{http,clients,control,public}.ts`. Control (`/atomic/v1`) — только loopback, всегда `Bearer <control_token>`, проверка Host (защита от DNS-rebinding), без CORS; маршруты `health`, `snapshot` (сессии, состояние публичного сервера, клиенты, cursor), `events` (SSE с `id: <instance>:<seq>`, replay по cursor, `resync` при чужом instance, heartbeat-комментарии, `flushHeaders` чтобы клиент не ждал первого события), `clients/*` (регистрация, heartbeat, истечение), `sessions`, `models/:provider/*modelId/{load,unload}` (id со слэшами), `server/{start,stop}`, `shutdown` (отказ 409, пока привязан другой клиент). Public (`/v1`) — отдельный listener: `/` без ключа (проба CLI), `/v1/models`, форвардинг на llama-server сессии с подстановкой её ключа и отменой upstream-запроса при обрыве клиента, гейты api-key/trusted hosts/CORS. `ClientRegistry` с истечением по трём пропущенным heartbeat. 46 тестов через настоящие сокеты.
- 2026-09-15 (этап 1) — `src/client/control-client.ts` (browser-safe, только fetch): все маршруты, `handshake` с проверкой протокола (`CORE_PROTOCOL_MISMATCH`), SSE-подписка с cursor, ошибки поднимаются как `AtomicCoreError` с кодом от ядра. Тест гоняет клиент против настоящего `ControlServer`.
- 2026-09-15 (этап 1) — `AtomicCore` (`src/core.ts`) — сборка владельца: lock → токен → settings → журнал → runtime → control listener → `reapOrphans` (убиваем только подтверждённые сироты) → `publish(host, port)`; `startPublicServer`/`stopPublicServer` (независимы от control, bind-failure отдаётся событием и не рушит предыдущее состояние), `shutdown` (публичный listener → сессии → control → lock последним) и промис `stopped`. Находка: на чистой папке `version_backend` пуст, и план отказывался угадывать набор фич — ядро повторяет приём Rust-CLI (`discover_llamacpp_binary`) и берёт тег из пути найденного бинаря; если бэкенда нет вовсе — `BINARY_NOT_FOUND` с понятным текстом вместо «настройте Settings».
- 2026-09-15 (этап 1) — CLI: `src/cli/{io,owner,commands,main,bin}.ts`. `daemon` (печатает ready-line в stdout, всё остальное в stderr, живёт до сигнала или до shutdown через API), `serve <model>` (attach-or-launch владельца, load, публичный listener на 6767 по умолчанию, `--json`), `models list [--json]` (читает папку напрямую, как Rust-CLI), `server status` (ядро → state-file приложения → дефолты; exit 1 если не отвечает; `ATOMIC_API_KEY`), `shutdown [--force]`. Все команды принимают `CliIo`, поэтому тестируются без спавна. **Баг, найденный только на скомпилированном бинаре:** внутри Bun-бинаря `process.argv[0]` равен строке `bun`, и авто-запуск демона падал с `Script not found "daemon"` — `selfCommand` теперь всегда использует `process.execPath`; добавлен e2e-кейс на авто-запуск.
- 2026-09-15 (этап 1) — E2E на скомпилированном бинаре (`test/e2e/owner.test.ts`, 9 сценариев): ready-line и отказ второму владельцу, `serve` → `/v1/models` и completion, стриминг с отменой, стоп/старт публичного listener при живом control, два клиента и отказ shutdown пока второй привязан, убитый владелец → новый забирает папку и убивает осиротевший backend, явный shutdown без lock и без процессов, авто-запуск ядра из `serve`, `models list`/`server status` без ядра. Хелперы: `test/helpers/fake-backend-pack.ts` (пак с фейковым llama-server). Ограничение: паки-скрипты не работают на Windows (CreateProcess требует PE), поэтому путь «спавн бэкенда» на Windows закрыт live-тестами с настоящим `llama-server` — job `live-backend` в CI на трёх ОС, фикстуры качает `scripts/fetch-live-fixtures.mjs`.
- 2026-09-15 (review-fix этапов 0–1) — lifecycle ядра и публичного listener сериализован: shutdown блокирует новую работу, отменяет незавершённый spawn, выгружает сессии до control/lock; совместимый start идемпотентен, несовместимый возвращает конфликт без остановки рабочего listener. Runtime публикует сессию только после журнала, откатывает процесс при ошибке записи, применяет auto-unload и цепочку mmproj→MTP. Два одновременных `serve` сходятся на владельце-победителе. `serve` получил полный набор флагов Rust CLI и Hugging Face GGUF download через общий Downloader с проверкой до `model.yml`; proxy abort действует на всех handshake-этапах, преждевременный EOF теперь ошибка. Решение записано в ADR «Serialize owner lifecycle and preserve serve flags».
- 2026-09-15 (этап 1) — `test/live/llamacpp.test.ts` прогнан по-настоящему: llama.cpp `b10985` (macOS arm64) + `stories15M-q4_0.gguf` (18 MiB) — модель грузится, `/v1/chat/completions` отвечает через публичный listener, `--list-devices` парсится (`MTL0: Apple M4 Max`), unload чистый. **Два дефекта, которые нашёл только настоящий бэкенд:** (1) `canonicalProviderDefaults` не содержит `chat_template` и `override_tensor_buffer_t` (в расширении это per-model поля, не engine-настройки), из-за чего в argv уезжали `--override-tensor null` и `--chat-template null` — добавлены в `LLAMACPP_CONFIG_SERDE_DEFAULTS`, `withLlamacppDefaults` теперь игнорирует `undefined` (как отсутствие ключа в JSON); (2) в argv мог попасть не-string — добавлен явный гейт (`INVALID_ARGUMENT` с именем флага), которого в Rust не требовалось из-за типов. Отдельно: копировать в пак только исполняемый файл нельзя, llama-server линкуется с ggml-библиотеками рядом.
- 2026-09-15 (этап 1) — `build:bin --all` собирает 4 triple (arm64/x64 macOS, x64 Windows, x64 Linux); `runtime-compat` зелёный под vitest и `bun test`; CI получил nightly-расписание, `bun test test/runtime-compat` и job `live-backend` на windows/ubuntu/macos. `npm run verify` зелёный: 1155 unit+contract, coverage-floor по 66 файлам (96 % строк), бинарь, 11 e2e. Пороги покрытия для `core.ts`, `cli/main.ts`, `cli/commands.ts` пересчитаны с «заглушка на 100 %» на реальные значения реализации — это отмечено здесь, потому что политика «только вверх» иначе читается как нарушенная.
- 2026-09-15 (этап 2) — `src/integrations/{catalog,detect}.ts`: порт `core/cli/integrations.rs` — 19 агентов в том же порядке и с теми же id/алиасами/`endpoint_with_prefix`/`run_args`/`run_mode`, `findAgent`, `apiUrlFor`, `childEnv` (copilot/goose/openhands/poolside/muse — пять агентов настраиваются только переменными окружения, и rc-файл не действует в процессе, который мы вот-вот запустим), `CONFLICTING_PROVIDER_ENV`, `offPathCandidates` (OpenClaw ставится мимо PATH), детект через `which`/`where` с fallback на prefix-пути. 16 тестов.
- 2026-09-15 (этап 2) — `src/cli/launch.ts`: `launch [agent] [args…]` — `--list` и `--list --json`, отказ по неизвестному агенту с показом каталога, отказ Muse Code с объяснением (нужен каталог `/muse-code/models`, которого у голого llama-server нет), отказ если агент не установлен со ссылкой на доки, интерактивный выбор агента и модели, `--fit` по умолчанию для Claude Code только когда `--ctx-size` не задан, attach-or-launch владельца → load → публичный listener → configure → запуск агента. Terminal-агент держит сессию (по его выходу модель выгружается, ядро живёт), GUI-агент запускается detached и модель держится до Ctrl+C. `splitAgentArgs` отдаёт агенту всё после его имени, включая неизвестные нам флаги (аналог `trailing_var_arg`). 12 тестов; запись конфигов агента — за инжектированным `configure`, который закроют golden-фикстуры.
- 2026-09-15 (этап 2) — Упаковка: в ядре `.github/workflows/release.yml` (гейты → `build:bin --all` → ассеты `atomic-chat-core-<version>-<triple>` + `SHA256SUMS`, публикация по тегу, проверка что тег совпадает с package.json). В приложении: `scripts/download-core.mjs` (пин `atomicCore.version`, проверка sha256 по `SHA256SUMS`, на macOS обе арки + `lipo`, `ATOMIC_CORE_LOCAL` для локальной сборки, `SKIP_BINARIES`), `package.json` (`atomicCore`, `download:core`, подключён в `dev:tauri` и все `build:tauri:*`), `Entitlements.sidecar.plist` (allow-jit + allow-unsigned-executable-memory + disable-library-validation), `Makefile` (`CLI_IMPL ?= core`, `download-core`, `build-cli-core` = копия в `jan-cli` + codesign с sidecar-энтайтлментами + `codesign --verify --strict`, `build-cli-rust` как откат, `stub-resources` знает про новый бинарь), `tauri.{macos,windows,linux}.conf.json` (`bundle.resources` += ядро), `release.yml` (три места). Проверено вживую: `make build-cli` с локальным ядром подписывает бинарь, `jan-cli --version` = `0.1.0`, `jan-cli launch --list` находит установленные на машине агенты, в подписи присутствуют все три энтайтлмента.
- 2026-09-15 (этап 2) — `tests/cli-launch-catalog.test.mjs` в приложении: сверяет каталог `launch --list --json` с `web-app/src/constants/integrations.ts` (порядок важен, три GUI-редактора исключены), проверяет поля каждого агента, правило префикса для Claude Code/Goose/Codex и что версия бинаря совпадает с пином. Подключён в `test-hardening-contracts`. ADR #4–#7 записаны в `docs/decisions/` приложения и проиндексированы.
- 2026-09-16 (этап 2, исправления ревью) — двусторонние атомарные model claims закрывают app/core double-load до мутации; `launch` использует production-конфигураторы, сначала фиксирует public listener, выгружает только созданную им сессию и чистит её при любой ошибке; добавлен foreground `--standalone` с обязательной отдельной `--data-folder`. App/CI/dev-сборки везде кладут core в `jan-cli`, оба Mach-O подписываются JIT-entitlements, Windows update занятого CLI fail-closed, discovery выбирает живой endpoint, обязательный cross-repo каталог больше не skip-ается.
- 2026-09-15 (этап 2) — Golden-фикстуры `configure_*`: в приложении новый `#[cfg(test)] mod fixture_dump` в `core/cli/fixture_dump.rs` — 130 кейсов на 19 агентов (свежий дом, повторный прогон, существующий чужой конфиг, пустой/непустой ключ, плюс ветки каждой функции), comparator `agent-config-files`, `expected.files` — полное дерево файлов под фейковым домом, сравнение побайтовое, placeholders `<home>`/`<timestamp>`/`<os-error>`. Запуск требует фичи `cli` и `--test-threads=1` (кейсы правят `HOME` процессно). Импортировано: 436 файлов фикстур, `CHECKSUM` `503f9372…`. В ядре готова инфраструктура: `src/integrations/config-io.ts` (`canonicalJson` — serde_json пишет ключи объектов отсортированными рекурсивно, это контракт, а не форматирование; json5-терпимый и строгий парсеры; `canonicalYaml` в форме serde_yaml 0.9 без отступа у элементов последовательности; managed-блоки; выбор rc-файла по `$SHELL`; `renderMarkedEnvBlock`, который дополнительно удаляет `export <PREFIX>` даже вне блока), `configure/registry.ts` (диспетчер `configureAgent`) и харнесс `test/contract/agent-config.test.ts` с честным `PENDING_AGENTS` — кейсы непортированных агентов не считаются пройденными.
- 2026-09-15 (этап 2) — Координация legacy/core: reaper приложения (`core/process_reaper.rs`) больше не убивает бэкенды живого владельца-ядра — читает `instance.lock`, проверяет что процесс жив и похож на ядро (`atomic-chat-core`/`jan-cli`), и щадит PIDы из `processes.json`, записанные **этим** instance (записи прошлого владельца остаются сиротами, как и было); чистая функция `journalled_pids` покрыта тестами. В ядре появился свой discovery-файл `<data>/atomic-core/local-api-server.json` — публичный listener публикует туда адрес при старте и остановке, а файл приложения `<data>/local-api-server.json` ядро не трогает (владелец — legacy-сервер до этапа 4); `server status` читает в порядке: живой владелец → файл ядра → файл приложения → дефолты.
- 2026-09-15 (этап 2) — Порт всех 19 `configure_*` в `src/integrations/configure/` (два агента параллельно, фикстуры как спека): 130/130 кейсов реплеятся побайтово, `PENDING_AGENTS` пуст. Общие модули: `opencode-style.ts` (kilo/opencode/mimo пишут один и тот же файл с четырьмя параметрами — в Rust это трижды скопировано), `env-agent.ts` (пятеро настраиваются только переменными окружения: Windows → `setx`, иначе маркированный блок в rc-файле), `json-tree.ts` (Rust чинит поле неверного типа, `typeof x === 'object'` для этого не годится). **Правка контракта, которую нашли фикстуры:** `write_marked_env_to_shell` в Rust принимает однострочный маркер агента (`# Atomic Chat - Goose Config`), который и открывает, и закрывает блок, а пустая строка перед закрывающим маркером берётся из того, что каждая запись несёт свой `\n` — моя первая версия `renderMarkedEnvBlock` использовала общие `ATOMIC_MANAGED_*` и не давала этой строки; сигнатура исправлена. Не воспроизведено осознанно: canonicalize перед rename в dsh (симлинк `settings.yaml` заменится обычным файлом — реальный пробел, ни одной фикстурой не покрыт), probe логин-шелла за `DSH_HOME` (CLI и так работает внутри шелла пользователя), относительные `$OPENCLAW_CONFIG_PATH`/`$DSH_HOME` (в ядре резолвятся от домашней папки, в Rust — от cwd).
- 2026-09-15 (этап 2) — Guard двойной загрузки: плагин приложения (`legacy_state.rs`, 4 теста) публикует таблицу сессий в `<data>/atomic-core/legacy-runtime.json` после каждой загрузки, выгрузки и смерти процесса — без `api_key` и `model_path`, только `{model_id, port, pid, is_embedding}`; путь приходит из `lib.rs` один раз при старте, `serde_json` переведён из dev- в обычные зависимости плагина. В ядре `src/lock/legacy-guard.ts` читает её и `AtomicCore.load` отказывает **до** спавна с `CORE_ALREADY_RUNNING` и указанием порта, где модель уже отдаётся; таблица мёртвого приложения игнорируется (PID не жив), битая или отсутствующая — тоже. 12 тестов в ядре, 850 Rust-тестов приложения зелёные.
- 2026-09-16 (этап 3a) — Приложение стало клиентом ядра: `src-tauri/src/core/atomic_core/` — `lock.rs` (типизированное чтение `instance.lock` и токена; reaper переведён на этот же парсер, чтобы файл не читали два разных кода), `client.rs` (control-HTTP с bearer-токеном, `no_proxy` — корпоративный `HTTP_PROXY` иначе увёл бы токен на прокси; ошибки ядра проходят с сохранением `code`, недоступность отличается как `CORE_UNREACHABLE`), `launch.rs` (detached spawn: `setsid` на Unix, `DETACHED_PROCESS` на Windows; готовность читается из lock, а не из stdout, поэтому проигравший гонку за lock не считается сбоем), `supervisor.rs` (attach-or-launch, handshake против `ATOMIC_CORE_VERSION` из `build.rs`, регистрация клиента, generation на каждый attach, backoff 1/5/15 с и максимум 3 рестарта за 5 минут — холодный старт не задерживается), `relay.rs` (SSE → Tauri-события `atomic-core://<name>` 1:1, курсор `<instance>:<seq>`, `resync` → `detached` + свежий snapshot), `commands.rs` (один `atomic_core_call` на весь control API, статус, snapshot, флаги). Флаги отката в `settings.json` приложения (`atomic_core.{attach,runtime,server}`, по умолчанию всё выключено) — файл читается до открытия папки данных, поэтому выключатель работает даже когда папка недоступна. Проверка: 64 unit-теста против фейкового ядра (роутер, а не очередь ответов), 912 Rust-тестов приложения зелёные. ADR «The webview reaches the core only through Rust» и «Keep handles to the cores we start».
- 2026-09-16 (этап 3a) — Снята проверка имени процесса при чтении lock: она ломала документированный dev-путь `ATOMIC_CORE_CMD="bun run …" yarn dev` (процесс называется `bun`) и ничего не добавляла поверх `owner_started_at` — доказательство, что владелец действительно ядро, это авторизованный handshake, а не имя файла.
- 2026-09-16 (этап 3a) — **Баг, который нашёл только настоящий бинарь** (`make test-core-live`, 4 сценария против скомпилированного ядра): убитое ядро оставалось зомби, потому что приложение — его родитель и не пожинало его. Зомби сохраняет PID, `ps` показывает его с прежним временем старта, и новое ядро, читая устаревший lock, считало владельца живым и отказывалось забрать папку (`CORE_ALREADY_RUNNING`, exit 1). В проде это значило: ядро упало — перезапуска не будет, пока приложение работает, то есть ровно тот сценарий, ради которого рестарт и существует. Против фейкового ядра все тесты проходили — фейк не дочерний процесс. Починено: хендлы запущенных ядер держатся в процессном списке и `try_wait`-ятся перед чтением lock (`launch::reap_finished`); сигналов им не шлём. Заодно stderr стартующего ядра уходит в `<data>/atomic-core/core-start.log`, и его хвост попадает в `CORE_START_FAILED` — до этого падение старта было кодом возврата без единой причины.
- 2026-09-16 (этап 3a) — Критерий выхода называл dev-командой `bun run …/src/cli/main.ts`; у `main.ts` нет side effects при импорте (это инжектируемая таблица команд), запускаемый вход — `bin.ts`, и команда из плана молча ничего не делала. Строка исправлена здесь и в докблоке `launch.rs`. Проверено: `bun run src/cli/bin.ts daemon` публикует lock и ready-line, а `ATOMIC_CORE_CMD` действительно перебивает бандл (live-тест стартует ядро из сборки без единого бинаря в ресурсах).
- 2026-09-16 (review-fix этапа 3a) — Heartbeat и SSE объединены в один lifecycle, который сам запускает и восстанавливает владельца; `off` стал сериализованной границей для control-вызовов. Неоднозначные сетевые ошибки больше не повторяют мутации, model load использует собственный timeout ядра, snapshot/cursor образуют одну точку resync, SSE декодируется по целым UTF-8 frames. Rust читает legacy `process_start_id` на Linux/macOS/Windows; неизвестная identity остаётся fail-closed, а focused lock-suite добавлен в release jobs всех трёх ОС. Локально: focused 73/73, live 6/6, полный Rust 920/920, `atomic-chat-core npm run verify` зелёный. Подэтапы 3b–3d не начаты.
- 2026-09-16 (этап 3b) — Обязательная инвентаризация прямых обращений к картам сессий плагинов выполнена. Три независимых зеркала порта и ключа, которые устаревают по отдельности: `sessionCache` расширения (чистится только на unload, на провале `/health` в `chat` и в force-cleanup), `ModelFactory.localSessionCache` в web-app (TTL 10 с, инвалидируется только через `stopModel`) и — худшее — замыкания внутри объекта модели AI SDK (`model-factory.ts`: `headers: () =>` и `url: ({path}) =>` захватывают порт и ключ один раз на всё время жизни объекта, обновления не предусмотрено). Rust-аналог, `LlamaSessionTarget` агента, обновляется, но только через `AgentContextExpansion::expand`. Слушатель `llamacpp_upstream_session_died` в `DataProvider.tsx` убирает модель из `activeModels`, но не инвалидирует ни одно из этих зеркал. В Rust читатели карт: `proxy.rs` (`collect_served_models`, `is_embedding_session`, `resolve_local_session`, `retry_local_upstream`, Responses-шим, Anthropic-путь, основной OpenAI-путь, `/metrics`, три пути ретрая), `agent/llm_client.rs` (`find_session_by_model_id`, `find_session_by_model_and_backend`), `agent/rag_bridge.rs` (`find_embedding_session`), `cli/mod.rs` и `bin/jan-cli.rs`. Вывод для 3b: единый резолвер обязан быть не только в Rust — без замены захваченных замыканий в `model-factory` смерть ядра оставит UI с мёртвым портом, и критерий выхода «смерть ядра не оставляет старые порты в resolver» не выполнится.
- 2026-09-16 (этап 3b) — Ядро: импорт настроек приложения (`src/settings/import.ts` + `SettingsStore.importProvider/acknowledge/migration`). Это трёхсторонний merge, а не копирование: база — то, чем legacy-сторона была на прошлом импорте, а для первого импорта — дефолты провайдера, поэтому значение, уже изменённое через CLI, читается как изменение, а не как общая точка старта. Ключ, который менял только app, берётся; который менял только core — сохраняется; который обе стороны увели в разные значения — конфликт, и тогда **не пишется ничего**: частичный импорт оставил бы область наполовину мигрированной, чего не принимала ни одна сторона. Повторный импорт того же состояния — `unchanged` без бампа ревизии (приложение импортирует на каждом старте). Запись миграции сохраняется даже когда применять нечего, иначе следующий старт мержил бы от устаревшей базы. Отдельно: ключ, которого у приложения нет, не трогается — писать `undefined` значило бы затереть живое значение ядра. Маршруты `GET/PATCH /settings/:provider`, `POST /settings/:provider/import` (409 на конфликт), `POST /settings/:scope/acknowledge`. 30 новых тестов.
- 2026-09-16 (этап 3b) — Ядро: `autoIncreaseCtx` + `session:ctx-increased` + маршрут `POST /models/:p/*modelId/ctx/increase`. Лестница контекста портирована из `computeNextCtxLen` приложения буква в букву (`<8192 → 8192 → 32768 → ×1.5`, потолок — обученный контекст), потому что сессия, выросшая под приложением, и сессия, выросшая под ядром, обязаны приходить к одним размерам. Два случая отказа сохранены: `fit` (под fit движок сам подбирает окно и `--ctx-size` вообще не выдаётся, перезагрузка стоила бы пользователю загрузки модели и не изменила бы ничего) и `at_max` (иначе следующий запрос переполнился бы снова и запросил снова — цикл). Отказ отдаётся как 200 с причиной, а не как ошибка: прокси обязан отличать «лестница кончилась» от «перезагрузка не удалась». `session:ctx-increased` — чисто информационное, новый порт зеркало узнаёт из `session:started`, который излучает сама перезагрузка. Для теста потолка добавлен шов `readGgufMetadata` в опции рантайма — обученный контекст берётся оттуда, и без шва случай `at_max` не проверить, не собирая GGUF руками. 33 теста; `unit`+`contract` = 1613 зелёных.
- 2026-09-16 (этап 3b) — Приложение: `core/atomic_core/sessions.rs` — зеркало сессий ядра из snapshot + SSE, с поколением на каждом чтении; снимок из поколения, которое приложение уже покинуло, отбрасывается, а detach очищает таблицу целиком — иначе резолвер продолжал бы отдавать порт, который умер вместе с ядром (или, хуже, достался другому процессу). Поиск модели — по правилу прокси `model_ids_match`, а не по равенству строк: клиенты и файловые системы меняют `.` на `_`, и core-сессия обязана отвечать на те же запросы, что отвечала plugin-сессия. Зеркало питается через sink relay (менять сам relay не пришлось): его два собственных события несут поколение, а событиям сессий оно не нужно — они приходят строго между snapshot и detach, то есть внутри ровно одного поколения. Дальше `core/atomic_core/resolver.rs` — единый резолвер над четырьмя источниками (два llama.cpp-плагина, MLX, зеркало ядра); какой источник отвечает за провайдера, решает один переключатель, он же делает откат настоящим: выключили флаг — тот же вызов снова читает карту плагина, больше ничего не меняется. Резолвер ничего не кеширует. 26 тестов.
- 2026-09-16 (этап 3b) — Все Rust-читатели карт сессий переведены на единый резолвер. В `proxy.rs` не осталось ни одного прямого `lock()` по картам (девять мест: `/models` и `/muse-code/models`, `is_embedding_session`, `resolve_local_session`, Responses-шим, Anthropic-путь, основной OpenAI-путь, `/metrics`, три пути ретрая после auto-increase); тройка параметров `sessions/sessions_upstream/mlx_sessions` заменена одним `SessionResolver` по всей цепочке до `start_server`. Агент (`llm_client.rs`, `target.rs`, `commands.rs`) и RAG-мост тоже ходят через него; `LiveDocsBridge` больше не держит карты плагинов вовсе. Резолвер вынесен из `atomic_core` в `core/sessions/`, потому что `atomic_core` desktop-only (нужен sysinfo), а резолвер обязан быть доступен везде, где живут прокси и агент. **Расхождение, которое поймал порт:** мой первый `find_embedding` возвращал запасную embedding-сессию первого провайдера раньше, чем проверял предпочтительную модель у следующего — исходный код так не делал, и это молча отправляло бы эмбеддинги не в ту модель, когда загружены обе. Исправлено, добавлен тест на этот порядок. `resolver_for` отдаёт установленный резолвер или строит plugin-only на месте — это не деградация, а ровно то, что делает установленный резолвер для провайдера, которым ядро не владеет. 954 Rust-теста зелёные.
- 2026-09-16 (этап 3b) — Ядро: hardware override (`src/hardware/override.ts` + `GET/PUT/DELETE /hardware/override`). Приложение измеряет машину через NVML и Vulkan, ядро этого не умеет и не будет — а именно из этих чисел выбирается CUDA-тир, и на Windows PCI device id из Vulkan это единственный сигнал для gfx-цели AMD. Override **заменяет** пробу целиком, а не сливается с ней: полупробованный-полуинжектированный список GPU был бы третьим описанием машины, не совпадающим ни с одной из сторон. Не персистится: железо между запусками меняется, и устаревший файл, обещающий исчезнувшую GPU, выбрал бы бэкенд, который не стартует. Кривой payload отклоняется целиком и не затирает уже действующий override. 14 тестов; ядро `unit`+`contract` = 1627.
- 2026-09-16 (этап 3b) — TypeScript: адаптер расширения (`src/adapter/coreRuntime.ts`, 17 тестов) — load/unload/sessions/ctx-increase/импорт настроек/hardware через `atomic_core_call`, без единого URL в webview и без кеша сессий. Подтверждено, что `SessionInfo` ядра и `@janhq/core` совпадают по полям — критерий совместимости этапа выполнен. **Главный дефект из инвентаризации починен:** в `model-factory.ts` объект модели AI SDK захватывал порт и ключ в замыканиях `headers`/`url` на всё время жизни, и после авто-увеличения контекста разговор продолжал стучаться в мёртвый порт. Теперь сессия перерезолвится перед каждым запросом, а URL и bearer подменяются в обёртке fetch (`retargetLocalRequest`/`withBearer`, 8 тестов); переписываются только loopback-запросы. Резолв из webview ушёл на Rust-команду `resolve_local_session` — флаг владения читается там, а не в вебвью, где он мог бы отстать на момент и увести запрос к бывшему владельцу.
- 2026-09-16 (этап 3b) — Дефект этапа 2, который поймал `ipc-contract`: `set_core_dir` была зарегистрирована в invoke_handler плагина, но отсутствовала в его `build.rs` и permissions, то есть как IPC-команда не работала бы вовсе. Из JS её никто не звал (приложение вызывает Rust-функцию плагина напрямую), поэтому команда убрана из handler, а не снабжена разрешением: куда смотрит зеркало сессий — дело приложения, и страница в вебвью не должна иметь возможности это перенаправить.
- 2026-09-16 (этап 3b) — Расширение подключено к адаптеру. Один метод `resolveSession` стал единственным поиском сессии внутри расширения: при владении ядра он не трогает `sessionCache` вовсе — этот кеш писался, когда расширение само владело процессом и знало, когда тот умер; теперь не знает. `load`/`unload`/`getLoadedModels`/`auto_increase_ctx` уходят в ядро, лестницу контекста считает ядро (делать её здесь значило бы выгрузить чужой процесс и поднять его с настройками, которых ядро не выбирало). `ensureCoreIsReady` повторяет импорт и неперсистентный hardware override для новой generation или изменившегося legacy-снимка; конфликт импорта блокирует load. Перед acknowledge полный core snapshot записывается в legacy storage без запуска legacy-side effects, поэтому rollback не теряет CLI-правки. **Дефект, который нашёлся при подключении:** `chat()` проверяет живость сессии через `plugin:…|is_process_running`, а pid core-процесса плагину неизвестен — проверка всегда отвечала бы «не запущен», и каждый чат сообщал бы о крахе, которого не было. Для core-сессий живость теперь проверяется тем, что порт отвечает на `/health`; это единственный честный тест через границу процесса.
- 2026-09-16 (этап 3b) — Осознанное отступление от буквы плана: физический перенос старого кода в `extensions/.../src/legacy/` не сделан. Расширение — 7400 строк в одном файле, и перенос сделал бы диф этапа нечитаемым, не дав ничего, чего не даёт флаг: legacy-код остаётся в пакете и работает при выключенном флаге, что и требует критерий отката. Перенос уместнее на этапе 6, где этот код и так удаляется. Если владелец хочет его раньше — это отдельный механический шаг.
- 2026-09-16 (review-fix этапа 3b) — Починены дефекты интеграционной границы: camelCase load-поля и `{session,created}` envelope; один hardware store действительно участвует в CPU preflight и выборе установленного backend; readiness привязана к generation+settings и не глотает конфликт; core→legacy mirror предшествует acknowledge, а `SettingsStore.onChange` теперь действительно публикуется в SSE; смена владельца сериализована и отклоняется при загруженных сессиях исходящего владельца, а plugin gate дожидается уже начатого legacy-load; первый snapshot устанавливается до переключения resolver; `null` Rust-resolver авторитетен, web-запрос каждый раз получает свежие port/key без fallback к старым; `session:died` совместим с существующим UI listener. Проверки: `atomic-chat-core npm run verify` зелёный (1635 passed + 12 e2e); Atomic Chat upstream-extension 310/310, focused web 33/33, `core::atomic_core` 75/75, `core::sessions` 28/28, полный `make test-rust` зелёный, `cargo clippy` зелёный, hardening 33/33, live с настоящим core 6/6. После стабилизации registry-mock и ожидания debounce полный web coverage зелёный без unhandled errors; production web bundle и native Tauri debug build (`--no-bundle`) собираются. Полный `make verify` остаётся красным только на pre-existing `test-quality` allowlist. Этапы 3c–3d не начаты.
- 2026-09-16 (этап 3c) — Ядро: `src/backend/service.ts` — то, чего не хватало между уже готовыми кирпичами (манифест, URL архива, загрузчик, распаковщик, сканер паков): установка, удаление и список. Два свойства, которые служба должна UI. Первое — **один task id на установку, и он от вызывающего**: прогресс-бар слушает событие с именем от задачи, и второй id, придуманный по дороге, оставил бы бар замершим; поэтому и архив, и CUDA-рантайм, который нужен некоторым Windows-бэкендам, идут под одним именем. Второе — **неудачная установка не оставляет ничего**: распаковка идёт в соседнюю staging-директорию и переезжает на место только когда всё приехало, иначе `selectInstalledBackend` нашёл бы полупак, рантайм запустился бы из него, и сбой вылез бы как «модель не грузится», а не как «загрузка не дошла». Маршруты `GET /backends/:provider`, `POST …/install`, `DELETE …/:version/:backend`. **Находка:** ветка `BINARY_NOT_FOUND` оказалась недостижимой — `resolveBackendArchiveSource` всегда отдаёт URL, падая на CDN ggml-org без контрольной суммы; это существующее поведение приложения (так ставится бэкенд для сборки, до которой зеркало не дошло), поэтому ветка убрана, а тест переписан на проверку самого фолбэка. 11 тестов службы, 34 в control-сервере; ядро 1646.
- 2026-09-16 (этап 3c) — Приложение: relay дополнительно излучает `download-<task_id>` с payload `{transferred, total}` — именно это имя и форму слушает download-extension и всё, что построено на нём. Маппинг вынесен в чистую функцию `legacy_event_for`, поэтому проверяется без Tauri; отсутствующие числа становятся нулями, а не `undefined`, иначе бар рисует NaN. 961 Rust-тест.
- 2026-09-16 (этап 3c) — Ядро: persistent optimal-cache в `BackendService` (`<data>/atomic-core/optimal-backend.json`, ключ — провайдер, потому что два llama.cpp-провайдера могут стоять на разных сборках) + маршруты `GET/PUT /backends/:provider/optimal`. Раньше запись жила в `localStorage` вебвью, где CLI её не видел, а папка данных, перенесённая на другую машину, тащила рекомендацию для железа, на котором никогда не работала. Запись `null` — это «забыть»: «Find optimal backend», ничего не нашедший, обязан очистить запись, иначе приложение продолжит рекомендовать бэкенд под исчезнувшее железо. Одна нечитаемая запись не стоит остальным ничего — каждая валидируется отдельно. **Находка:** существующий валидатор поймал мой несогласованный fixture — `idealBackendId` обязан совпадать с типом в `recommendedBackend`, и запись, где это не так, отвергается целиком.
- 2026-09-16 (этап 3c) — Приложение: все четыре пути установки бэкенда идут через один приватный `downloadAndInstallBackend`, туда и вставлена ветка ядра — task id строится теми же правилами, что и раньше, поэтому прогресс-бар, который пользователь уже смотрит, продолжает работать, не зная, какая сторона качает. `listInstalledBackends` и `deleteBackend` тоже уходят в ядро: оно владеет папкой, и собственное сканирование директории гонялось бы с его staging-переездом. Optimal-cache зеркалится в обе стороны — `adoptOptimalFromCore` один раз на старте (копия ядра лежит рядом с папкой, которую описывает, и потому выигрывает), запись — сквозная; `localStorage` остаётся копией, которую процесс читает синхронно, поэтому сигнатура `getCachedOptimalBackend()` не изменилась. Фикстура каденции прогресса: события разрежены (шаг 10 MiB), монотонны и последнее равно total — бар, который останавливается на 97 %, не завершается никогда. Ядро 1658, приложение 961, расширение 318, `upstream-backend-resolver` 6/6, hardening 33/33.
- 2026-09-16 (этап 3d) — Ядро: `src/models/capabilities.ts` — оставшиеся off-contract методы (валидация GGUF, наличие проектора, обученный контекст, поддержка спекулятивного декодирования) плюс маршруты `GET /models/:p/*id/capabilities`, `POST /gguf/validate`, `GET /hardware/devices`, `GET /settings/status`. Все отвечают, а не бросают: «это не модель» — ответ на вопрос, который пользователь задал, ткнув в файл, а не сбой ядра; и вызывающий обычно решает, что показать в списке, где один нечитаемый файл не должен опустошить список. Валидация отдельно называет CLIP-архитектуру: такие файлы — проекторы, они парсятся как совершенно нормальный GGUF, и импортированные как модель дают сессию, которая на любой запрос отвечает ничем. **Баг, который поймал собственный тест:** я скармливал `classifyProjector` метаданные модели, а она классифицирует *файл-проектор* и на метаданных без clip-ключей отвечает «vision» — выходило, что каждая текстовая модель принимает картинки. Теперь читается заголовок проектора, если он есть; тест на это добавлен.
- 2026-09-16 (этап 3d) — Приложение: `validateGgufFile`, `checkMmprojExists`, `getMaxCtxTrain`, `getDevices` уходят в ядро при включённом флаге. `getDevices` при владении ядра отвечает пустым списком вместо ошибки «бэкенд не настроен» — пока бэкенда нет, в Settings пользователю чинить нечего. Написаны два контрактных теста, которых план требовал и которых не было: `tests/extension-surface.test.mjs` (каждый метод, который зовёт `useBackendUpdater`, существует на классе — при `extension.method?.()` отсутствующий метод это молчаливый no-op, и кнопка просто ничего не делает; плюс адаптер не открывает HTTP сам и все мигрировавшие методы читают флаг владения) и `tests/pre-install-tarballs.test.mjs` (пакеты сохраняют legacy-имена `@janhq/*` — установщик резолвит расширения по имени, и имя записано в папку данных при первом запуске, так что переименование осиротит расширение у всех, кто его уже поставил; и один провайдер — один пакет). **Поправка по ходу:** первая версия теста считала дублем `engine: llama.cpp` у обоих llama.cpp-расширений — это метка семейства, а уникальным обязан быть `providerId`. Оба подключены в `test-hardening-contracts` (41 тест). Дефолтный провайдер уже `llamacpp-upstream`, флипать нечего. Ядро 1678, приложение 961, расширение 318.
- 2026-09-16 (review-fix этапов 3c–3d) — Ядро: production live-манифест с кешированием только успешного ответа, mirror-архив с hash/size и fallback ggml-org; proxy передаётся только на время установки и применяется к манифесту, основному архиву и CUDA companion. Добавлены control-cancel, revisioned per-provider optimal-cache с чтением старого файла, сериализованным CAS/409, событием после записи и `optimal_backends` в snapshot; добавлен core-owned embed с батчами, глобальными индексами и единственной перезагрузкой после 501. Приложение: relay действительно отправляет legacy progress event; расширение подписывается до POST, сохраняет монотонный прогресс и terminal UI events, отменяет core-owned task через ядро, но уже начатую legacy-загрузку оставляет за старым загрузчиком даже при смене владельца; ждёт запись optimal до обновления `localStorage`, отсекает устаревшие async-ответы после detach/resync и вызывает новый embed route. Legacy-путь сохранён, публичный `:1337/v1` не менялся; аппаратный отпечаток кеша намеренно не вводился (ADR). Проверки: ядро `npm run verify` зелёный (1697 passed, 2 skipped + 12 e2e, coverage floor), приложение `core::atomic_core` 79/79, `cargo check`/`cargo clippy` зелёные, upstream focused 147/147 и bundle, download extension 22/22 и bundle, web 3183 passed/16 skipped, hardening 41/41, `git diff --check` зелёный в обоих репозиториях. `make verify` остановлен прежним test-quality allowlist в несвязанных web-тестах; `make test-extensions` остановлен отсутствующим собранным `@janhq/tauri-plugin-hardware-api` (offline dev-зависимость недоступна). Ручной install/update/optimal/progress/cancel и live RAG текущей сборки не проверены; 4-й этап не начинался.
- 2026-09-16 (E2E-аудит этапа 3) — Расширены настоящие process/socket тесты: собранный core проходит через импорт настроек, 409, перезапуск, mirror/proxy/archive/checksum/fallback/cancel/SSE, optimal snapshot и embedding-сессию с 501/reload; Rust-приложение гоняет production lifecycle и relay с реальным бинарём, включая лимит рестартов. Тесты отделены от mockIPC и от пока **отсутствующего** desktop-UI E2E. Новый бинарный тест нашёл дефект: `acknowledge` повышает ревизию после подтверждения, и `/settings/status` возвращает `in_sync:false` сразу после сохранённого отката. Поэтому stage-3 E2E gate сейчас красный; UI install/update/progress/cancel, off→on→off, реальный RAG и Windows/Linux app↔core ещё не подтверждены. К этапу 4 не переходить.
- 2026-09-16 (исправление E2E-находки этапа 3b) — `acknowledge(R)` теперь сохраняет `R+1`: подтверждение само является атомарной metadata-записью и повышает общую ревизию, но не меняет уже скопированные provider values. Повтор запроса не пишет снова; если между mirror и acknowledge появились новые настройки, старый `R` отклоняется. Unit и бинарный E2E проверяют `in_sync:true` после подтверждения и перезапуска, `false` после следующей правки и возврат в `true` после свежего mirror. Это закрывает найденный дефект ревизии, но не заменяет отсутствующие desktop-UI E2E и не снимает запрет перехода к этапу 4 до их проверки.
- 2026-09-16 (этап 4) — Этап разбит на подэтапы с отсечкой после каждого, как этап 3: **4a** шимы (Responses↔Chat Completions в обе стороны и Anthropic `/messages`), **4b** роутер и маршруты публичного сервера (гейты, CORS, ctx retry, state-file), **4c** облако, `credentials.json`, ChatGPT OAuth с единственным writer, **4d** `api:request` и регистрация сессий, остающихся в Rust (TurboQuant, MLX, FM), **4e** сериализованная передача публичного API в приложении и откат `atomic_core.server=legacy`. Причина: `proxy.rs` и соседи — около 13 тысяч строк, и одна отсечка на весь этап сделала бы проверку неподъёмной.
- 2026-09-16 (этап 4a) — Инфраструктура порта шимов. `src/server/shims/{json,responses,chat-to-responses,anthropic}.ts` с сигнатурами Rust-API, `test/contract/shims.test.ts` повторяет процедуру реплея из `index.json → comparator_notes` каждого набора и нормализует случайные id так же, как дамп: плейсхолдеры по порядку первого появления при обходе с **отсортированными ключами** — serde_json без `preserve_order` обходит объекты именно так, и иной порядок дал бы другую нумерацию на тех же данных. `PENDING` показывает непортированный набор как skipped, а не passed; `ATOMIC_REPLAY_SETS` включает набор для порта в работе, не объявляя его пройденным для остальных. Для Anthropic-преобразований фикстур из этапа 0 не было — написан дамп `proxy_anthropic_fixture_dump.rs` (44 кейса: запросы, ответы, стримы с явными границами сетевых чтений), подключён дочерним модулем `proxy.rs`, чтобы гонять приватные функции без смены видимости. **Дефект Rust, который дамп зафиксировал:** стрим Anthropic режет на строки каждое сетевое чтение отдельно, и строка `data:`, разрезанная между двумя чтениями, парсится как два невалидных куска и молча теряется — кусок ответа пропадает. Порт буферизует строки между чтениями; ровно этот кейс помечен в `known_divergence` и проверяется харнессом как исправленное поведение, а не пропускается. Остальные детали, которые дамп прибил: аргументы `tool_use` сериализуются компактным JSON с отсортированными ключами, а содержимое `tool_result` = `null` становится строкой `"null"`. Импорт: 480 файлов, чексуммы ядра и приложения совпадают.
- 2026-09-16 (этап 4a) — Шимы портированы, три агента параллельно, каждый в своём файле. Все три набора реплеятся без флагов, `PENDING` пуст: responses-shim 58/58, chat-to-responses-shim 62/62, anthropic-shim 43/43; `npm run verify` зелёный (1917 тестов), пороги покрытия засеяны для четырёх новых файлов (88–100 % ветвей). Общее для всех трёх портов, чего JS-идиома не даёт: в Rust `get` на ключе со значением `null` возвращает `Some(Null)`, поэтому фолбэки срабатывают только на **отсутствующем** ключе — `??` в TS сработал бы и на `null` и тихо поменял бы вывод (агент responses-shim поймал это собственным тестом на `call_id: null`); нестроковые значения (аргументы `tool_use`, содержимое `tool_result`) сериализуются компактно с ключами, отсортированными по байтам UTF-8, `null` становится строкой `"null"`; счётчики токенов принимают только целые ≥ 0. **Два отступления от Rust, оба — баги без зависимых (правило §2 решение 15):** (1) Anthropic-стрим буферизует строки между сетевыми чтениями (Rust терял разрезанную строку), и для этого добавлен `finish()` на конец тела — без него буферизация сама создала бы регрессию: финальный `data: [DONE]` без перевода строки больше никогда не закрыл бы сообщение, а Rust его обрабатывал; (2) `responsesCallId` отступает к границе символа, а не падает — в Rust `&value[..31]` паникует на не-ASCII id длиннее 64 байт и роняет запрос; id, которые Rust когда-то выдал, от этого не меняются, потому что для таких входов он не выдал ни одного. **Не совпадает и не покрыто фикстурами:** после `JSON.parse` JS не отличает `1.0` от `1` и теряет точность целых выше 2^53, поэтому такие числа внутри сериализованных аргументов инструментов могут напечататься иначе, чем в Rust.
- 2026-09-16 (этап 4b) — Контракт публичного сервера снят с настоящего прокси. `proxy_http_fixture_dump.rs` (дочерний модуль `proxy.rs`) поднимает реальный `start_server` против скриптуемого stub-апстрима и шлёт сырые HTTP/1.1 запросы через сокет — так кейс может прислать ровно те заголовки, что перечислены, включая запрос вообще без `Host`, который ни один HTTP-клиент не сформирует. Записывается и ответ клиенту, и то, что увидел апстрим. 78 кейсов: гейты хоста/ключа, CORS и preflight, статика и OpenAPI, префикс (включая квирк `/v1models` → `/models`: префикс снимается как строка), листинги, маршрутизация local/remote/alias, ошибки апстрима, ctx-retry, compute-error, фолбэк `/messages`, `/responses`, metrics. Ответ на `local_backend://auto_increase_ctx` скриптуется на mock-приложении, поэтому ветки ретрая сняты без 60-секундного таймаута. Нормализация: порты, id `resp_/msg_/fc_`, текст ошибки парсера JSON и текст транспортной ошибки reqwest после фиксированного префикса (`<transport error>`) — это формулировки библиотек, а не API. **Дефект Rust, зафиксированный как `known_divergence`:** кастомные заголовки провайдера хранятся (`remote_provider_commands.rs`), но прокси их никогда не отправлял; порт отправляет их во все вызовы к провайдеру. Дамп детерминирован (три прогона байт-в-байт), импорт 559 файлов, CHECKSUM `8f552ed0…` в обеих репах.
- 2026-09-16 (этап 4b) — Порт: `src/router/resolve.ts` (remote: список моделей → префикс `provider/` → имя провайдера; `modelIdsMatch` с `.`↔`_`), `src/server/public/{gates,static,listing,forward,responses,ctx,errors,wire,sse,exchange,index}.ts`, `src/server/state-file.ts`; старый упрощённый `src/server/public.ts` (JSON-ошибки, CORS `*` по флагу, 502) удалён, `core.ts` и control `POST /server/start` (добавлены `trusted_hosts`, `proxy_timeout_secs`; `corsEnabled` убран — Rust-прокси CORS не выключает) переключены. Реплей: proxy-http 78/78 и state-file 12/12 (+1 тест best-effort записи); три копии serde-сериализатора из агентов 4a сведены в `shims/json.ts#serdeToString`. Решения: апстрим через `node:http`, а не `fetch` — прокси пересылает клиентские заголовки, которые `fetch` запрещает или переписывает; hop-by-hop заголовки не пересылаются и `Content-Length` ставится свой (в Rust их копировал reqwest — на контракт не влияет); `proxy_timeout` ограничивает только подключение, стрим режется по простою 600 с, как в Rust; одновременные переполнения одной модели делят один reload (leader/follower из `context_expansion.rs`). **Найдено по дороге:** восстановление после compute-ошибки в Rust — перезагрузка с тем же контекстом (расширение), а у рантайма ядра был только рост по лестнице; добавлен `LlamacppRuntime.recreateSession`, и `core.ts` направляет туда триггер `compute_error_recovery` — иначе ядро на OOM увеличивало бы контекст и делало OOM вероятнее. В приложении расширение обрабатывает этот триггер **до** проверки `coreOwnsRuntime` и перезагрузило бы модель, которой владеет ядро — уйдёт с передачей сервера в 4e. **Bun:** релизный бинарь работает на Bun, поэтому контракты гоняются и там (`npm run test:contract:bun`, в `verify` и CI). Первый прогон под Bun дал 19 зависаний: Bun не закрывает соединение после маленького ответа, записанного после `await`, даже при `Connection: close`, а ручное закрытие обрезает большие тела (бандл Swagger 1,5 МБ приходил на 327 КБ). Ответы при этом корректно обрамлены `Content-Length`/chunked, реальные клиенты не зависают; сервер не трогали, харнесс читает по фреймингу. Под Node и Bun 78/78. Интеграция в ядро проверена фейковым llama-server, которому добавлены `FAKE_LLAMA_MIN_CTX` и `FAKE_LLAMA_COMPUTE_ERROR_MARKER`: ядро растит контекст и повторяет запрос (при выключенном `fit` — с `fit` ядро честно отказывается), и перезапускает «отравленный» движок на том же контексте с 400 `insufficient_memory`. `npm run verify` зелёный: 2040 тестов, пороги покрытия засеяны для 12 новых файлов. **Не сделано в 4b:** удалённые провайдеры в ядре пока пустые (`providers: () => new Map()`, придут с `credentials.json` в 4c); ChatGPT-маршрут — 4c; событие `api:request` старый сервер слал в упрощённом виде, новый не шлёт до 4d (потребителей нет); state-file не пишется ядром до передачи writer в 4e; инспектор/инъекция `stream_options` не портируются (§3 таблица `server/`). Rust `cargo test --lib` приложения зелёный (952 passed, 6 ignored — дампы и live).
- 2026-09-16 (этап 4b, e2e) — Публичный сервер проверен через собранный бинарь: `test/e2e/public-server.test.ts`, 10 тестов, демон + фейковый llama-server как настоящий процесс. Покрыто: документация, встроенная в Bun-бинарь, байт-в-байт по sha256 из фикстур (CSS и бандл Swagger); гейты, настроенные через control (`api_key`, `trusted_hosts`) — 401/403/400 без Host, доки в обход гейтов, скрытый `/configs`, 405 с `Allow`, preflight и отражение origin; холодный сервер 503 vs неизвестная модель 404 vs кривое тело 400; рост контекста с повтором запроса и перезапуском процесса; отказ расти под `fit` с ошибкой движка; «отравленный» движок перезапускается, клиенту 400 `insufficient_memory`, следующий запрос проходит; `/messages` через фолбэк целиком и стримом (полная последовательность событий Anthropic); `/responses` целиком и стримом; эмбеддинги, metrics, `/models` и каталог Muse; убитый бэкенд → 503 `backend_unavailable` + `Retry-After` (тест допускает и 503 «No models are available», если ядро успело заметить смерть процесса; в трёх контрольных прогонах срабатывала основная ветка). Хелперы бинарного e2e вынесены из `owner.test.ts` в `test/helpers/compiled-core.ts`, фейку добавлен `/metrics`. Весь e2e-набор пять прогонов подряд зелёный (29 passed, 1 skipped). Через бинарь не проверены удалённые провайдеры (придут в 4c) и Windows (фейковый бэкенд — shell-скрипт; как и остальной бинарный e2e, эти кейсы на Windows пропускаются, кроме документации и гейтов).
- 2026-09-16 (этап 4c) — Облако и ChatGPT-подписка в ядре. **Контракт** снят дампами с Rust (дочерние модули, чтобы гонять приватные `to_stored`, `TokenResponse`, `build_upstream_request`, `normalize_model` без смены видимости): `chatgpt-auth` (64 кейса: PKCE, точная строка authorize URL, разбор callback, сравнение `state`, JWT-claims включая строгий base64 без паддинга, ответ токен-эндпоинта → сессия с клампом срока жизни, байты и режим файла токенов, чтение с версией/типами) и `chatgpt-route` (19: точные заголовки/URL/тело запроса к подписке, нормализация моделей). Сетевые половины (`exchange_code`, `refresh_tokens`, `respond`) ходят на закреплённые https-хосты и не снимаются — их поведение записано в `comparator_notes` и закреплено юнит-тестами порта. Реплей 85/85 с первого прогона, под Node и Bun. **Порт:** `src/credentials/{api-keys,chatgpt-store,chatgpt-oauth,chatgpt-auth}.ts`, `src/cloud/{registry,chatgpt}.ts`, `src/server/public/subscription.ts`; ключи провайдеров — `credentials.json` (0600, `.tmp`+rename с режимом на временном файле), всё остальное — `settings.json` `cloud.providers` (новый `SettingsStore.setCloudProviders`), порядок регистрации стабилен (в Rust `HashMap` делал выбор между провайдерами с одинаковой моделью случайным). Control: `GET/PUT/DELETE /cloud/providers[/:id]` (ключ никогда не читается обратно, только `has_api_key`), `GET /auth/chatgpt`, `POST /auth/chatgpt/login` → `{authorize_url}`, `POST /auth/chatgpt/login/wait`, `/login/cancel`, `/logout`, `GET /auth/chatgpt/models`; новые коды `AUTH_REQUIRED` (401), `AUTH_FAILED`/`UPSTREAM_ERROR` (502), `AUTH_CANCELLED` (409). CLI: `providers list|set|remove` (`--api-key-env`, чтобы ключ не попадал в историю shell), `auth chatgpt status|login|logout|models`. **Решения:** логин двухфазный, потому что headless-ядро не может открыть браузер (callback-слушатель на :1455 поднимается до открытия браузера, как в Rust); **два отступления от Rust ради одного writer при передаче владения (решение 11):** перед refresh ядро перечитывает файл и берёт токены, уже ротированные другим процессом, а терминальная ошибка refresh чистит сессию только если в файле всё ещё отвергнутый refresh-токен — иначе приложение и ядро выкидывали бы пользователя из живой сессии. Тестовые хуки `ATOMIC_CHATGPT_ISSUER`, `ATOMIC_CHATGPT_BASE_URL`, `ATOMIC_CHATGPT_CALLBACK_PORT` (только для стабов; прод их не задаёт). **Приложение:** `register_provider_config`/`unregister_provider_config` зеркалятся в ядро при любом attach (импорт до передачи владения); пока сервером владеет legacy, сбой зеркала только логируется, после передачи — возвращается в webview. `chatgpt_*` при `atomic_core.server=core` идут в ядро (приложение открывает браузер само), иначе — старый путь; `ChatGptStatus`/`SubscriptionModel` получили `Deserialize`. **Найдено:** callback-слушатель закрывался раньше, чем браузер получал страницу («ECONNRESET» вместо «можно закрыть вкладку»): теперь сессия завершается по `finish` ответа и закрываются только простаивающие соединения. **Проверки:** unit (ротация между процессами, single-flight, реальный loopback callback: обмен кода с verifier, чужой `state`, ошибка провайдера, отмена, занятый порт, таймаут; реестр; маршрут подписки; control/client; CLI), core (провайдер переживает перезапуск ядра, подписка из общего файла), e2e через бинарь (`test/e2e/cloud.test.ts`: `providers set` CLI → маршрутизация с ключом и заголовками, ключ не в settings, `credentials.json` 0600; логин через control против стаба, стрим подписки после принудительного refresh на 401, файл токенов переписан 0600, CLI status/logout, 401 после выхода). `npm run verify` зелёный (2180 + 341 под Bun + 31 e2e); Rust приложения 954 passed. **Не сделано в 4c:** живые `auth.openai.com`/`chatgpt.com` (live-cloud), webview-логин через ядро не прогонялся в UI; сброс in-memory сессии legacy при возврате владения — в 4e.
- 2026-09-16 (этап 4d) — `api:request` и сессии, которыми владеет приложение. **Контракт** `inspector-telemetry` (42 кейса: превью промпта, телеметрия стрима с явными смещениями времени, инъекция `include_usage`, распознавание trailer) снят дочерним модулем `request_inspector.rs`; реплей 43/43 с первого прогона. **Ядро:** `src/server/public/{telemetry,trace}.ts` — на каждый запрос `RequestTrace` с полями `EmitState` (метки endpoint/backend/error_kind — те же закрытые наборы, что в Rust), закрывается по `close` ответа, так что ранний return не теряет finish (в Rust для этого `FinishGuard`). Событие `api:request` (`src/contracts/events.ts`): `finished` с `observation` на весь продуктовый трафик (preflight, доки, опрос `/models`/`/metrics`, сканеры, `/configs` исключены как в Rust); `started`/`progress` и превью — только пока открыт API-экран (`PUT /server/inspector`, ATO-113). Под инспектором локальный стриминговый чат получает `include_usage`, и trailer вырезается, как в Rust. **Отступление:** TTFT считается от прихода запроса; Rust в finished мерил от старта relay, в progress — от прихода, и один запрос показывал два числа. Внешние сессии: `src/runtime/external-sessions.ts` + `PUT/DELETE /external-sessions/:owner`, heartbeat, `POST …/ctx/:request_id`; снимок с generation (старая generation → 409), TTL 30 с, ядро чужие PID не трогает; рост контекста для чужой сессии — событие `external-sessions:ctx-requested` и ожидание ответа владельца 60 с (как у прокси к расширению), при отписке владельца — `owner_gone`. Публичный сервер ищет сессии ядра, затем внешние, и `/models` их показывает. **Приложение:** события `atomic-core://api:request` не уходят в webview (могут нести превью), а кормят `ApiRequestAggregator` (свой 180-секундный таймер) через `observation_from_core` с маппингом на закрытые наборы меток и `RequestInspector::ingest_core_event` (свой монотонный seq, те же `api-inspector://` каналы); `set_api_inspector_enabled` и каждый snapshot ядра переотправляют состояние инспектора. Публикатор `atomic_core/external.rs` работает в той же lifecycle-задаче, что relay: пока `atomic_core.server=core`, раз в 5 с публикует снимок legacy-сессий (`llamacpp`, `mlx`, `llamacpp-upstream`, если runtime не отдан ядру) или heartbeat, при возврате сервера — снимает регистрацию; на запрос роста вызывает существующий `request_context_increase` (расширение), публикует новый порт и только потом отвечает. FM не публикуются — прокси их никогда не маршрутизировал. **Проверки:** unit/core/контракт + e2e через бинарь (`test/e2e/api-events.test.ts`: наблюдение без превью, превью после включения инспектора, внешняя TurboQuant-сессия с ключом по alias, 409 на старую generation, рост контекста через ответ владельца по control). `npm run verify` зелёный (2245 + 341 под Bun + 33 e2e); Rust приложения 961 passed. **Не проверено:** публикатор приложения против живого ядра (в 4e live-тест), UI API-экрана при сервере ядра; `ttft-timing` (perf-маркеры webview) не портирован.
- 2026-09-16 (этап 4e) — Передача публичного API. **Приложение:** `start_server`/`stop_server`/`get_server_status` сохранили имена и payload; за ними `PublicApiOwner` (`src-tauri/src/core/server/ownership.rs`): `LegacyOwner` — прежний прокси (вынесен из `commands.rs` без изменения поведения), `CoreOwner` — `POST /server/start` c `state_file: true` и `fallback_port: true`, перед стартом ядру передаются все `provider_configs`. Выбор — по флагу `atomic_core.server`; в enum добавлен явный откат `legacy` (`core_serves()` вместо `is_some()`, иначе `"legacy"` читался бы как «ядро»). `set_atomic_core_flags` при смене владельца сервера под тем же transition/operations-замком вызывает `hand_over`: ничего не запущено → меняется только флаг; иначе старый владелец останавливается (освобождает порт), новый стартует с последней конфигурацией webview; сбой → перезапуск старого, двойной сбой → явное «остановлен», флаг не сохраняется. Вызовы к ядру во время перехода идут напрямую в supervisor (обычный путь ждал бы этот же переход — дедлок). Сессия ChatGPT переходит вместе с сервером: к ядру — отмена незавершённого legacy-логина, обратно — `ChatGptAuthState::invalidate()`, чтобы приложение перечитало файл, а не рефрешнуло токеном, который ядро уже ротировало (иначе `invalid_grant` и выход из аккаунта). `local_server_endpoint` (агент) указывает на ядро, пока оно обслуживает. **Найдено и исправлено:** (1) legacy `stop_server` делал `abort()` без ожидания — listener мог держать порт ещё миллисекунды, и ядро при фолбэке молча уходило на другой порт; теперь задача дожидается; (2) сервер ядра при занятом порте отвечал ошибкой, а Rust-прокси всегда уходил на свободный порт (ATO-189) — добавлен `fallbackPort` (CLI по-прежнему строгий), повтор того же запроса остаётся идемпотентным; (3) расширение обрабатывало `compute_error_recovery` раньше проверки владения и перезагружало модель ядра — теперь при владении ядром вызывает `POST /models/:p/*id/recreate`. **Ядро:** `writeStateFile` пишет app-файл при старте и помечает stopped при остановке только в этом режиме, `/recreate`, `fallback_port`, понятная ошибка при невозможности даже фолбэка. **Проверки:** unit `ownership.rs` (6 сценариев передачи + тело `/server/start`), live-тесты с собранным ядром (`make test-core-live`: ядро берёт тот же порт, отдаёт переданного провайдера, пишет и помечает state-файл, откат; неbindable адрес → восстановление или «остановлен»; все 10 live-тестов зелёные), тест расширения, core-тесты state-файла и фолбэка; `npm run verify` ядра зелёный (2248 + 384 под Bun + 33 e2e); в приложении `make test-rust` зелёный (970 в основном крейте + плагины), `test-hardening-contracts` 41/41, покрытие расширения 331/331, чексумма фикстур совпадает. `make verify-fast` приложения целиком не запускался: глобальный yarn 1.x против `yarn@4.5.3` без corepack; `test-quality` падает на 13 уже существующих web-app тестах (call-only assertions), этой работой не затронутых. **Не проверено:** реальный `LegacyOwner` внутри запущенного Tauri и экран сервера во время смены флага — нужна ручная приёмка; живые Codex/Claude Code/OpenCode и live-cloud из критериев выхода этапа 4 не прогонялись; версия ядра в `package.json` приложения (`0.1.0`) не поднята — новые маршруты требуют сборки ядра с этапами 4b–4e.
- Не сделано в этапе 0 (осознанно): replay фикстур `responses-shim`/`chat-to-responses-shim`/`state-file` — при порте `server/` на этапе 4 (сейчас только проверка формы, не засчитывается как parity); `hardware/`, `runtime/mlx`, `runtime/foundation-models` — по плану позже; I/O-половина `backend/` (install/scan/verify binary) — этап 1.

---

## 1. Контекст

### 1.1 Что есть сейчас

Atomic Chat — Tauri + React приложение (форк Jan), запускает локальные LLM и отдаёт OpenAI-совместимый API на
`localhost:1337/v1`. Логика «запустить и настроить инференс» разрезана по языковой границе и продублирована трижды:

| Слой | Где | Объём | Проблема |
| --- | --- | --- | --- |
| Политика: выбор бэкенда по железу, `model.yml`, 34 настройки провайдера, подбор контекста, спекулятивные драфты | `extensions/llamacpp-upstream-extension/src/index.ts` (+ клон `llamacpp-extension`, + `mlx-extension`) | 10k + 7.5k + 3.3k строк TS | исполняется **внутри webview**, завязана на `invoke`, `localStorage`, шину событий `@janhq/core` |
| Механика: спавн `llama-server`, аргументы, готовность, `--list-devices`, GGUF, докачка | `src-tauri/plugins/tauri-plugin-{llamacpp,llamacpp-upstream,mlx,foundation-models,hardware}` | ~26k строк Rust | два плагина — клоны; всё привязано к Tauri-командам |
| Облако и прокси: провайдеры, ключи, роутер «модель → провайдер», шимы Responses↔Chat, ChatGPT OAuth | `web-app/src/lib/model-factory.ts`, `src-tauri/src/core/server`, `src-tauri/src/core/auth` | 4k TS + 11k Rust | ключи в `localStorage` webview + зеркало в памяти Rust |
| CLI | `src-tauri/src/bin/jan-cli.rs`, `src-tauri/src/core/cli` | 2.6k Rust | третья, урезанная реализация той же политики для одного провайдера |

Ни один слой не переиспользуем вне приложения.

### 1.2 Цель

Самостоятельный TypeScript-пакет `atomic-chat-core` (этот репозиторий), который владеет локальным **и** облачным
инференсом и OpenAI-совместимым сервером. Потребители:

1. **CLI** — один бинарь из этого репозитория.
2. **Tauri-приложение** — клиент локального процесса ядра, поставляемого вместе с приложением.
3. **Внешние OpenAI-клиенты** — Codex, Claude Code, OpenCode, curl.
4. **TS-программы** — как библиотека.

Приложение переезжает на ядро поэтапно в рамках этого плана; Rust-плагины инференса и Rust-прокси удаляются последними.

**Граница этой миграции — desktop:** macOS, Windows x64, Linux x64. iOS/Android сохраняют необходимую Rust-реализацию
и отдельные сборочные проверки. Перенос mobile и удаление его пути исполнения требуют отдельного плана.

---

## 2. Принятые решения

| # | Решение | Причина |
| --- | --- | --- |
| 1 | Язык — **TypeScript**, не Rust | политика уже на TS; Rust-механика тонкая и хорошо специфицирована (§8.2) |
| 2 | **Bun** для упаковки и исполнения скомпилированного бинаря; **код в рамках Node-совместимого API**: `node:*`, без `Bun.*`, без нативных аддонов | уменьшает привязку к рантайму; Node SEA — кандидат на запасной путь, а не подтверждённая замена одной строкой |
| 3 | Бэкенды v1 — **все четыре**: `llamacpp-upstream`, `llamacpp` (turboquant), `mlx`, `foundation-models` | решение владельца |
| 4 | Облако, роутер и HTTP-сервер `:1337` — **в ядре**; Rust-прокси удаляется последним | единственное место, знающее все провайдеры, ключи и сессии |
| 5 | **Порядок: локальный runtime, управление и владение процессами → CLI → адаптер приложения → публичный сервер и облако** | минимальный control API и attach нужны до поставки CLI; зеркало сессий сохраняет прямой путь Rust-агента |
| 6 | `jan-cli` заменяется TS-CLI: имя файла `resources/bin/jan-cli` остаётся, содержимое — копия бинаря `atomic-chat-core` | имя load-bearing (AGENTS.md приложения §4); один бинарь диспатчит по подкоманде |
| 7 | **Control `/atomic/v1/*` + SSE отделён от публичного `/v1`; app и CLI владеют разными экземплярами** | stop/start публичного API не отключает управление; полный выход приложения завершает только app-core, команда CLI оставляет daemon жить |
| 8 | **Изоляция данных**: приложение сохраняет `<data>`, CLI использует `<system data>/atomic-chat-cli/data` | модели, настройки, ключи, lock и state-file не пересекаются; ни миграции, ни автоматического копирования |
| 9 | Новые файлы ядра только под **`<data>/atomic-core/`** | одна новая папка данных, оформляется ADR в приложении |
| 10 | Железо: shell-пробы + `--list-devices` в ядре; приложение **инжектит** точные NVML/Vulkan-данные через `PUT /atomic/v1/hardware/override` | без нативных аддонов нет NVML; `tauri-plugin-hardware` остаётся |
| 11 | ChatGPT OAuth переезжает в ядро на этапе сервера; callback-порт 1455 фиксирован; ровно один writer токенов и refresh | переключение сервера включает передачу auth-владения, отмену старого callback и остановку старого refresh |
| 12 | AI SDK в ядре только `ai` + `@ai-sdk/openai-compatible` для `atomic-chat-core/client`; сервер форвардит облако сырыми телами с подстановкой ключа | так делает `proxy.rs`; приложение уже шлёт provider-native тела |
| 13 | Внешние зависимости: `yaml`, `tar`, `yauzl`, `ai`, `@ai-sdk/openai-compatible`; CLI-парсер — `node:util.parseArgs` | всё остальное `node:*` |
| 14 | Никаких `jan*` идентификаторов; `atomic-*` | правило приложения |
| 15 | Ловушки Rust (§8.2): Windows `PATH` с CUDA **чинится** (prepend); `parseBackendVersion("b10018-1.3.0")=0` **воспроизводится** до ухода приложения с Rust-плагинов | первое — баг без зависимых; на втором висит гейт `verify_backend_binary` |
| 16 | Тесты: юниты рядом с кодом, контракт-фикстуры из Rust, e2e на скомпилированном бинаре, app-e2e против Tauri-приложения, live по env | AGENTS.md §5; аварии, повторное подключение, два клиента и миграция проверяются до включения соответствующего этапа |

---

## 3. Архитектура ядра

### 3.1 Репозиторий (один пакет, три входа)

```
atomic-chat-core/
├── AGENTS.md  PLAN.md  package.json  tsconfig.json  tsconfig.build.json  eslint.config.js  vitest.config.ts
├── .github/workflows/{ci.yml,release.yml}
├── scripts/{check-runtime-agnostic,check-test-quality,check-coverage-floor,build-binaries,import-app-fixtures}.mjs
├── src/
│   ├── index.ts                      # вход библиотеки (node)
│   ├── core.ts                       # фасад AtomicCore
│   ├── contracts/                    # BROWSER-SAFE: типы и константы
│   ├── client/                       # BROWSER-SAFE: injectable transport (fetch / Tauri relay); atomicProvider()
│   ├── config/  events/  settings/  credentials/  hardware/  downloads/
│   ├── backend/  models/  speculative/
│   ├── runtime/{process,ports,types}.ts + llamacpp/ mlx/ foundation-models/
│   ├── cloud/  router/  server/  lock/
│   └── cli/main.ts + commands/
├── test/{contract,e2e,app-e2e,runtime-compat,live}/  fixtures/  helpers/  coverage-floor.json
└── docs/{contracts.md,testing-critical-flows.md,app-e2e.md} + decisions/
```

Точки входа: `.` (библиотека), `./client`, `./contracts` (оба без `node:*`), `bin` → `dist/cli/main.js`.
Сборка бинаря: `bun build --compile --target=bun-<darwin-arm64|darwin-x64|windows-x64|linux-x64>` →
`dist/bin/atomic-chat-core-<triple>`, где triple — как у `bun`/`uv` в приложении (`scripts/download-bin.mjs:205-253`).
`tsconfig` с `types:["node"]` без `bun-types`: любой `Bun.*` не компилируется. JSON-схемы настроек импортируются
через `with { type: 'json' }`, чтобы попасть в бинарь.

### 3.2 Модули: ответственность и источник портирования

| Модуль | Ответственность | Портируется из | Что меняется |
| --- | --- | --- | --- |
| `config/` | папка данных, `DataLayout`, `ProviderPaths`, `backendExePath` | `src-tauri/src/core/app/commands.rs:41-95,193-230`; `index.ts getProviderPath/getModelsRootPath`; `backend.ts:1039-1070` | + `<data>/atomic-core/` |
| `events/` | типизированный `EventEmitter`, `onAny` для мостов | — | новый |
| `settings/` | `<data>/atomic-core/settings.json`, схемы, legacy-импорт | `core/src/browser/extension.ts:150-215`, три `extensions/*/settings.json`, `index.ts:828-1044` | `localStorage` → файл; только канонические ключи |
| `credentials/` | `credentials.json` 0600, ChatGPT PKCE | `core/auth/{store,chatgpt,state}.rs`, `utils/registerRemoteProvider.ts` | ChatGPT-токены остаются в старом файле |
| `hardware/` | `SystemInfo`/`SystemUsage`, тиры CUDA/Vulkan/ROCm | `tauri-plugin-hardware/src/*` (формы), `backend.rs:703` | NVML/Vulkan → пробы + override |
| `downloads/` | докачка, sha256, `[disk_*]`, архивы, `normalizeBackendLayout` | `core/downloads/*.rs`, `core/filesystem/commands.rs:335-515` | `fetch` + `tar`/`yauzl` |
| `backend/` | манифест, URL, выбор по железу, install/update, optimal-cache | `extensions/llamacpp-upstream-extension/src/backend.ts`, `scripts/resolve-upstream-backend.mjs`, `bundledManifestBaseline.ts`, Rust `backend.rs`, `index.ts:1070-3195` | `tauriFetch` → injected fetch |
| `models/` | `model.yml`, реестр, import (URL/HF/local/шарды), GGUF | `guest-js/types.ts:142-171`, `index.ts:3206-4110`, `gguf/*.rs`, `util.ts`, `jan-cli.rs:300-490` | `read_yaml`/`write_yaml` → `yaml` |
| `speculative/` | реестры DFlash/MTP/EAGLE-3, транскрипция, chat-template overrides | `dflashRegistry.ts`, `gemmaMtpRegistry.ts`, `transcriptionRegistry.ts`, `chatTemplateOverrides.ts`, `index.ts:4116-4400,3350-3437` | verbatim |
| `runtime/process.ts` | спавн, env, готовность, kill, порты, api-key | `commands.rs:66-381`, `process.rs`, `path.rs`, `utils/src/system.rs:44-340` | `node:child_process` |
| `runtime/llamacpp/` | `args`, `errors`, `runtime-device`, `devices`, `probe`, `load-plan` (23 шага), `runtime` | `args.rs`, `error.rs`, `runtime_device.rs`, `device.rs`, `commands.rs:594`, `index.ts:4489-5249` | один класс с параметром провайдера |
| `runtime/mlx/` | MLX-сайдкар | `tauri-plugin-mlx/src/commands.rs`, `extensions/mlx-extension/src/*` | бинарь из `--resources-dir` |
| `runtime/foundation-models/` | Apple Intelligence сайдкар (macOS 26+) | `tauri-plugin-foundation-models/src/commands.rs`, `extensions/foundation-models-extension` | бинарь из `--resources-dir` |
| `cloud/` | реестр провайдеров, keyless/subscription правила, форвардинг, ChatGPT-маршрут | `services/provider-registry.ts`, `constants/providers.ts:57-151`, `remote_provider_commands.rs`, `chatgpt_route.rs`, `chat_to_responses_shim.rs` | ключи → `credentials` |
| `router/` | «модель → цель», auto-increase-ctx | `proxy.rs:2497-2655`, `context_expansion.rs` | прямой вызов runtime вместо Tauri-лестницы |
| `server/` | `/v1/*`, `/atomic/v1/*`, гейты, SSE, шимы, state-file | `proxy.rs`, `responses_shim.rs`, `proxy.rs:283-700` (Anthropic→OpenAI), `sse.rs`, `state_file.rs` | телеметрия и инспектор **не** портируются → события `api:request` |
| `lock/` | `instance.lock`, идентичность владельца, attach, журнал дочерних процессов, защита legacy-ресурсов | — | новый; координация с reaper приложения до поставки CLI |
| `cli/` | `daemon`, `serve`, `launch`, `models`, `backends`, `hardware`, `providers`, `auth`, `settings`, `server`, `shutdown`, `doctor` | `bin/jan-cli.rs`, `core/cli/*.rs`, `core/system/commands.rs configure_*` | `node:util.parseArgs` |

### 3.3 Фасад и соответствие контракту приложения

```ts
class AtomicCore {
  static create(opts: { dataFolder?, resourcesDir?, providers?, fetch?, env?, logger?, controlToken?, role?: 'owner' | 'auto' }): Promise<AtomicCore>
  events: CoreEmitter<CoreEvents>; layout: DataLayout; settings: SettingsStore; credentials: CredentialStore
  hardware: HardwareService; downloads: Downloader; cloud: CloudService; router: Router; server: ApiServer
  runtime(p): LocalRuntime; backends(p): BackendService; models(p): ModelService; speculative(p): SpeculativeService
  load(p, id, opts?): Promise<SessionInfo>; unload(p, id); findSession(id, p?); listAllModels(); configureAll(); dispose()
}
interface LocalRuntime {
  load; unload; findSession; sessions; getLoadedModels; getMaxCtxTrain; getRuntimeDeviceInfo; getDevices
  embed; getTokensCount; isToolSupported; getReasoningControls; autoIncreaseCtx; unloadAll
}
```

| Сегодня в приложении (`AIEngine` + off-contract) | В ядре |
| --- | --- |
| `get/list/delete/update/import/abortImport` | `models(p).*` |
| `load(id, settings, isEmbedding, bypassAutoUnload)`, `unload`, `getLoadedModels`, `find_session_by_model` | `runtime(p).load/unload/getLoadedModels/findSession` |
| `chat()` — приложением не используется | нет на фасаде; потребители идут в `/v1` или через `client.atomicProvider()` |
| `isToolSupported, getReasoningControls, getMaxCtxTrain, getTokensCount, embed, getDevices, getRuntimeDeviceInfo` | `runtime(p).*` |
| `checkMmprojExists, isModelSupported, validateGgufFile` | `models(p).checkMmprojExists`, `gguf.isModelSupported/validateFile` |
| `check*MtpSupport, ensureGemmaMtpDraft, checkDflash*, listDflashDrafts, ensureDflashDraft, ensure/release/touchTranscription*` | `speculative(p).*` |
| методы `useBackendUpdater.ts` (список фиксируется инвентаризацией call-sites) | `backends(p).*` — те же имена |
| `getSettings/updateSettings` | `settings.schema(p)` / `settings.update(p, patch)` |
| `register_provider_config` | `cloud.upsert()` + `credentials.setApiKey()` |
| `start_server/stop_server/get_server_status` | `server.start/stop/address` |

### 3.4 Состояние на диске

| Файл | Формат | Владелец |
| --- | --- | --- |
| `<data>/atomic-core/settings.json` (защищён как credentials) | `{version, revision, providers:{<p>:{…}}, server:{host,port,prefix,api_key,trusted_hosts,cors_enabled,proxy_timeout_ms,enable_on_startup}, cloud:{providers[]}, state:{providers:{<p>:{backend_type,pending_backend,better_backend_recommendation,last_recheck_outcome}}, migrations:{<scope>:{baseline,legacy_hash,acknowledged_revision}}}}`; атомарная запись через `.tmp` + rename | `SettingsStore`; provider API keys и секретные части baseline хранятся в credentials, а не дублируются в cloud |
| `<data>/atomic-core/credentials.json` (0600) | `{version, providers:{<id>:{api_key, updated_at}}}` | `CredentialStore` |
| `<data>/atomic-chatgpt-auth.json` (0600, v1) | как в приложении, без изменений | `credentials.chatgpt` |
| `<data>/local-api-server.json` | `{running, host, port, prefix, requires_api_key, pid}` — схема и значения как `state_file.rs`; ключ не пишется | владелец публичного API приложения; передача writer на этапе 4 |
| `<data>/atomic-core/optimal-backend.json` | `{<p>: OptimalBackendCacheRecord}` | `BackendService` |
| `<data>/atomic-core/instance.lock` | `{pid, process_start_id, instance_id, protocol, version, control_port}`; канонический путь папки данных определяет область блокировки | `lock/` |
| `<data>/atomic-core/control-token` (0600) | токен управляющего API | владелец |
| `<data>/atomic-core/processes.json` | журнал дочерних backend-процессов: `instance_id`, PID, идентичность запуска процесса, exe, provider, model, port | владелец; используется только после проверки идентичности процессов |
| `<data>/atomic-core/logs/core.log` | ротация 5 × 10 MiB | logger |

**Владелец и клиенты.** На каноническую папку данных — один процесс ядра. Приложение и CLI сначала проверяют владельца
и версию протокола, затем attach; при отсутствии владельца запускают `daemon --control-port 0` и повторяют attach.
`AtomicCore.create({role:'auto'})` имеет те же правила; `role:'owner'` при занятой папке возвращает `CORE_ALREADY_RUNNING`.
Lock приобретается эксклюзивно; PID без идентичности запуска недостаточен из-за повторного использования PID. После
эксклюзивного создания lock владелец публикует endpoint атомарно; клиент ждёт завершения handshake. Восстановление stale lock
тоже сериализуется: два стартующих клиента не могут одновременно заменить владельца. Недоступный HTTP при живом процессе
не разрешает снимать lock или запускать второе ядро. Конкретный межпроцессный механизм проверяется на трёх ОС до этапа 2.

Владелец держит управление, свои сессии и загрузки; публичный сервер включается отдельно. Выход приложения, EOF stdin
или завершение CLI-клиента не останавливают ядро. `server stop` выключает только публичный listener; `shutdown` — явная
остановка всего ядра со всеми сессиями, с проверкой других активных клиентов и отдельным `force` для принудительной остановки.
Клиенты регистрируются с heartbeat и сроком действия; закрытие клиента снимает регистрацию, но не выгружает его модели.
В v1 нет автоматического idle-shutdown. `--standalone` допустим только с явно указанной отдельной папкой данных.
При несовместимой версии живого владельца — понятный отказ, без второго ядра или автоматического убийства; обновление
бинаря требует явного остановленного владельца (на Windows нельзя заменять исполняемый файл работающего процесса).

**Совместное существование с legacy.** До полного переезда Rust-плагины не считаются участниками core lock.
В приложении до поставки CLI вводится общий межпроцессный guard для legacy runtime и изменений общих моделей/бэкендов.
Core-клиент не запускает и не меняет ресурс, пока им владеет legacy; переход владельца требует завершения операций и выгрузки.
Корни моделей двух llama.cpp общие: защита удаления/импорта действует на общий путь, а не только на provider id.
Версии приложения без этого guard не поддерживают одновременную работу с новым CLI на той же папке; при обнаружении
такого приложения CLI отклоняет изменяющие операции. Downgrade выполняется после явной остановки ядра.
Reaper сначала проверяет живого владельца и журнал, исключает его процессы и только потом чистит подтверждённых сирот.

**Миграция настроек — до первого core-load.** Импорт версионирован и выполняется отдельно для каждого provider и для
server/cloud; переключатель runtime не включается, пока его импорт не подтверждён. На legacy-этапе источник истины —
`localStorage`, после передачи ресурса ядру — файл ядра. `settings.json` хранит монотонную ревизию и для каждой области
миграции базовый snapshot, хеш импортированного legacy-состояния и последнюю подтверждённую ревизию его зеркала.
API принимает `expected_revision`, применяет запись атомарно и возвращает конфликт при устаревшей ревизии.

Приложение зеркалит подтверждённые изменения ядра в `localStorage` и подтверждает ревизию; на подключении получает
полный snapshot, поэтому изменения CLI при закрытом приложении не теряются. Одинаковый повтор импорта возвращает прежний
результат, а не безусловный `ALREADY_MIGRATED`. Если legacy-копия изменилась со времени подтверждения, выполняется сравнение
с базовым snapshot: односторонние/непересекающиеся правки объединяются, конфликт одного поля требует выбора пользователя
до переключения этой области. Автоматический выбор по времени файла запрещён.

Перед плановым откатом приложение подтверждает актуальность legacy-зеркала и передаёт владение обратно. Откат без этого
шага не обещает свежие настройки в старом UI; новое ядро сохраняет свои данные и разрешает расхождения при следующем запуске.
До этапа 6 ничего не удаляется; одного флага `migrated` недостаточно для очистки. `model-provider` содержит также каталог
моделей и состояние UI: удаляются только перенесённые поля после проверки всех оставшихся читателей, не весь zustand-store.

### 3.5 События

Внутри — типизированный `EventEmitter`. Каталог (`src/contracts/events.ts`):

| Группа | События |
| --- | --- |
| download | `download:started`, `download:progress` (каждые 10 MiB), `download:error`, `download:stopped`, `download:verified` |
| model | `model:validation-started`, `model:validation-failed`, `model:imported` |
| backend | `backend:download-started`, `backend:download-finished`, `backend:manual-downloading`, `backend:manual-failed`, `backend:better-detected`, `backend:runtime-reported` |
| session | `session:started`, `session:died`, `session:ctx-increased`, `session:unloaded` |
| прочее | `settings:changed`, `server:started`, `server:stopped`, `server:bind-failed`, `api:request`, `core:log` |

Через границу процесса: единственный канал событий — `GET /atomic/v1/events` (SSE, `id: <instance_id>:<seq>`, replay из кольца на 1000).
`GET /atomic/v1/snapshot` возвращает сессии, загрузки, ревизии настроек и состояние публичного сервера вместе с согласованным
cursor. Клиент применяет snapshot и подписывается после cursor; при переполнении кольца или другом `instance_id` сервер
требует resync. Дубликаты событий отбрасываются по id. В stdout — только ready-line при запуске; логи — stderr/файл.
Rust-мост переизлучает как Tauri-события `atomic-core://<name>`; `CoreEventBridge` в web-app маппит на 17 legacy-имён
(`onFileDownloadUpdate`, `onBetterBackendDetected`, `download-<taskId>`, …), существующие слушатели не меняются.

### 3.6 Протокол локального владельца

| Фаза | Механика |
| --- | --- |
| Spawn/attach | поиск совместимого владельца; иначе `atomic-chat-core daemon --data-folder … --resources-dir … --control-port 0`; самостоятельный процесс без `kill_on_drop`, без зависимости от parent PID/EOF; Windows `CREATE_NO_WINDOW`. Токен создаёт владелец под lock; клиенты читают защищённый файл |
| Готовность | первая stdout-строка `{event:"core:ready", pid, instance_id, protocol, version, control_host, control_port}` и авторизованный health-check ≤ 15 с; ready означает готовность управления, не модели или публичного API. После bootstrap pipes закрываются/отсоединяются без остановки ядра |
| Работа | snapshot + SSE; Rust ставит `AppState.local_server_endpoint` только из состояния реально работающего публичного сервера, включая фактические host/port/prefix. Control port никогда не подставляется как inference endpoint |
| Crash | клиенты сразу инвалидируют зеркало умершего `instance_id`; ошибки текущих запросов явные. Перезапуск через общий lock с backoff 1/5/15 с (≤ 3 за 5 мин); только один клиент становится launcher. Неудачный bootstrap можно завершить только после подтверждения идентичности запущенного процесса |
| Восстановление | новый владелец завершает подтверждённые сироты по журналу, затем публикует новый `instance_id`; сессии автоматически не восстанавливаются, snapshot пуст для умерших сессий. Загрузки становятся interrupted и возобновляются явно из проверенных `.tmp/.url`; автоповтор генерации запрещён |
| Выход клиента | detach и прекращение heartbeat; ядро и модели продолжают работать. Приложение при следующем запуске attach, не reap живого владельца |
| Shutdown | `POST /atomic/v1/shutdown` проверяет других клиентов, блокирует новые операции, завершает загрузки и backend-процессы, выключает оба listener, освобождает lock последним. Аварийное завершение — отдельное явное действие с проверкой PID/start identity |

Auth: `/v1/*` — как сегодня (`Bearer`/`X-Api-Key`, trusted hosts, CORS). `/atomic/v1/*` — всегда `Bearer <control_token>`,
отдельный bind только на loopback, проверка Host и peer; доступ из браузера по CORS выключен. Webview вызывает
Rust `atomic_core_call`/relay, поэтому control token не попадает в JS и dev-origin не требует исключений. CLI использует HTTP
напрямую. `client/` остаётся browser-safe, но принимает транспорт: fetch для headless-клиентов или injected invoke для Tauri.
Права файлов проверяются на каждой ОС: `0600` на Unix, доступ текущему пользователю через ACL на Windows.

Маршруты управления: `health`, `snapshot`, `events`, `clients/*`, `shutdown`, `server/*`, `models/*`, `sessions/*`, `models/:p/:id/{load,unload,capabilities,speculative/ensure}`,
`gguf/{validate,support}`, `tokens/count`, `embed`, `backends/:p/*`, `hardware/{info,usage,devices,override}`, `settings/{:p,server}`,
`cloud/providers/*`, `auth/chatgpt/*`, `downloads/*`, `transcription/*`, `migrate/legacy-storage`.
Ошибки — `{error:{code,message,details?}}`; клиент бросает `AtomicCoreError`, обработка в приложении не меняется.

### 3.7 Runtime-агностичность (gate в CI)

`types:["node"]`; eslint: `no-restricted-globals: Bun`, `no-restricted-imports: bun, bun:*`, бареные builtins без `node:` запрещены,
`node:*` запрещён в `contracts/` и `client/`; `scripts/check-runtime-agnostic.mjs` грепает `src/`; unit/contract на Node,
`test:e2e` на скомпилированном Bun-бинаре на трёх ОС; `test/runtime-compat/*` под `vitest` и `bun test`.

---

## 4. Этапы

Флаги: `ATOMIC_CORE_CMD` (dev: запуск ядра из исходников), `atomic_core.runtime` в `<data>/store.json` (`off | llamacpp-upstream | all`),
`atomic_core.server` (`legacy | core`), env-оверрайды `ATOMIC_CORE_RUNTIME`, `ATOMIC_CORE_SERVER`. Rust читает оба в `AppState`,
отдаёт webview командой `get_atomic_core_flags`.

Переключение runtime — передача владения после завершения операций, выгрузки соответствующих сессий и синхронизации
настроек; не горячая замена селектора поверх работающей модели. Допустимые сочетания: `server=legacy` при любом runtime;
`server=core` только при runtime `llamacpp-upstream|all` и рабочем мосте всех оставшихся legacy-провайдеров. Иное отклоняется
до изменения состояния. Для mobile всегда остаётся legacy-путь. `ATOMIC_CORE_CMD` задаёт launcher (`node/bun …/main.ts`),
без подкоманды: приложение добавляет `daemon` и аргументы ровно один раз.

### Этап 0 — Библиотека без потребителей + контрактные фикстуры

| | |
| --- | --- |
| Цель | политика и механика в ядре как чистый Node-API TypeScript; контракты пинятся фикстурами из Rust |
| Ядро | каркас (§3.1), `AGENTS.md`, `docs/*`; `config/`, `events/`, `runtime/process.ts`, `runtime/llamacpp/{args,errors,runtime-device,devices,probe,load-plan}`, `models/{model-yml,gguf}`, `downloads/`, `backend/`, `speculative/`, `settings/` |
| Приложение | только тесты: `#[ignore]` fixture-emitters в `tauri-plugin-llamacpp-upstream/src/{args,error,runtime_device,device}.rs` и `core/server/{responses_shim,chat_to_responses_shim,state_file}.rs` → `tests/fixtures/core-contracts/`; `tests/core-contracts.test.mjs` (checksum); ADR #1–#3 |
| Не трогаем | `web-app/`, `extensions/`, Rust runtime, Makefile, CI |
| Выход | `npm run verify` зелёный; `test/contract` воспроизводит каждую фикстуру по правилам §5.1; в приложении `make verify` зелёный. E2E пока проверяет каркас бинаря; сценарии следующих этапов отмечены Missing, не считаются пройденными через skip |
| Откат | удалить emitters |

### Этап 1 — CLI, управление и единственный владелец (ещё без поставки)

| | |
| --- | --- |
| Цель | TS-CLI воспроизводит `jan-cli serve`, `models list`, `server status`; два core-клиента используют одного владельца |
| Ядро | `cli/`, `runtime/llamacpp/runtime.ts`, `models/registry`, `hf.ts`, `lock/`, `daemon`, минимальный control API (`health/snapshot/events/clients/server/sessions/shutdown`), отдельный публичный listener с локальным форвардингом; `build:bin` на 4 triple; `test/live` (`ATOMIC_LIVE_UPSTREAM_BIN`, `ATOMIC_LIVE_UPSTREAM_MODEL`); Windows CI с маленьким GGUF |
| Приложение | ничего |
| Выход | argv эквивалентны при одинаковых входах с нормализацией динамических значений (§5.1); сохраняются CLI default `:6767`, флаги и выходные коды, public default приложения остаётся `:1337`. `serve` подключается к владельцу; несовместимая конфигурация уже работающего listener даёт явный конфликт. `/v1/models`, SSE/cancel проходят на обоих; гонка двух launcher, stale lock/PID reuse, stop/start публичного API без потери control, resync, crash-cleanup и явный shutdown без сирот проверены на трёх ОС. `Ctrl+C` клиента делает detach, это намеренное отличие от Rust CLI, отражённое в help и тесте |
| Откат | не поставляется |

### Этап 2 — Скомпилированное ядро становится `jan-cli` в бандле

| | |
| --- | --- |
| Цель | доказать упаковку и безопасное совместное существование CLI с приложением до поставки |
| Ядро | релиз-ассеты `atomic-chat-core-<ver>-<triple>` + `SHA256SUMS`; подкоманда `launch` (порт `configure_*` с golden-фикстурами из Rust-тестов `core/system/commands.rs`), `launch --list --json` |
| Приложение | `scripts/download-core.mjs` (по образцу `download-bin.mjs`, sha256, `lipo`); `package.json`: `atomicCore.version`, `download:core`, `build:tauri:*` и `dev:tauri` получают `yarn download:core`; `Makefile`: `download-core`, `build-cli` = копия `atomic-chat-core → jan-cli[.exe]` + codesign с `Entitlements.sidecar.plist` (`allow-jit`, `allow-unsigned-executable-memory`), `CLI_IMPL ?= core`; `stub-resources`; `release.yml` (~297, ~537/651, ~924/985): `yarn download:core`; `tauri.{macos,windows,linux}.conf.json` `bundle.resources` += `resources/bin/atomic-chat-core[.exe]`; ADR #4–#7 |
| Координация приложения | до смены `CLI_IMPL`: общий guard legacy/core (§3.4), reaper с проверкой живого владельца и идентичности процессов. CLI отказывает в изменении legacy-ресурсов при конфликте, приложение не убивает core/его backend. CLI не перезаписывает `local-api-server.json`, пока файл принадлежит legacy-серверу приложения: для него остаётся discovery-файл ядра; передача writer — этап 4 |
| Не трогаем | `install_jan_cli_sync`, `cli` Cargo-feature (собирается в одном CI-job как доказательство отката), Launch page |
| Выход | universal Mach-O реально запускается на arm64 и x64; подпись, JIT-entitlements и notarization проверены на конечном артефакте. Settings → Install CLI → `atomic-chat-cli --version` = версия ядра; `serve` и `launch <agent>` работают; `tests/cli-launch-catalog.test.mjs` сверяет каталог. Сценарии CLI → app и app → CLI не убивают процессы и не создают двойной load; конфликт legacy возвращается до мутации. Занятый live-бинарь при обновлении, несовместимая версия и отдельный `--standalone` проверены |
| Откат | `make build-cli CLI_IMPL=rust` |

### Этап 3 — Приложение подключается к ядру; локальный runtime переезжает

**3a. Подключение приложения к владельцу (до передачи runtime).**

| | |
| --- | --- |
| Ядро | полный протокол attach, snapshot/SSE, heartbeat и управление жизненным циклом из §3.4–3.6 |
| Приложение | Rust-модуль `src-tauri/src/core/atomic_core/{mod,supervisor,client,commands}.rs`: attach или запуск (`ATOMIC_CORE_CMD` → bundled binary), backoff под общим lock, handshake версии против `ATOMIC_CORE_VERSION` из `build.rs`, `atomic_core_call`, `get/set_atomic_core_flags`, SSE relay; reaper уже учитывает владение с этапа 2. Webview control-токен не получает; `process_env.rs` к ядру не применяется |
| Выход (пересмотр 2026-09-17) | `make verify` с supervisor-тестами (fake core); смерть app-core → инвалидирование snapshot → один рестарт; full exit выгружает модели app-core, force-quit приводит к остановке после истечения регистрации, независимый CLI-core сохраняет свои модели. Следующий запуск приложения останавливает app-core прежней версии только при доказанной identity, но никогда не подключается к ней как к совместимой. Пропуск >1000 событий и перезапуск seq требуют resync. `ATOMIC_CORE_CMD="bun run ../atomic-chat-core/src/app-daemon.ts" yarn dev` работает |
| Откат | флаг `off` по умолчанию |

**3b. Сессии `llamacpp-upstream` во владении ядра** (`atomic_core.runtime=llamacpp-upstream`).

| | |
| --- | --- |
| Ядро | `load/unload/sessions/findSession/autoIncreaseCtx`, события `session:*`, импорт upstream-настроек с ревизиями и подтверждённым legacy-зеркалом; hardware override до выбора backend/load |
| Приложение | (1) расширение upstream → Legacy/AtomicCoreLlamacppAdapter после передачи владения; старый код в `src/legacy/`, адаптер в `src/adapter/`; тот же package name, `settings.json`, события, listener `auto_increase_ctx`. (2) `AppState.core_sessions` строится из snapshot + SSE; единый resolver для агента и всех proxy-путей: chat, models, metrics, embeddings, Responses, ctx retry. Инвентаризация всех прямых обращений к картам плагинов обязательна. (3) `model-factory` получает сессию через адаптер. (4) `onLoad()` завершает импорт и hardware override до первого core-load |
| Выход | локальный чат, агент, Codex, `/models`, `/metrics`, embeddings, auto-ctx и unload при core/legacy; смерть ядра не оставляет старые порты в resolver. Изменённые legacy-настройки действуют уже на первом load; CLI-изменения и возврат на старую версию проходят сценарии §3.4. `make verify` зелёный; `SessionInfo` совместим |
| Откат | флаг `off`; legacy-код остаётся в пакете |

**3c. Бэкенды и загрузки через ядро.**

| | |
| --- | --- |
| Ядро | методы фактической поверхности `useBackendUpdater`, `download:*` с именем `download-<task_id>` каждые 10 MiB, теги `[disk_*]` |
| Приложение | адаптер реализует методы с теми же именами; relay маппит события 1:1; слушатели (`DownloadManegement`, `DataProvider`, `GlobalEventHandler`, `useBackendUpdater`) не меняются; optimal-cache зеркалится с ревизией и восстановлением из snapshot |
| Выход | install/update/«Find optimal backend» из UI; прогресс-бар; `tests/upstream-backend-resolver.test.mjs` зелёный; фикстура последовательности событий загрузки |
| Откат | флаг `off` |

**3d. Остальные off-contract методы; включение upstream по умолчанию.**

| | |
| --- | --- |
| Ядро | `settings.{get,set,import,status}`, `hardware.devices`, `models.maxCtxTrain`, `gguf.{validate,mmprojExists,isSupported}`, `speculative.check*`, `embed` |
| Приложение | импорт и зеркало с этапа 3b; `store.json` default `llamacpp-upstream` только после готовности всех его методов; `tests/extension-surface.test.mjs` сверяет фактические call-sites, `tests/pre-install-tarballs.test.mjs` проверяет legacy-имена пакетов; адаптер **не** отдельный тарбол — два пакета на один provider гонялись бы в `EngineManager` |
| Выход | `make verify`, `make test-extensions` (legacy + adapter), `make test-live`; upgrade/downgrade round-trip настройки |
| Откат | флаг `off` |

### Этап 4 — Сервер `:1337` и облако (`atomic_core.server=core`)

| | |
| --- | --- |
| Ядро | публичный сервер с этапа 1 расширяется до всех маршрутов, гейтов, CORS, шимов, Anthropic-фолбэка и ctx retry; `router/`, `cloud/`, `credentials/`, state-file writer, события `api:request`; импорт server/cloud до передачи владения |
| Приложение | Rust `start_server/stop_server/get_server_status` — единый переключатель legacy/core публичного API. Передача сериализована: остановить прежнего writer/listener, запустить нового, опубликовать фактический endpoint; при ошибке вернуть прежнего владельца или явное stopped-состояние. Control listener работает всё время. `register_provider_config` зеркалит подтверждённые ревизии; OAuth callback/refresh имеет одного writer. `api_request_analytics.rs`/`request_inspector.rs` получают `api:request`. **Все** ещё Rust-owned сессии (`llamacpp` TurboQuant, MLX, FM) регистрируются через snapshot/update/unregister с owner-generation и heartbeat; истёкшая регистрация удаляется, ядро не убивает чужие PID. Для них auto-ctx проксируется владельцу через запрос с id/timeout; для core-сессий вызывается runtime. При detach приложения legacy-сессии выгружаются и снимаются с регистрации |
| Выход | Codex, Claude Code, OpenCode; `make test-live-cloud`, кассеты; login/refresh ChatGPT и обратная передача auth; `server status` читает файл владельца; API-страница показывает запросы. TurboQuant/MLX работают через новый сервер до переезда runtime; FM проверяется по поддерживаемым возможностям отдельно, без обещания отсутствующего legacy-паритета. Stop/start/change-port публичного API не отключают управление. Проверены сбой передачи, занятый порт с публикацией фактического endpoint и недопустимые флаги; OpenAPI сравнивается после нормализации (§5.1); `make verify` |
| Откат | `atomic_core.server=legacy` |

### Этап 5 — TurboQuant, MLX, Foundation Models (desktop)

| | |
| --- | --- |
| Ядро | провайдер `llamacpp` (`turbo*` разрешены только здесь; `<data>/llamacpp/backends`, `/lib`, cudart-companion); `runtime/mlx`; `runtime/foundation-models`; standalone CLI явно требует совместимые MLX/FM-ресурсы через `--resources-dir` либо отдельную спецификацию их доставки |
| Приложение | селектор в `extensions/{llamacpp,mlx,foundation-models}-extension`; перенос настроек каждой области до load; `atomic_core.runtime=all`; убрать регистрацию внешних desktop-сессий после передачи всех провайдеров |
| Выход | матрица 3b–3d на провайдер; `ATOMIC_LIVE_TURBOQUANT_*`, `ATOMIC_LIVE_MLX_*`, FM-smoke на macOS 26; «приложение + `atomic-chat-cli serve` одна модель» → один процесс |
| Откат | согласованная передача всех runtime обратно в `llamacpp-upstream` или `off`; текущий enum не обещает отдельного флага для каждого провайдера |

### Этап 6 — Удаление и дедупликация

| | |
| --- | --- |
| Приложение | удалить только desktop-вызовы старых плагинов/прокси/CLI и неиспользуемый код; сохранить Rust-модули, регистрации, extension legacy и зависимости, нужные iOS/Android. Hardware остаётся. До удаления `localStorage` проверить подтверждённые ревизии, отсутствие оставшихся читателей и окончание окна отката; удалять только перенесённые поля. `engine-settings-defaults` → contracts. Удаление bundled `jan-cli` допускается отдельным ADR после проверки installer upgrade/downgrade и desktop/mobile путей; обновить coverage/allowlist и инструкции приложения |
| Выход | `make verify`; анализ импортов не находит legacy в desktop-пути, mobile-сборки и их существующие контракты проходят. Измерить размер итоговых бандлов, не предполагать дельту «+1 бинарь». Проверены установка и обновление CLI |
| Откат | до очистки legacy-данных — обратная передача владения; после очистки простой revert не считается безопасным, нужен экспорт совместимого snapshot и отдельная проверка восстановления |

---

## 5. Верификация

### 5.1 Слои тестов

| Слой | Где | Что проверяет | Запуск | Порог |
| --- | --- | --- | --- | --- |
| Unit | `src/**/*.test.ts` | каждая чистая функция таблицами: 32 правила `args`, каскад ошибок, парсеры устройств и runtime-device, GGUF, KV-оценка, роутер, шимы, миграция настроек, `parseBackendVersion`, `extra_args`-сплиттер, lock | `npm run test`, каждый PR, < 30 с | coverage floor per-file, только вверх |
| Contract | `test/contract/` + `test/fixtures/` | совместимость argv, `{code,message}`, готовности, устройств, YAML/JSON, событий и шимов по правилам ниже | `npm run test`; фикстуры из Rust, checksum и исходный commit в обоих репо | все заявленные контракты; изменение значимого поведения = ADR |
| E2E (бинарь) | `test/e2e/` | `daemon --control-port 0`, отдельный public port, fake-backend load/unload/died/timeout, SSE/snapshot/resync, два клиента и гонка launcher, PID reuse, interrupted download, shutdown, миграция с конфликтами | `npm run test:e2e` на macOS/Windows/Linux; набор нарастает по этапам | выход этапа запрещён при Missing/skip обязательного сценария; Windows обязателен |
| App-E2E | `test/app-e2e/` + `tests/core-*.test.mjs` в приложении | (1) ядро против реальной папки данных: `models list` == `list()` расширения; (2) argv-паритет `jan-cli serve` vs ядро; (3) `yarn tauri dev` с `ATOMIC_CORE_CMD` + Tauri-e2e: загрузка через UI → `/atomic/v1/sessions` совпадает с тем, что видит `model-factory`; auto-increase-ctx; backend install; флаг туда-обратно без потери настроек; (4) Codex/Claude Code/OpenCode против `:1337` | `make test-app-e2e` в приложении, nightly + перед релизом | критерии выхода этапов §4 |
| Live | `test/live/` | реальный бэкенд-download, реальный `llama-server` с ~20 MB GGUF, embed/tokenize, `ATOMIC_CLOUD_*` с кассетами | `ATOMIC_LIVE=1`, nightly | skip без env, `--require` в CI |
| Runtime-compat | `test/runtime-compat/` | спавн+SIGTERM+коды выхода, `windowsHide`, 8.3-пути, порт-проба, SSE, `fetch` Range, `fs.open` mode | `vitest` (Node) **и** `bun test`, 3 ОС | grade Strong до этапа 3b |

**Что сравниваем.** Точные значения обязательны для кодов ошибок, disk-тегов, имён событий, provider id и значимых
аргументов backend. В argv сохраняется порядок флагов; временные корни/случайные порты нормализуются по явным placeholder,
не удалением аргумента целиком. PID, время и случайные токены проверяются по форме и связям между запросами. YAML/JSON
сравниваются по схеме, значениям, defaults и сохранению неизвестных полей при read/write; порядок ключей и whitespace
не контракт без конкретного читателя, который от них зависит. OpenAPI — структура после нормализации адреса/метаданных.
SSE — порядок и содержимое значимых событий, завершение, cancel, backpressure, разрывы; не размеры сетевых чанков.
Каждая фикстура указывает источник и comparator; нормализация не может скрывать смену модели, provider, auth или флага.
Исправление Windows PATH и detach при Ctrl+C — явные разрешённые отличия с отдельными тестами, не «паритет».

Проверки изолированных владельцев включают оба порядка запуска app/CLI, выход одного ядра при работающем другом,
несовместимую версию, crash между spawn и записью журнала, восстановление stale lock двумя клиентами, отказ reaper убивать
живого владельца, смену server host/port и downgrade после CLI-изменений. Fault injection доказывает отсутствие
двойного владельца и утечки backend-процесса; зелёного unit-теста lock недостаточно.

Хелперы: `test/helpers/fake-llama-server.ts` (реальные строки `listening on`, `load_backend: loaded CUDA backend`, `offloaded 33/33 layers to GPU`;
`/health`, `/props`, `/apply-template`, `/tokenize`, `/v1/chat/completions` SSE; падение с кодом/сигналом, зависание),
`fixture-http-server.ts` (Range/206/416, sha256, обрывы), `tmp-data-folder.ts` (раскладка `<data>/llamacpp/models/...`).

### 5.2 Матрица по этапам

| Этап | Ядро | Приложение (остаётся зелёным) | Живые проверки |
| --- | --- | --- | --- |
| 0 | `npm run verify`; `test/contract` | `make verify` | — |
| 1 | + `ATOMIC_LIVE_UPSTREAM_*`, control/lifecycle/attach; CI на 3 ОС | без изменений | нормализованный argv; SSE/cancel; два клиента, crash, shutdown |
| 2 | release → 4 ассета + sums | guard/reaper, `make verify`, `make build-cli`, нотаризованный `build:tauri:darwin`, `make test` | Install CLI → `serve`, `launch codex`; оба порядка запуска app/CLI; arm64/x64 launch |
| 3a–3d | RPC/handshake/download/settings тесты | `make verify`, `make test-extensions`, `make test-agent`, `make test-hardening-contracts`, `make test-live` | локальный чат, агент, Codex, auto-ctx, backend install, upgrade/downgrade настроек |
| 4 | маршруты по `tests/fixtures/proxy`, кассеты live-cloud, шимы | `make verify`, `make test-rust`, `make test-live-cloud` | Codex, Claude Code, OpenCode, ChatGPT-подписка, `server status` |
| 5 | runtime-тесты провайдеров; attach уже с этапа 1 | `make verify`, live per provider | один процесс на модель, передача каждого провайдера |
| 6 | — | `make verify`, анализ desktop/mobile импортов и mobile build checks, размер бандла | полный smoke на 3 desktop ОС; существующие mobile-контракты |

Конвенции копируются из приложения: `define`-стабы, `coverage-floor.json` + `check-coverage-floor.mjs`, `check-test-quality.mjs`,
evidence-grades (`docs/testing-critical-flows.md`), live-cloud контракт `ATOMIC_CLOUD_PROVIDERS` + `ATOMIC_CLOUD_<NAME>_{BASE_URL,API_KEY,MODEL,_STYLE,_TOOLS}`.

---

## 6. Риски

| # | Риск | Митигация | Закрывается |
| --- | --- | --- | --- |
| 1 | Остановка публичного API отключает управление; двойной public bind | раздельные listener с этапа 1; сериализованная передача публичного writer и восстановление при ошибке | 1, 4 |
| 2 | Windows spawn/завершение дерева/не-ASCII пути/CUDA PATH под Bun | `windowsHide`, проверенная остановка потомков и идентичность PID, 8.3 где доступно, PATH prepend; реальные Windows e2e. Node SEA не считается митигацией до собственного spike упаковки/сигналов/подписи | 1, 2 |
| 3 | Потеря настроек при CLI-записи и downgrade | ревизии, базовый snapshot, подтверждённое legacy-зеркало, конфликт полей до переключения; очистка только после окна отката | 3b, 4, 5, 6 |
| 4 | Universal Bun-бинарь не запускается или не проходит notarization | запуск конечного signed artifact на arm64/x64 и notarization; наличие entitlements само по себе не доказательство | 2 |
| 5 | Имена `pre-install` тарболов / ожидания инсталлера | имя пакета не меняется; `pre-install-tarballs.test.mjs` | 3d |
| 6 | Координация auto-increase-ctx агента | 3b: адаптер отвечает на Tauri-лестницу; 4: агент зовёт ядро и перерезолвит через зеркало | 3b, 4 |
| 7 | Две модели или reaper убивает живой CLI | lock + attach с этапа 1; общий legacy guard и owner-aware reaper до поставки; standalone только на отдельной папке | 1, 2 |
| 8 | Рассинхрон версий / замена работающего бинаря | pin + handshake, отказ при mismatch; явная остановка владельца перед обновлением, Windows-проверка | 2, 3a |
| 9 | Дрейф имён/каденса событий | relay 1:1; фикстуры последовательностей | 3c |
| 10 | Точность железа без NVML (CUDA-тир на Windows) | override до первого load; fixtures обоих путей. Без override только доказанный тир и безопасный fallback | 1, 3b |
| 11 | После рестарта зеркало содержит мёртвые порты или пропущены события | instance id + snapshot/cursor/resync, очистка сирот до ready; текущие запросы завершаются ошибкой | 1, 3a, 3b |
| 12 | Потеря mobile при удалении legacy | desktop-only scope, сохранение необходимых модулей и отдельные mobile build checks | 6 |
| 13 | Требования прокси загрузок не помещаются в текущую абстракцию fetch | до завершения этапа 0 прототип per-item HTTP/HTTPS/SOCKS, no_proxy и TLS policy на обоих рантаймах; выбор реализации/зависимости через ADR и отдельное согласование, поддержка не вычёркивается молча | 0 |

---

## 7. ADR в `docs/decisions/` приложения

1. Ядро инференса выделяется в отдельный TS-репозиторий `atomic-chat-core` (Bun-бинарь, Node-совместимый API).
2. Порядок миграции: runtime/control/владение → CLI с legacy guard → адаптер → публичный сервер; desktop legacy удаляется последним, mobile сохраняется.
3. Wire-контракты пинятся фикстурами Rust с явными comparator и нормализацией динамических полей.
4. Два ресурса `resources/bin/atomic-chat-app-core` и `atomic-chat-core` из одной версии, независимые app/CLI-владельцы; раздельные control/public listener, SSE + snapshot, bootstrap по stdout.
5. Имя файла `jan-cli` сохраняется; содержимое — копия скомпилированного `atomic-chat-core`.
6. Бинарь владельца подписывается с hardened runtime и JIT-entitlements на macOS; конечный universal artifact запускается на обеих архитектурах.
7. Точная версия ядра пинится в приложении; mismatch протокола/версии отклоняется на handshake.
8. Reaper учитывает владельца и идентичность запуска; общий guard защищает legacy/core-ресурсы до поставки CLI.
9. Core-owned сессии зеркалятся в `AppState.core_sessions`; агент продолжает ходить к `llama-server` напрямую.
10. llama.cpp-расширения становятся тонкими адаптерами под legacy `@janhq/*` именами; legacy-код в пакете до удаления.
11. Настройки переезжают по областям до первого load с ревизиями, подтверждённым зеркалом и разрешением конфликтов при downgrade.
12. `start_server` в Rust координирует передачу публичного API и state-file writer; control API работает независимо.
13. Конфиги провайдеров и ключи — в ядре (`credentials.json` 0600); `register_provider_config` уходит.
14. Auto-increase-ctx схлопывается в ядро.
15. Телеметрия локального API-сервера остаётся в Rust и питается событиями `api:request`.
16. Железо: пробы в ядре, NVML/Vulkan-override из приложения.
17. CLI `serve` подключается только к CLI-владельцу; выход команды делает detach, остановка CLI-ядра явная. Полный выход приложения останавливает app-core.
18. `launch`-каталог CLI портируется на TS; Launch page остаётся на Rust `configure_*`.
19. Новая папка данных `<data>/atomic-core/`.

---

## 8. Порт-спека: факты из кода приложения

Ниже — поведение исходной реализации. Ссылки относятся к `../Atomic-Chat`; номера строк не заменяют проверку актуального
кода и commit фикстуры. Ядро сохраняет совместимое поведение с явными отличиями из §5.1; desktop-миграция не переносит mobile.

### 8.1 Контракт и данные

**Как приложение использует движок.**

- Приложение **не зовёт `AIEngine.chat()`**. `web-app/src/lib/model-factory.ts:604-680`: `startModel` → `engine.load()`,
  затем `invoke('plugin:…|find_session_by_model')` и стрим через AI SDK прямо на `http://localhost:<port>/v1` с `Bearer <api_key>`.
  Токены считает напрямую (`/apply-template`, `/tokenize`). Первичный контракт ядра: **`load() → {port, api_key, pid, model_id}`**.
- **Off-contract поверхность** — 13 файлов web-app зовут методы расширения мимо `AIEngine`:
  `hooks/useBackendUpdater.ts` (состав методов сверяется с актуальными call-sites), `services/models/default.ts` (`checkMmprojExists`, `isModelSupported`,
  `validateGgufFile`, `getTokensCount`), `routes/settings/providers/$providerName.tsx` (`check*MtpSupport`, `checkDflashSupport`),
  `services/hardware/tauri.ts` (`getDevices`), `lib/context-size.ts` и `hooks/useModelContextLength.ts` (`getMaxCtxTrain`),
  `lib/ensure-embeddings.ts` (`embed`), `containers/SetupBackendStep.tsx` (`recheckOptimalBackend`), `containers/MlxModelDownloadAction.tsx`,
  `containers/SetupScreen.tsx`, `lib/scanned-model-import.ts` (`import`), `containers/dialogs/DeleteProvider.tsx`,
  `services/providers/tauri.ts` (`getReasoningControls`).
- **Жёсткие импорты из дерева расширения**: `web-app/src/lib/engine-settings-defaults.ts:1-3`, `web-app/src/lib/utils.ts:169`
  (`LOCAL_LLAMACPP_EXTENSION_NAME = '@janhq/llamacpp-upstream-extension'`).
- Фронт переименовывает `ctx_len→ctx_size`, `ngl→n_gpu_layers` перед `load()` (`default.ts:699-705`); ядро принимает только канонические имена.

**Настройки.**

- Настройки провайдера **не на диске**: `core/src/browser/extension.ts:159,199` хранит массив настроек в `localStorage[<имя расширения>]`.
  `read_yaml`/`write_yaml` трогают только `model.yml`.
- Служебные ключи `localStorage`: `atomic_llamacpp_upstream_backend_type`, `llama_cpp_backend_type` (legacy), `atomic_llamacpp_upstream_optimal_backend_v1`,
  `llama_cpp_pending_backend`, `llama_cpp_better_backend_recommendation`, `llamacpp_kv_cache_migrated_v1`, `llamacpp_upstream_kv_cache_cleared_v1`,
  `llamacpp_kv_cache_migrated_turbo3_v2`, `llamacpp_fit_enabled_v2`, `llamacpp_fit_disabled_v1`, `cortex_models_migrated`, `setting-proxy-config`;
  у turboquant — аналоги с префиксом `atomic_llamacpp_turboquant_*` / `turboquant_*`; у MLX — только настройки.
- 34 ключа `settings.json` upstream: `version_backend, mtp, dflash, dflash_block_size, concurrent_mode, concurrent_slots, expose_metrics, parallel,
  cont_batching, llamacpp_env, reasoning_preserve, extra_args, timeout, fit, fit_target, fit_ctx, threads, threads_batch, ctx_shift, n_predict,
  ubatch_size, device, split_mode, main_gpu, flash_attn, no_mmap, mlock, cache_type_k, cache_type_v, defrag_thold, rope_scaling, rope_scale,
  rope_freq_base, rope_freq_scale`. Turboquant: 31 (минус `mtp`, `dflash`, `dflash_block_size`). MLX: 11.
- Per-model поля `LlamacppConfig`: `auto_unload, ctx_size, n_gpu_layers, chat_template, offload_mmproj, cpu_moe, n_cpu_moe, override_tensor_buffer_t,
  batch_size, no_kv_offload`, плюс вычисляемые `mtp_draft_path, dflash_draft_path, dflash_spec_supported, dflash_n_max`.

**Раскладка данных** (обязательна к сохранению).

```
<data>/llamacpp/models/<id>/{model.yml, model.gguf, mmproj.gguf, *.part, *.tmp, *.url}   # общая для обоих llama.cpp
<data>/llamacpp/backends/<version>/<backend>/build/bin/llama-server                     # turboquant
<data>/llamacpp/lib/                                                                     # turboquant, cudart
<data>/llamacpp-upstream/backends/<version>/<backend>/build/bin/llama-server            # upstream (fallback: без build/bin)
<data>/llamacpp-upstream/tmp/
<data>/mlx/models/<id>/{model.yml, config.json, *.safetensors, tokenizer*}
```

ID модели = путь относительно `models/`, `\`→`/`; обход DFS останавливается на первом `model.yml`.

**`model.yml`** (`guest-js/types.ts:142-171`): `model_path` (обяз.), `mmproj_path`, `name`, `size_bytes`, `model_sha256`, `model_size_bytes`,
`mmproj_sha256`, `mmproj_size_bytes`, `embedding`, `projector_vision`, `projector_audio`, `mtp_draft_path`, `dflash_draft_path`, `source`;
Rust добавляет `capabilities`.

**`load()` = 23 шага** (`index.ts:4489-5249`): auto-unload → merge настроек → резолв `latest/<backend>` → flash-attn по версии → AVX-preflight →
`ensureBackendReady` → `read_yaml` → порт + ключ + env (`LLAMA_API_KEY`, `LLAMA_ARG_TIMEOUT`, `llamacpp_env` как `KEY=VALUE;…`) → шарды и mmproj →
валидация размеров → chat-template override (Llama 3) → MTP-драфт (Gemma) → probe `-h` на dflash → DFlash-драфт → взаимоисключение (DFlash побеждает) →
`dflash_n_max = max(block-1, 1)` → clamp ctx по `ctx_train` → invoke → ретрай text-only при `MULTIMODAL_PROJECTOR_LOAD_FAILED` → ретрай без MTP →
`syncLoadedCtxSize` (`/props`) и `reportBackendMismatch`.

**События и слушатели.** `settingsChanged` → `GlobalEventHandler.tsx:95`; `onBetterBackendDetected`, `onManualBackendDownloading/Failed`,
`onBackendDownloadStarted/Finished` → `useBackendUpdater.ts`; `onBackendRuntimeReported` → `GlobalEventHandler.tsx:114`; `onModelImported` →
`DataProvider.tsx:491`, `PromptVisionModel.tsx`, `SetupScreen.tsx`; `OnAutoIncreasedCtxLen` → `DataProvider.tsx:588` (+ Tauri `AUTO_INCREASE_CTX_NOTIFY`);
`DownloadEvent.*` → `DownloadManegement.tsx:598-605`, `DownloadButton.tsx`, `MlxModelDownloadAction.tsx`; Tauri `MULTIMODAL_DISABLED_FALLBACK`.

### 8.2 Rust-механика (`src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/`)

**Spawn** (`commands.rs:66-381`). `backend_path` — полный путь к бинарю. `-m` и `--mmproj` валидируются; на Windows не-ASCII пути
переводятся в 8.3 (кроме шардов `*-NNNNN-of-NNNNN.gguf`). Env: `LD_LIBRARY_PATH` / `DYLD_LIBRARY_PATH` / `PATH` + `cwd` = каталог бинаря;
CUDA-каталоги (`utils/src/system.rs:150-340`): Linux — `CUDA_HOME|CUDA_PATH`, `/usr/local/cuda*`, `/opt/cuda`, `/usr/lib/x86_64-linux-gnu[/nvidia]`;
Windows — `CUDA_PATH\bin`, `CUDA_PATH_V*\bin`, `ProgramFiles\NVIDIA GPU Computing Toolkit\CUDA\*\bin`. `binary_requires_cuda` — `ldd` или скан байт.
Windows-флаги `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP`; `kill_on_drop`.

**Готовность.** Строка stdout/stderr, lowercased, содержит `listening on` | `all slots are idle` | `starting the main loop` | `http server listening`
**или** `GET /health` → 2xx (опрос 200 мс, таймаут запроса 500 мс). Ранний выход → классификация; тик 50 мс; таймаут → kill + `MODEL_LOAD_TIMED_OUT`.
Crash-watcher 500 мс → событие `local_backend://llamacpp_upstream_session_died` `{model_id, pid, error_code, message}` (`error_code` — Debug-имя варианта).

**SessionInfo.** `{pid, port, model_id, model_path, is_embedding, api_key, mmproj_path?, runtime_device?}`. `api_key` = base64(HMAC-SHA256(secret, model_id)),
секрет `'JustAskNow'` (`index.ts:531`), передаётся процессу как `LLAMA_API_KEY`. Порт — случайный 3000–3999 с bind-пробой.

**Unload.** SIGTERM → 5 с → SIGKILL (unix; при выходе приложения 2 с); `TerminateProcess` (Windows x64; на Windows ARM64 пути нет);
неизвестный pid → `{success: true}`.

**Ошибки** (`error.rs`). Формат `{code, message, details?}`. Каскад подстрок stderr **по порядку**:

| Подстроки (lowercased) | Код |
| --- | --- |
| `dyld` + `symbol not found` | `OS_VERSION_UNSUPPORTED` |
| `out of memory`, `failed to allocate`, `insufficient memory`, `erroroutofdevicememory`, `kiogpucommandbuffercallbackerroroutofmemory`, `cuda_error_out_of_memory` | `OUT_OF_MEMORY` |
| `error loading model architecture`, `unknown model architecture`, `error loading model hyperparameters`, `key not found in model` | `MODEL_ARCH_NOT_SUPPORTED` |
| `unknown projector type` | `MULTIMODAL_PROJECTOR_LOAD_FAILED` |
| `corrupted or incomplete`, `invalid magic`, `wrong number of tensors`, `unexpectedly reached end of file`, `failed to read tensor` | `MODEL_FILE_CORRUPT` |
| иначе | `LLAMA_CPP_PROCESS_ERROR` |

Крэш: Windows `0xC0000005 / 0xC00000FD / 0xC0000409`, сигналы 11 / 6 → текст «crashed unexpectedly … MTP». Пустой stderr → пробуем stdout.

**Args** (`args.rs:239-342`), порядок эмиссии:

1. `--no-webui` (не `ik*`); `--jinja`; `-m <path>`
2. `--cpu-moe`; `--n-cpu-moe N` (>0); `--override-tensor V` (непустой)
3. `--mmproj <path>` [+ `--no-mmproj-offload` если `!offload_mmproj`]
4. `-a <model_id>`; `--port N`; `--chat-template V`
5. `-ngl N` (`n_gpu_layers` ≥ 0 и ≠ 100, иначе `-1`)
6. `--threads` / `--threads-batch` (>0); `--batch-size` (≠ 2048); `--ubatch-size` (≠ 512)
7. `--device V`; `--split-mode V` (≠ `layer`); `--main-gpu N` (≠ 0)
8. flash-attn: `ik*` → bare `-fa` только при `on`; иначе string-форма `--flash-attn <auto|on|off>` при turboquant или build ≥ b6325; legacy — bare `--flash-attn` при `on`
9. `--context-shift`; `--cont-batching`; `--no-mmap`; `--mlock`; `--no-kv-offload`
10. `--parallel N` (>0) + `-kvu` при N == 1
11. MTP/DFlash: DFlash побеждает при обоих. Gemma (`mtp_draft_path`): `--model-draft P --spec-type draft-mtp --spec-draft-n-max 4` при build ≥ b9553.
    Qwen built-in: `--spec-type draft-mtp --spec-draft-n-max 2` при ≥ b9180. DFlash: `--model-draft P --spec-type draft-dflash --spec-draft-n-max <n_max|15>`
    только при `dflash_spec_supported` (probe `-h`).
12. `--metrics`
13. reasoning-preserve: `--reasoning-preserve` при `true` и ≥ b9837; `--no-reasoning-preserve` при `false` и ≥ b10762
14. embedding: `--embedding --pooling mean`; иначе `--ctx-size N` (только если `!fit`), `--n-predict N`, `--cache-type-k` (≠ f16),
    `--cache-type-v` (только при `flash_attn ≠ off`, ≠ f16/f32), `--defrag-thold` (≠ 0.1), rope (`--rope-scaling` ≠ none, `--rope-scale` ≠ 1,
    `--rope-freq-base` ≠ 0, `--rope-freq-scale` ≠ 1)
15. fit (не `ik*`): `--fit on|off` [+ `--fit-ctx` ≠ "4096", `--fit-target` ≠ "1024"]
16. `extra_args` — POSIX-сплиттер (кавычки, `\`-экранирование; незакрытая кавычка → вся строка отброшена), добавляется **последним**

Pre-pass: `concurrent_mode` → `parallel = max(slots, 2)`, `cont_batching = true`, `expose_metrics = true`; Vulkan → `flash_attn auto → off`.
Whitelist cache-типов `f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1`, иное → `q8_0`; **turboquant-провайдер разрешает `turbo*`**.
`version_backend` без `/` → `INVALID_ARGUMENT`. `parse_build_number("b10018-1.3.0") = 10018`. `is_turboquant` = префикс `turboquant-` или `b<d>-<d>.<d>.<d>`.

**Runtime device** (`runtime_device.rs`). Парсит `load_backend: loaded X backend`, `offloaded N/M layers to GPU`, `offloading N repeating layers`,
`<prefix>: LABEL model buffer size = V UNIT`; ошибки инициализации: `failed to initialize CUDA`, `no CUDA devices found`, `error while loading shared libraries`,
`failed to load backend`, `ggml_vulkan: No devices found`, `no usable GPU found`. `primary_device` = крупнейший не-CPU буфер, если offloaded ≠ 0.

**`--list-devices`** (`device.rs`). Секция после `Available devices:`; строка `ID: Name (… MiB, … MiB free)` — последняя скобка с `MiB` + `free` + `,`;
таймаут 30 с; `DeviceInfo {id, name, mem, free}` в MiB.

**GGUF** (`gguf/`). Только KV-блок метаданных (строки ≤ 1 MiB, массивы ≤ 24 stringified); таблица тензоров не читается — nextn/MTP-детект в TS `util.ts`.
KV-оценка по `{arch}.block_count`, `head_count_kv|head_count`, `key_length/value_length | embedding_length/head_count`, `context_length`, `sliding_window`;
биты: f32 32, f16/bf16 16, q8_0 8.5, q5_1 6, q5_0 5.5, q4_1 5, q4_0/iq4_nl 4.5, turbo4 4, turbo3 3, turbo2 2, иное 16.
`is_model_supported` → RED/YELLOW/GREEN; `RESERVE_BYTES = 2 288 490 189` на пул; integrated = `vulkan_info.device_type == "IntegratedGpu"`;
нет GPU → unified memory. HTTP-чтение чанками 2 MiB, кап 120 MiB.

**Downloads** (`core/downloads/`). `save_path` относительно папки данных и внутри неё. Сайдкары `.tmp` + `.url`; резюм только при `resume=true` и совпадении URL.
`Range` → 206 + проверка `Content-Range` (start, end < total, total == expected); 200/416 → рестарт с нуля; 408/429/5xx ретраятся;
5 ретраев со сбросом после каждого 1 MiB прогресса. Событие `download-<task_id>` `{transferred, total}` каждые 10 MiB (суммарно по задаче);
`onModelValidationStarted {modelId, downloadType: "Model"}`. sha256 + size после всех файлов; при провале удаление файла и **нерекурсивно** его папки.
Headroom 512 MiB; HEAD-preflight 30 с × 5; Windows path ≥ 260 → ошибка; прокси per-item (`http|https|socks4|socks5`, `no_proxy`, `ignore_ssl`); cancel ничего не удаляет.
Теги `[disk_full | disk_permission | disk_file_locked | disk_path_too_long | disk_device_lost | disk_io]` — контракт `web-app/src/lib/telemetry.ts`.

**Папка данных** (`core/app/commands.rs`). `data_dir()/<APP_NAME | "Atomic Chat">/data`; `settings.json` `{data_folder, autostart_preference}` ищется в
`config_dir/<pkg>` (Linux, если есть) → `data_dir/<pkg>`; legacy `Atomic-Chat` предпочитается `chat.atomic.app`, если существует.

**Архивы** (`core/filesystem/commands.rs:334-515`). Только `.tar.gz` и `.zip` (zip-slip guard, unix mode); `normalize_backend_layout` → `build/bin/<exe>`.

**MLX** (`tauri-plugin-mlx`). Бинарь `resources/bin/mlx-server`. Args: `--model <dir> --host 127.0.0.1 --port N`, `--max-kv-size`,
`--draft-model <dir> --draft-kind <dflash|mtp|eagle3> --draft-block-size`, `--kv-bits F --kv-quant-scheme S` при `uniform|turboquant`.
Env `MLX_VLM_SINGLE_MODEL=1`. Готовность только по логу: stdout — `uvicorn running on, application startup complete, http server listening,
server is listening, server started, ready to accept, server started and listening on`; stderr — `uvicorn running on, application startup complete,
server is listening, server listening on, server started and listening on`. Один load за раз. `api_key ""`; `model_path` = каталог.

**Foundation Models** (`tauri-plugin-foundation-models`). Бинарь `resources/bin/foundation-models-server`; args `--port N [--api-key K]`;
готовность по stdout `server is listening on` | `http server listening`; macOS 26+, Apple Silicon.

**Hardware** (`tauri-plugin-hardware`). `SystemInfo {cpu:{name, core_count, arch, extensions[]}, os_type, os_name, total_memory (MiB), gpus[]}`;
`GpuInfo {name, total_memory, vendor, uuid, driver_version, nvidia_info:{index, compute_capability}|null, vulkan_info:{index, device_type, api_version, device_id}|null}`;
`SystemUsage {cpu, used_memory, total_memory, gpus[{uuid, used_memory, total_memory}]}`. На macOS Vulkan пропущен → 0 GPU.
CUDA-тиры по драйверу: Linux `450.80.02 / 525.60.13 / 580`, Windows `452.39 / 551.61 / 581.15`; CUDA 13 требует compute capability ≥ 7.5;
Для `llamacpp-upstream` ROCm доступен только на Windows по PCI-таблице; Linux upstream — Vulkan → CPU.
Это не матрица форка: `llamacpp` на Linux выбирает CUDA 13.3 → CUDA 12.4 → ROCm → Vulkan → CPU по своему pinned release.
Проба железа не расширяет набор артефактов конкретного провайдера; правила уточняются по текущим resolver и ADR приложения.

**Ловушки.** (1) Windows: `PATH` с CUDA-каталогами перезаписывается `setup_library_path` — чинить (prepend). (2) `parse_backend_version("b10018-1.3.0") = 0` →
`verify_backend_binary` пропускает гейт для unified-тегов форка — воспроизводить до этапа 6.

**Уже TS, не Rust.** URL и манифест бэкендов, sha256/size из `atomic-chat-conf`, cudart-URL — `extensions/llamacpp-upstream-extension/src/backend.ts:442-939`;
дубль в `scripts/resolve-upstream-backend.mjs`. Переиспользовать, не переписывать.

### 8.3 Облако, прокси, агент, сайдкары

**Облачный чат из UI идёт через Rust-прокси.** `model-factory.ts:528-542` берёт `baseURL` локального API-сервера для всех облачных веток;
`openai` возвращает `openai.chat(id)` (не `/responses`); `chatgpt` через openai-compatible ветку. Напрямую по порту — только локальные сессии.

**Провайдеры.** Список грузится из реестра `atomic-chat-conf` (`services/provider-registry.ts`); в коде только `BASELINE_PROVIDERS`
(`constants/providers.ts:57-151`: `chatgpt` с `CHATGPT_BASE_URL = https://chatgpt.com/backend-api/codex`, `llamacpp-server`, `azure`).
`ProviderObject` (`types/modelProviders.d.ts:64-87`): `{active, provider, api_key?, base_url?, settings[], models[], custom_header?, supports_model_listing?}`.
Хранится в `localStorage['model-provider']`, zustand `persist` v15. `constants/models.ts:677-1102` — таблица возможностей.

**Зеркало в Rust.** `utils/registerRemoteProvider.ts:99-138` → `register_provider_config` в `AppState.provider_configs` (память).
Keyless: `ollama`, `llamacpp-server`, loopback `base_url`; подписочный: `chatgpt`. Call-sites: `DataProvider.tsx:62,72,101,194,301,334`,
`ensureRemoteProviderReady.ts:36` (из `custom-chat-transport.ts:932`).

**Листинг моделей** (`services/providers/tauri.ts:272-379`). `${base}/models`, fallback `${base}/v1/models` при 404; заголовки `x-api-key` + `Bearer` + `custom_header`;
через Rust `get_local_http`; парсер принимает `{data:[{id}]}`, массив, `{models:[…]}`.

**Резолв в прокси** (`proxy.rs:2497-2655`). (1) провайдер с точным id в `models[]`; (2) префикс `provider/…`; (3) id == имя провайдера;
(4) сессии `llamacpp → llamacpp-upstream → mlx` (сравнение `.` ≡ `_`); нет сессий → 503, есть, но не та → 404. `/models` = сессии ∪ модели провайдеров.

**Маршруты прокси.** POST `/chat/completions`, `/completions`, `/embeddings`, `/messages` (Anthropic; при ошибке конверсия в chat), `/messages/count_tokens`,
`/responses` (шим → chat для llama.cpp; MLX и облако — passthrough); GET `/models`, `/muse-code/models`, `/metrics`, `/openapi.json`, `/`, `/docs/*`.
Гейты: Host по `trusted_hosts`; `Bearer` или `X-Api-Key`; CORS с allowlist (27 заголовков). Состояние `<data>/local-api-server.json`.
Порт 1337 → при занятости OS-порт (`proxy.rs:4009-4033`).

**Auto-increase ctx** (`context_expansion.rs`). Прокси не сам перезагружает модель: событие `local_backend://auto_increase_ctx` → фронт перегружает →
`…_done` ≤ 60 с → ретрай.

**ChatGPT-подписка.** OAuth PKCE: `CLIENT_ID app_EMoamEEZ73f0CkXaXp7hrann`, `ISSUER https://auth.openai.com`, scopes `openid profile email offline_access`,
callback `http://localhost:1455/auth/callback` (300 с), токены `atomic-chatgpt-auth.json` v1 0600, refresh single-flight с запасом 120 с,
терминальные `invalid_grant | invalid_refresh_token | refresh_token_expired`. Upstream `POST …/codex/responses` с `originator: atomic_chat`,
`User-Agent: atomic-chat/1`, `OpenAI-Beta: responses=experimental`, `session-id`, `x-client-request-id`, `chatgpt-account-id`; `/models?client_version=0.156.0`.

**Агент** (`core/agent/target.rs:58-101`). llama.cpp — напрямую на порт сессии через `/completion` с GBNF; MLX — напрямую; `foundation-models` — не поддержан;
облако — через `local_server_endpoint` (:1337). Сессии ищет в картах плагинов (`llm_client.rs:946-995`). Ключи провайдеров в агент не попадают.

**Сайдкары.** `mlx-server`, `foundation-models-server`, `jan-cli` — обычные `resources/bin` (без triple); `bun`/`uv` — `externalBin` с триплами
(`download-bin.mjs:205-253`). `process_reaper.rs:30` `BACKEND_NAME_PREFIXES` — двухфакторный матч имя + корень. `process_env.rs` — AppImage:
бандл-сайдкары не стрипать. Рецепт добавления бинаря: Makefile → `package.json build:tauri:*` → `release.yml` → `tauri.<os>.conf.json` resources → codesign.

**Тест-конвенции приложения.** `web-app/vitest.config.ts` `define`-стабы; `tests/coverage-floor.json` + `check-coverage-floor.mjs`; `check-test-quality.mjs`;
`docs/testing-critical-flows.md` (грейды Strong / Partial / Smoke / Missing); `make verify-fast` = lint → typecheck → telemetry-props → quality →
hardening-contracts → coverage-critical; `make test-live` (`scripts/test-local-sidecars.py`), `make test-live-cloud` (`scripts/record-cloud-live.py`,
`ATOMIC_CLOUD_PROVIDERS`, `ATOMIC_CLOUD_<NAME>_{BASE_URL,API_KEY,MODEL,_STYLE,_TOOLS}`, кассеты `tests/fixtures/live-cloud`).
