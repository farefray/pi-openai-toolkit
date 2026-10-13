# Safe інтеграція для thegame / pi-web

Цей fork має окремий opt-in entrypoint `src/thegame-extension.ts`. Він композиційно реєструє compaction, Web Search і Codex Astra; Images та Responses WebSocket не імпортує і не реєструє. Це локальна shared-host адаптація, не підтвердження provider capabilities чи дозвіл remote compaction.

## Вибір package source

Для safe інтеграції вибирайте **підпакет `pi-openai-toolkit/thegame`**, не корінь toolkit. Його `thegame/package.json` оголошує тільки `../src/thegame-extension.ts`. Наприклад, для сусідніх checkout у project settings:

```json
{
  "packages": [{
    "source": "../../thegame-pi/pi-openai-toolkit/thegame"
  }]
}
```

Root `pi.extensions` зберігає п'ять upstream resources і upstream поведінку. `files` розширено новими runtime cores, safe source/subpackage і fork docs, щоб npm packing не втратив нових relative imports; це не активує safe composition під час root load. Одночасне завантаження root package та safe підпакета не підтримується: це два набори handlers/tools/commands. Main має перевірити фактичні loaded resources та єдиного compaction producer. Вибір source/settings, rollout і конфлікти з іншими compaction extensions належать інтеграційному зрізу main.

## S4 host projection і persisted safety

Pi-web source має приватний instance-local adapter (`lib/toolkit-context-projector.ts`): public runner emitContext/createContext/onError, existing Toolkit projector/reporter fields, clone, operation-local subscription і stale checks; wrapper constructor та обидва reload callbacks. Це не SDK fork або shared prototype patch. Safe extension без host capability продовжує fail closed.

Project-only guards у `extension-runtime.ts` не дозволяють disabled reader/malformed/foreign/unverified/edited opaque checkpoint перейти в sentinel-only history чи native text fallback. Explicit nativeFallback off теж не дозволяє SDK default fallback після remote rejection. Ciphertext predicate reused із `remote-v2-client.ts`; schema/checkpoint/auth/legacy/windows ownership unchanged.

Host225PASS, SDK/RPC fixture21PASS: fake checkpoint actual compact → persist → reopen/fork/tree → continuation → successful recompact, cached tools і tail exactly-once; errors/cancel/refusal preserve bytes. Typechecks SDK1.0/1.1 PASS, full762PASS/2samebaselineWindowsimageFAIL. Evidence у thegame `W-074-S4-final-DYtVDm`, `W-074-S4-toolkit-final-PySz7O`, `W-074-S3-toolkit-web-VvCCxb`. Independent reviewer P2 missing-successful-recompact test gap fixed/re-reviewed. Synthetic PASS не доводить live recall/dispatch suppression/browser. Serving unchanged, project context native; live persisted recall і новий build/restart/browser acceptance — наступні окремі gates. Не мігрувати user sessions чи видаляти reader після opaque checkpoint.

## R3 live/project trial

Private scripts `thegame-remote-persistence-probe.mjs` і `.test.ts` reuse existing S2 guards: explicit subscription-only, exact Codex endpoint/model IDs, workflow45s/3dispatch, no retries/refresh/API-key fallback. Actual current SDK + safe source + source host shim створюють disposable trusted mini-project, user+tool markers, real remote checkpoint, fresh reopen і fork від checkpoint до першого recall. Continuations не містять plaintext marker values; tool execution заборонено; exact JSON/finalstop/noabort потрібні для PASS. Transient checkpoint data видаляється тільки після settled operations; reports/plan sanitized. Tests12PASS/84assertions incl actual SDK mock (explicit mockBackend record), independent narrow safety review no blockers.

Live Sol/high `W-074-S5-live-persistence-5NHwnf`, Astra/high `zvTMAq`, Luna/high `OpFQrF` (same prefix): кожна3HTTP200/allstagesPASS/authunchanged/fixture-deleted. Це bounded memory smoke, не lossless/cross-model/long history guarantee. Після user rebuild/restart running `release-20261012-161739-0d80d7ea` містить matching shim/rpc source і compiled adapter; main project policy вмикає only three exact Codex remote-compaction/pi-context-hook/nativeFallbackfalse overrides, hosted unchanged. Default інших моделей native Pi; windows/images/WS/grants untouched. Resolverissues0, SDK/guard/lifecycle56PASS. Current project policy applies at next hook, no extra reload/restart by main. Once an opaque checkpoint exists keep its compatible reader/provider, not blind policy/package deletion.

## R4 grammar compatibility repair

`serializer.ts` відновлює grammar calls із persisted `toolsAdded` через public SDK `getDeclaredTools`, а не streaming `customInput` чи current loadout. За explicit producer compat lark/regex calls мають `custom_tool_call` з raw sanitized input і парний `custom_tool_call_output`; function calls, ID guards та image limits збережено. Recompact отримує operation-local map із повної canonical/ordered projection до slicing; replay не пересеріалізує SDK-authored items і не відновлює raw sealed history.

Невалідні grammar declaration/input дають typed content-free refusal. Спільний compact hook повертає `{cancel:true}` для project та legacy activation до remote/native dispatch: SDK-swallowed exception не запускає text compactor. Сторонні legacy exceptions і звичайний fallback routing не переозначено; project catch-all, checkpoint/provenance/endpoint guards збережено. Remote failure notice показує лише контрольовані reason/status/code/type/param/category, не provider-authored message/body.

Зміна source потребує явного `/reload` або нової сесії для вже завантаженої extension. Це не новий serving build/restart, session migration або дозвіл використати стару історію як probe. Поточні R4 checks та межі acceptance — у project owner `docs/features/harness/openai-toolkit.md` і `W-074-remote-compaction-safety.md` checkout thegame.

## Project policy і trust

Reader перевіряє `ctx.isProjectTrusted() === true` **перед доступом до cwd або читанням policy**. Відсутній, throwing або негативний trust method блокує залежні features; глобальна установка safe package не обходить project trust.

Після підтвердження trust reader читає лише `ctx.cwd/.pi/pi-openai-toolkit.json`. Немає cascade, env overlays, global config fallback, credential writes чи policy writer. Project document має бути schema v2. Порожній legacy object, malformed/unreadable document та unsupported schema fail closed для залежних операцій.

Missing project document перетворюється на явний v2 snapshot:

```json
{
  "schemaVersion": 2,
  "defaults": {
    "context": { "mode": "pi" },
    "webSearch": { "route": "unmanaged" },
    "imageGeneration": { "enabled": false },
    "responsesWebSocket": { "enabled": false }
  }
}
```

`unmanaged` зберігає сторонній search, а не вимикає мережу. Hosted search можна вибрати явно через ту саму schema. Images/WS лишаються виключеними з safe entrypoint навіть якщо document декларує їх enabled. `/toolkit-config` має project description і показує фактичний project source; звіт описує intent, не підтверджену capability чи tool availability.

Операція читає один snapshot, передає його у producer/search execution і не підміняє його наступним disk read під час await. Managed manual handoff зберігає initiating snapshot за чинним upstream контрактом.

## Ownership і upstream compatibility

- `runtime-core.ts` і `request-context-cache-core.ts` створюють activation-owned state; `runtime.ts` і `request-context-cache.ts` зберігають старі synchronous/async facade APIs та upstream default owners.
- `config/notifications-core.ts` містить pure reporting і closure-owned notice/command registrars; старі notification/config-command facades лишаються upstream-only.
- `compaction-extension-core.ts` є shared registration boundary для compaction/search. Search behavior має одного owner тут; `web-search/extension.ts` — legacy facade зі старими default runtime/notifier та idempotent registration.
- Compaction behavior має одного owner у `createCompactionExtension()` (`extension-runtime.ts`): private helpers і registrar належать його closure. Upstream default wrapper та safe registration викликають його, а не дві копії алгоритму.
- Provider resolution ін'єктується наскрізно у context tools, history/notes/thread hint та manual preflight. Legacy provider default ліниво звертається до старого runtime facade; safe activation передає власний resolver і не завантажує цей default.
- Shutdown очищає лише activation-owned cache/windows/notices і відпускає search tool ownership. Published tool exclusions перевіряються повторно; відсутній дозволений tool не додається назад під час lifecycle retry.

Safe path не викликає SDK prototype installer. Upstream wrapper зберігає installer default; його projection WeakMap тепер належить installer closure і не створюється при import. Для safe `pi-context-hook` policy без доступного projector compaction скасовується до remote/native dispatch, не переходить у legacy input. Checkpoint provenance, replay/context-edit та tool-loadout guards не послаблені.

Ordered projector належить host-owned instance-local adapter, описаному в S4 вище; Toolkit не додає shared prototype patch. WS лишається isolated-only; цей entrypoint не заявляє його shared-host підтримки.

## Verification і межі

S1 локальні checks використовують installed Bun, `PI_OFFLINE=1`, fresh QA root із ізольованими HOME/USERPROFILE/TEMP/TMP/TMPDIR. Destructive test targets перевірено: cleanup обмежений test-owned temporary roots.

- Штатний `tsc -p tsconfig.check.json`: PASS.
- Focused Bun suite: **308 PASS / 0 FAIL**, 15 files, 1869 assertions. Включає нові policy/trust/factory/isolation tests і незмінені upstream assertions для request/runtime, context lifecycle, projection, replay та standalone fallback.
- Main додав safe source у штатний typecheck і звузив наявний Astra union доступом `"role" in last`, не змінюючи підтримувані outcomes. Штатний typecheck зі SDK **1.0.0** і окремий зі всіма відповідними peer types зі SDK **1.1.0** — PASS. Перший SDK1.1 probe помилково змішав peer types різних checkout; alignment виправлено без source/assertion weakening.
- Final full Bun suite: **762 PASS / 2 FAIL**, 6459 assertions; два Windows image-artifact FAIL збігаються з upstream baseline, не усунені й не послаблені.
- Managed-handoff snapshot repair: compaction/search мають спільний trust-guarded reader; 3 нові regressions охоплюють valid/malformed disk edits і revoked/unknown trust до restoration.
- Actual SDK1.1/pi-web tests: **9 PASS** — factory selection/trust, concurrent activation, dispose/reopen/reload, Chat-only, current child allowlists, global-only model catalog і denied project policy. Late startup/binding/shutdown timeouts зберігають isolated environment/root до завершення test worker, а не відновлюють operator paths після самого disposal.
- `validation.test.ts` має лише explicit cache-injection adapter; його assertions збережені. Main також зберіг legacy standalone optional-path reader contract: zero-argument invocation, не передача ctx. Окрема regression PASS (3 assertions).

Evidence run у project checkout: `bin/qa/harness/W-074-S1-unit-kVrTvinA/` (`typecheck-final.log`, `focused-final.log`, `safe-typecheck.log`). Це unit/source evidence, не SDK 1.1 чи live acceptance.

Main незалежно перевірив diff, full suite, actual SDK/web loader і RPC lifecycle; два P2 independent review (shared snapshot і failure-path cleanup) виправлені та адресно re-reviewed. Actual Agent child execution, browser UI/input і checkpoint continuation/reopen не перевірені; child loader evidence не є повним child run. Project source selection і inactive policy підключені у thegame; за наступним прямим user request project defaultProvider і7role provider prefixes змінено на openai-codex у thegame; IDs/thinking/Exa/imagegen/role grants збережено. Remote features не активуються самим provider switch. Наступний окремий hosted-search trial у thegame має exact overrides Codex Sol/Astra/Luna; native context/Images/WS/role grants unchanged. Unit regression107PASS/730assertions включає payload/source include, Exa preservation, unconfigured-model і rollback. Current SDK1.1 typecheck та web9PASS; backend Sol/high+Astra/off+Luna/off PASS із citations, initial Sol/off FAIL acceptance без citations. Evidence — `W-074-S3-hosted-probes-3nnwYv`; browser/child hosted search NOT-RUN. Subscription capability probes тримає живий project owner `docs/features/harness/openai-toolkit.md` у checkout `thegame`; цей документ не є ресурсом npm package. Serving server/release і credentials не змінено цим rollout. Вимкнення нової activation через resource selection не є дозволом видалити readers для вже створених opaque checkpoints.
