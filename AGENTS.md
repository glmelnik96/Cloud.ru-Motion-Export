# AGENTS.md — Cloud.ru Motion Export

Входная точка для агентов (Claude Code, Codex, Cursor) и людей, впервые встречающих этот репозиторий. Содержит то, что нельзя вывести из чтения кода за разумное время: контракты, конвенции, причины архитектурных решений и точки расширения.

---

## TL;DR за 30 секунд

CEP-панель для **Adobe After Effects 2021+** (CEP 11). Читает активную композицию через **ExtendScript**, отдаёт её в браузерный движок панели как JSON, и **на клиенте** генерирует web-артефакт в одном из 4 форматов (CSS+SVG / GSAP+SVG / Lottie JSON v5.7 / Raw JSON). Запись на диск — **Node.js `fs`** прямо из панели (CEP запущен с `--enable-nodejs --mixed-context`). Никаких внешних API, сервисов, сетевых вызовов. Никакого LLM. Полностью локальный, детерминированный экспортёр.

**Что НЕ делать в этом проекте** (исторический контекст):
- Никаких чатов, агентов, LLM-интеграций, prompt-библиотек, knowledge-base. Проект пережил две таких реинкарнации («Extensions LLM Chat», «AE Motion Agent»), всё это уже выпилено — см. git history (`refactor: remove legacy agent pipeline artifacts`).
- Никаких сетевых вызовов из панели и из host-скрипта. Единственное допустимое внешнее обращение — `<script src=cdnjs.../gsap.min.js>` в **сгенерированных** GSAP-артефактах (это конечный продукт, а не runtime).

---

## С чего начать чтение

| Хочешь понять… | Открой |
|---|---|
| Что делает проект и как им пользоваться | [README.md](README.md) |
| Что умеет и не умеет HTML-экспорт (фичи AE → CSS/SVG) | [docs/html-export-spec.md](docs/html-export-spec.md), либо таблица прямо в `index.html` |
| UI-поток (Browse → Export → запись файлов) | `main.js` (230 строк, читается за 5 минут) |
| Как панель общается с AE | `hostBridge.js` (93 строки) |
| Как извлекается композиция из AE | `host/index.jsx`, ищи `motionExport_extractCompForHtml` (~строка 1102) |
| Как генерируется HTML/Lottie/JSON | `htmlExporter.js`, начни с `generate()` (~строка 2026) — это dispatcher |

**Размеры файлов** (для оценки сложности):

| Файл | Строк | Назначение |
|---|---|---|
| `htmlExporter.js` | ~2080 | Все 4 генератора + helpers (matrix math, bezier, masks) |
| `host/index.jsx` | ~1272 | ExtendScript-extractor (ES3, без современного синтаксиса) |
| `main.js` | ~230 | UI runtime, file I/O через `require('fs')` |
| `index.html` | ~124 | Разметка + большая таблица поддерживаемых фич AE |
| `hostBridge.js` | ~93 | CSInterface-обёртка с Promise-API |
| `styles.css` | ~318 | Тёмная тема панели |

---

## Архитектура

```
┌─────────────────────────────────────────────────────────────┐
│  After Effects (CEP host process, ExtendScript engine)       │
│                                                              │
│  host/index.jsx                                              │
│   ├─ motionExport_extractCompForHtml()  → JSON compData       │
│   └─ motionExport_selectExportFolder()  → Folder.selectDialog │
└──────────────────────────▲──────────────────────────────────┘
                           │ CSInterface.evalScript (string in,
                           │ string out — must be JSON-parseable)
┌──────────────────────────┴──────────────────────────────────┐
│  CEP Panel (CEF browser + Node.js, mixed-context)            │
│                                                              │
│  index.html                                                  │
│   └─ <script> lib/CSInterface.js                             │
│   └─ <script> hostBridge.js  → window.HOST_BRIDGE            │
│   └─ <script> htmlExporter.js → window.HtmlExporter          │
│   └─ <script> main.js  (UI runtime)                          │
│                                                              │
│  Flow:                                                       │
│   1. user clicks Export                                      │
│   2. main.js → HOST_BRIDGE.evalHostFunction(                 │
│        'motionExport_extractCompForHtml()')                  │
│   3. hostBridge.js → CSInterface.evalScript(...)             │
│   4. host returns compData JSON → parsed                     │
│   5. main.js → HtmlExporter.generate(format, compData, opts) │
│   6. main.js → writeExportFiles(outDir, result.files)        │
│      via require('fs') (Node.js in panel context)            │
└─────────────────────────────────────────────────────────────┘
```

### Почему такая раскладка

- **Извлечение в host, генерация на клиенте.** Host (ExtendScript) — ES3, медленный, страдает от блокировки AE UI. Поэтому в host'е делается только то, что требует доступа к AE-объектам: чтение свойств, sampling expressions, folder picker. Вся «тяжёлая» математика (matrix composition, bezier subdivision, SVG-сборка, Lottie-mapping) живёт в `htmlExporter.js` на клиенте, в нормальном JS-движке.
- **Запись файлов из клиента, а не из host.** CEP с `--enable-nodejs --mixed-context` даёт `require('fs')` в окне панели. Это надёжнее, чем `File.write()` из ExtendScript (нет проблем с encoding, permissions, async).
- **`evalScript` принимает строку и возвращает строку.** Поэтому host-функции возвращают `JSON.stringify(...)` (см. `resultToJson` в `host/index.jsx`), а bridge парсит обратно.

---

## Контракты

### Public API

**Host (вызывается из панели через `HOST_BRIDGE.evalHostFunction`):**

```js
motionExport_extractCompForHtml() → {
  ok: boolean,
  message?: string,                 // present when ok=false
  comp:   { name, width, height, duration, frameRate, pixelAspect, bgColor },
  layers: [ LayerEnt, ... ],        // see "compData shape" below
  warnings: [string, ...]
}

motionExport_selectExportFolder(defaultPath: string) → {
  ok: boolean,
  path?: string,        // fsName of chosen folder
  cancelled?: boolean,  // user clicked Cancel
  message?: string
}
```

**Client (`window.HtmlExporter`):**

```js
HtmlExporter.generate(format, compData, opts) → {
  files: [
    { name: 'foo.html',            content: '<!DOCTYPE...' },
    { name: 'foo.diagnostic.json', content: '{...}' },
    { name: 'assets/clip.mp4',     copyFrom: '/abs/path/to/footage.mp4' }
  ],
  warnings: [string, ...]
}

HtmlExporter.easings → { inOutCubic: 'cubic-bezier(...)', outBack: '...', ... }
```

- `format` ∈ `'css-svg' | 'gsap-svg' | 'lottie-json' | 'lottie' | 'json-raw'`
- `opts.name` — basename выходных файлов (default: `compData.comp.name`)
- `files[i].copyFrom` — путь-источник: `main.js → writeExportFiles` копирует через `fs.copyFileSync`. Иначе используется `content` и `fs.writeFileSync(..., 'utf8')`.

### compData JSON shape (per layer)

```
{
  type: 'text'|'shape'|'av'|'precomp'|'camera'|'light'|'null'|'adjustment',
  name, index, parentIndex,
  inPoint, outPoint, enabled,
  anchor:       { v: [x,y], kfs?: [...] },
  autoOrient:   boolean,
  trackMatteType: 'none'|'alpha'|'alpha-inverted'|'luma'|'luma-inverted',
  isTrackMatte: boolean,
  blendMode:    string,                  // CSS mix-blend-mode name
  transform: {                           // each: { kfs: [{t,v,iType,oType,ei,eo, to?, ti?}], v?: scalar }
    position, scale, rotation, opacity,
    positionX?, positionY?               // when separate-dimensions is on
  },
  effects?:  { fill?, dropShadow?, blur?, invert?, brightnessContrast?, hueSaturation?, tint? },
  masks?:    [ { mode, inverted, expansion, opacity, path, ... } ],
  extras?: { text?: {...}, shape?: {...}, media?: {...} }
}
```

- **Keyframe array `kfs`** — каждый kf несёт `t` (time, sec), `v` (value), `iType/oType` (`'linear'|'bezier'|'hold'`), `ei/eo` (bezier influence/speed для in/out), и для position — spatial tangents `to/ti`.
- **`type`** — детектируется через `instanceof TextLayer/ShapeLayer/CameraLayer/LightLayer` + признаки `nullLayer/adjustmentLayer/source instanceof CompItem` (см. `_ehtmlLayerType`).

### Inter-process контракт через CSInterface

`evalHostFunction(str)` отправляет произвольную строку в ExtendScript-движок. Хост-сторона:

1. Должна вернуть **JSON-строку** через `resultToJson(obj)` — bridge парсит её через `JSON.parse`.
2. Если возвращает не-JSON — bridge даст `{ ok: true, message: <raw>, raw: <raw> }` (best-effort).
3. Префикс `"EvalScript error"` — отдельно ловится bridge'ем как ошибка.

Host-скрипт загружается **один раз** через `$.evalFile()` при первом вызове (см. `ensureHostScriptLoaded`). Все определения функций становятся глобальными в ExtendScript-engine'е. Повторные вызовы `evalHostFunction` шлют только сам call, не весь скрипт.

---

## Конвенции и инварианты

### Язык / синтаксис

- **`host/*.jsx` — ES3 only.** ExtendScript не понимает `let/const`, arrow functions, `forEach`, template literals, classes, `Promise`. Только `var`, `function`, classic for-loops. Внутри есть `_ehtmlSafeGet(function () { return ... })` — это паттерн для try/catch вокруг любого AE property access.
- **`*.js` в панели — ES5.** CEP 11 использует современный CEF, но мы намеренно не используем bundler/transpiler, поэтому ES5 без `class` / arrow / `async` достаточно (и единообразно с ES3-стилем хоста). Promise есть, ES2015 built-ins есть. Не тащи Webpack/Babel/TypeScript — это убьёт zero-build deploy.
- **Никаких npm-зависимостей в runtime.** `node_modules/` в `.gitignore` навсегда. Лишь `lib/CSInterface.js` — официальная Adobe-обёртка, скачивается вручную при установке (см. `lib/README.md`).

### Детерминизм

- **Никаких `Date.now()`, `Math.random()` в выходных артефактах.** Один и тот же входной comp + opts должны давать байт-в-байт одинаковый файл. Это используется для `diff` между прогонами и для `<name>.diagnostic.json` — пользователю должно быть видно, что реально изменилось в композиции.

### Naming в layer/asset id'ах

- `escapeCss(s)` — для CSS-классов и SVG `id` (только `[a-zA-Z0-9_-]`).
- `slugify(s)` — для имён файлов (lowercase, dash-separated, ≤60 chars).
- HTML/SVG-контент текста — через `escapeHtml`.

### Warnings

- Любой пропущенный/упрощённый функционал — это **warning**, не error. Не валим экспорт из-за неподдерживаемого эффекта; logгируем в `warnings[]`, который рендерится в Tool Log и складывается в `<name>.diagnostic.json`.
- Префикс `Layer "<name>": ...` — общий формат.

### Префикс `_ehtml` в host

Все приватные хелперы хоста начинаются с `_ehtml*` (`_ehtmlSafeGet`, `_ehtmlExtractTransform` и т.д.) — это namespace-маркер, чтобы случайно не конфликтовать с другими скриптами, загруженными в тот же ExtendScript-engine.

---

## Точки расширения

### Добавить новый формат экспорта

1. Написать `generateMyFormat(compData, opts)` в `htmlExporter.js` по образу `generateCssSvg` / `generateLottieJson`. Возвращать `{ files, warnings }`.
2. Дописать ветку в `generate()` (~строка 2026).
3. Добавить `<option value="my-format">` в `index.html` (select `#export-format-select`).
4. Дописать описание в `EXPORT_FORMAT_HINTS` (`main.js:78`).
5. Дополнить таблицу в `index.html` и `docs/html-export-spec.md`.

### Добавить поддержку нового AE-эффекта

1. **Host** (`host/index.jsx`): в `_ehtmlExtractEffects` распознать match-name эффекта (например `ADBE Glow`) и извлечь нужные properties как keyframe-tracks.
2. **Client** (`htmlExporter.js`): в `buildFilterAtTime` / `buildSvgShapes` добавить CSS/SVG-mapping. Если эффект не маппится 1:1, оставить warning и описать аппроксимацию.
3. **UI**: добавить строку в support-таблицу `index.html` (статус `✅` / `⚠️` / `❌`).
4. Обновить `numEffects > supportedEffects` инкремент в host'е (~строка 1186), чтобы не выдавать ложный warning «unsupported effect».

### Добавить поддержку нового типа shape

1. Host: расширить `_ehtmlExtractShapeExtras` / `_ehtmlExtractShapePrimitive`.
2. Client: дописать ветку в `buildShapeGeometry` (`htmlExporter.js:622`).

### Изменить наблюдаемое поведение UI

- DOM-кэш — `cacheDomRefs()` в `main.js`. Всегда добавляй ref через `els.*`, не вызывай `getElementById` россыпью.
- Статус-линия — `setExportStatus(msg, kind)`, kind: `''|'ok'|'error'|'working'`.
- Tool Log — `addToolLogEntry(name, status, msg)`, статус: `info|ok|warn|error`.

---

## Dev workflow

### Установка для разработки

См. [README.md](README.md). Кратко:

```bash
# 1. Симлинк или копия проекта в CEP-extensions
ln -s "$(pwd)" "$HOME/Library/Application Support/Adobe/CEP/extensions/Cloud.ru Motion Export"

# 2. Установить CSInterface.js
curl -sL "https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/CEP_11.x/CSInterface.js" \
  -o lib/CSInterface.js

# 3. Включить unsigned extensions (один раз)
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
```

### Перезагрузка после правок

- HTML / CSS / `main.js` / `hostBridge.js` / `htmlExporter.js` — закрыть и снова открыть панель в AE (Window → Extensions → Cloud.ru Motion Export). Hot reload нет.
- `host/index.jsx` — то же самое. `ensureHostScriptLoaded` кэширует загрузку в рамках одного открытия панели.

### Отладка панели

Файл `.debug` в корне расширения открывает CEF DevTools на `localhost:8092` (порт указан внутри файла). Открыть Chrome → `http://localhost:8092` → виден инспектор панели.

⚠️ `.debug` есть в `.gitignore` — не публикуй его при сборке для distribution.

### Отладка host (ExtendScript)

ExtendScript Toolkit (deprecated) или VS Code extension «Adobe ExtendScript Debugger». Точки останова в `host/index.jsx`, attach to After Effects.

### Тестирование

Нет автоматических тестов. Ручная валидация: проверить экспорт на «эталонных» композициях разной сложности (одна shape-layer; multi-layer с masks; text с animator; AV с footage). После значимых изменений — открыть `<name>.diagnostic.json` до/после и убедиться, что только ожидаемые поля изменились.

---

## Известные ограничения (roadmap-кандидаты)

Список перенесён из спека и code-comments. Каждый пункт = конкретная задача для будущего pass'а.

### Не поддерживается (warning, экспортируется без фичи)
- **Pre-compositions** — пропускаются полностью. Workaround: flatten вручную или `Pre-compose → Move all attributes`.
- **3D layers / Cameras / Lights** — игнорируются.
- **Time remapping, Motion Blur, Frame Blending** — не экспортируются.
- **Эффекты вне whitelist'а** (всё кроме `Fill / Drop Shadow / Gaussian Blur / Invert / Brightness & Contrast / Hue/Saturation / Tint`) — warning.

### Аппроксимации (есть в выводе, но не pixel-perfect)
- **Tint effect** — `filter: grayscale + sepia + hue-rotate`; точный Black→White через `<feColorMatrix>` — roadmap.
- **Mask Expansion (animated)** — fade-approximation через `fill-opacity`; per-frame `<feMorphology>` — roadmap.
- **Text animators (per-char)** — stagger-MVP по opacity; полная Range Selector математика (shape / smoothness / inter-selector composition) — roadmap.
- **Per-group animated transforms** в shape-layer — статический snapshot на t=0.
- **Repeater keyframed copies/offset/transform** — статический bake на t=0.
- **Animated anchor point** — один статический snapshot.
- **Masks: Intersect / Lighten / Darken / Difference modes** — downgrade до Add с warning (lottie тоже не реализует Darken/Lighten/Difference).
- **Drop Shadow animation** — static first-frame (animated keyframes по shadow — roadmap).
- **Pixel Aspect Ratio ≠ 1.0** — игнорируется (предполагается 1.0).

### Lottie-формат специфично
Lottie-export — MVP-уровня. **Не мапятся**: gradients (берётся первый stop как solid), CSS filters/effects, masks, track mattes, repeater, text animators. Для полного feature-parity — используй CSS+SVG.

### ZIP-packaging
Для баннеров с per-size вариантами — не реализован. Сейчас экспорт пишет файлы в одну папку.

---

## Глоссарий

- **CEP** — Common Extensibility Platform: Adobe-овский framework для HTML/JS-панелей в Creative Cloud приложениях. Версия 11 поставляется с современным CEF и Node.js.
- **ExtendScript** (`.jsx`) — ES3-диалект JavaScript, в котором работают legacy-скрипты Adobe-приложений. Имеет доступ к application DOM (AE: `app.project`, `comp.layer(i)` и т.д.). Без Promise, async, fetch, modern Array methods.
- **CSInterface** — JS-API внутри CEP-панели для вызова ExtendScript-кода (`evalScript`), получения путей (`getSystemPath`), и регистрации событий.
- **compData** — внутреннее имя для JSON-структуры, которую host отдаёт клиенту. См. секцию «compData JSON shape».
- **Match name** — внутренний строковый id AE-property (например `ADBE Drop Shadow` для эффекта Drop Shadow). Используется в host'е вместо display-name (display-name локализуется).
- **Track matte** — режим, при котором один слой задаёт альфу/luma-маску для соседнего нижнего слоя.
- **Bodymovin / Lottie** — JSON-схема для векторной анимации, рендерится через `lottie-web` runtime. Мы экспортируем подмножество schema v5.7.

---

## История проекта (для контекста — git за подробностями)

| Эпоха | Что было |
|---|---|
| `453c778` – `b8772ff` | «Extensions LLM Chat» — чат-панель с OpenAI/Anthropic-провайдером |
| `311aefc` – `7d69423` | «AE Motion Agent» — agentic loop с tool-use, knowledge-base, prompt-library, brand-presets |
| `631c93e` – HEAD | «Cloud.ru Motion Export» — чистый экспортёр, всё LLM/agent-наследие выпилено |

Если в коде встречается странное наследие («Llm», «Chat», «agent», «brand-preset») — это **bug-кандидат** на дочистку, а не feature. На дату последнего рефакторинга (см. `git log`) репозиторий был очищен через `grep -rinE 'extensionsLlmChat|chat[Pp]rovider|agentSystemPrompt|agentToolLoop|brandPresets|toolRegistry|prompt-library|knowledge-base|legacy-archive|ollamaVision|captureMacOS|"llm chat"|"Extensions LLM"'` → 0 совпадений.

---

## Запреты (hard rules)

1. **Не добавлять LLM / API-клиенты / сетевые вызовы** в runtime панели или host. Если задача требует «спросить модель» — это другой проект, не сюда.
2. **Не добавлять npm-зависимости** в runtime. Build-time tooling в `devDependencies` — обсуждаемо, но zero-build deploy ценнее.
3. **Не использовать ES6+ в `host/*.jsx`.** Любой arrow / let / template-literal сломает ExtendScript.
4. **Не эмитить недетерминированные значения** в выходные файлы (timestamps, random id'ы, ISO-даты создания).
5. **Не молчать про unsupported features.** Любая фича AE, которую не смогли перенести — push warning в `warnings[]`.
6. **Не коммитить `.debug`** — он содержит локальный порт DevTools и не должен попадать в публикуемые сборки.
