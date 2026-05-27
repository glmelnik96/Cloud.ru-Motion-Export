# Cloud.ru Motion Export — CEP-панель для After Effects

Расширение для After Effects (2021+), которое экспортирует активную композицию в один из четырёх web-форматов: HTML на CSS+SVG, HTML на GSAP+SVG, Lottie JSON или Raw JSON.

> **Для разработчиков и AI-агентов:** прежде чем вносить изменения — прочитай [AGENTS.md](AGENTS.md). Там архитектура, контракты, конвенции, точки расширения и hard rules (что нельзя делать ни при каких условиях).

---

## Возможности

- **CSS + inline SVG** — zero-dependency HTML с полным покрытием фич: transform/opacity keyframes, gradients, masks, track mattes, эффекты, parent chain composition, spatial bezier, auto-orient, separate dimensions, текст.
- **GSAP + inline SVG** — GSAP timeline-API, та же геометрическая база.
- **Lottie JSON (bodymovin v5.7)** — MVP: shape / text / transform / easing. Не мапятся: gradients, эффекты, masks, repeater.
- **Raw JSON** — дамп извлечённого `compData` для диффа и debugging.

Полная таблица поддерживаемых фич — в самой панели и в [docs/html-export-spec.md](docs/html-export-spec.md).

### Принципы

- **Локальный, оффлайн.** Никаких сетевых вызовов из панели или host-скрипта.
- **Детерминированный.** Одинаковая композиция + одинаковые опции → байт-в-байт одинаковый артефакт. Никаких timestamps / random в выводе.
- **Zero-build.** Нет npm-зависимостей, нет bundler'а, нет TypeScript. Скопировал в `~/Library/Application Support/Adobe/CEP/extensions/` — оно работает.
- **Прозрачные ограничения.** Любая AE-фича, которую не получилось точно перенести, попадает в `warnings[]` и в `<name>.diagnostic.json` рядом с артефактом.

---

## Установка

1. Скопировать (или симлинкнуть) проект в:
   ```
   ~/Library/Application Support/Adobe/CEP/extensions/Cloud.ru Motion Export
   ```
2. Установить `CSInterface.js`:
   ```bash
   curl -sL "https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/CEP_11.x/CSInterface.js" \
     -o "$HOME/Library/Application Support/Adobe/CEP/extensions/Cloud.ru Motion Export/lib/CSInterface.js"
   ```
3. Включить загрузку неподписанных CEP-расширений (один раз):
   ```bash
   # macOS, CEP 11
   defaults write com.adobe.CSXS.11 PlayerDebugMode 1
   ```
   На Windows и для других версий CEP — см. [Adobe CEP-Resources / Cookbook](https://github.com/Adobe-CEP/CEP-Resources).
4. After Effects → меню **Window** → **Extensions** → **Cloud.ru Motion Export**.

---

## Использование

1. Открыть нужную композицию в After Effects.
2. В панели выбрать **Format** (CSS+SVG / GSAP / Lottie / Raw JSON).
3. Указать **Animation name** (по умолчанию — имя композиции).
4. Кнопкой **Browse** выбрать **Output directory** (или вписать путь вручную).
5. Нажать **Export**.

В выбранную папку записываются:
- `name.html` — главный артефакт (для Lottie / Raw JSON — `name.json`);
- `name.diagnostic.json` — структурированная диагностика: метаданные композиции, per-layer сводка, все warnings, raw keyframe-data для byte-level diffing;
- `assets/` — копии footage-файлов (если AV-слои использовались).

Export Log внизу панели показывает все warnings (несовместимые эффекты, fallback'и blend-mode'ов, упрощения масок) — те же сообщения дублируются в `<name>.diagnostic.json` для воспроизводимости.

---

## Архитектура (за 30 секунд)

```
After Effects (ExtendScript)        Panel (CEF + Node.js)
├─ host/index.jsx                   ├─ index.html + styles.css
│  ├─ motionExport_extractCompForHtml() ──┐
│  └─ motionExport_selectExportFolder()   │ JSON через CSInterface.evalScript
└──────────────────────────────────────────┤
                                     ├─ lib/CSInterface.js     (Adobe official)
                                     ├─ hostBridge.js          (Promise-обёртка)
                                     ├─ htmlExporter.js        (генераторы 4 форматов)
                                     └─ main.js                (UI runtime + fs)
```

- **Host (ExtendScript)** — извлекает активную композицию в JSON и открывает folder picker. Ничего не пишет на диск, ничего не генерирует.
- **Panel (HTML/JS)** — получает JSON, генерирует артефакт **на клиенте**, пишет файлы через `require('fs')` (CEP запущен с `--enable-nodejs --mixed-context`).

Полная схема, контракты и инварианты — в [AGENTS.md](AGENTS.md).

---

## Структура проекта

| Файл / директория | Назначение | Строк |
|---|---|---|
| `index.html` | Разметка панели + большая таблица поддерживаемых фич AE | ~124 |
| `styles.css` | Тёмная тема панели | ~318 |
| `main.js` | UI-runtime: handlers Browse / Export, статус, лог, запись файлов | ~230 |
| `hostBridge.js` | CSInterface-обёртка с Promise-API; кэширует `$.evalFile` хост-скрипта | ~93 |
| `htmlExporter.js` | Все 4 генератора (CSS+SVG / GSAP / Lottie / Raw) + helpers (matrix, bezier, masks) | ~2080 |
| `host/index.jsx` | ExtendScript-extractor: чтение комп-properties, sampling expressions, folder picker | ~1272 |
| `lib/CSInterface.js` | Adobe CSInterface (устанавливается вручную, см. установку) | — |
| `CSXS/manifest.xml` | Манифест CEP-расширения (bundle id, host requirements, panel geometry) | — |
| `AGENTS.md` | Handoff-документация для разработчиков и AI-агентов | — |
| `docs/` | Дополнительная документация (см. [docs/README.md](docs/README.md)) | — |

---

## Известные ограничения

Кратко (полный список — в [AGENTS.md → Известные ограничения](AGENTS.md#известные-ограничения-roadmap-кандидаты) и в [docs/html-export-spec.md](docs/html-export-spec.md)):

- **Pre-compositions (nested comps)** — не поддерживаются. Workaround: flatten / Pre-compose → Move all attributes.
- **3D layers / Cameras / Lights** — не поддерживаются (flatten в 2D до экспорта).
- **Time remapping, Motion Blur, Frame Blending** — не экспортируются.
- **Эффекты вне whitelist'а** (`Fill / Drop Shadow / Gaussian Blur / Invert / Brightness & Contrast / Hue/Saturation / Tint`) — игнорируются с warning.
- **Lottie-формат — MVP.** Gradients, эффекты, masks, repeater, text animators не мапятся. Для полного feature-parity используй CSS+SVG.

---

## Разработка

- **Перезагрузка.** Hot reload отсутствует. После правки любого файла — закрыть и снова открыть панель в After Effects (Window → Extensions → Cloud.ru Motion Export).
- **DevTools.** Файл `.debug` в корне открывает CEF DevTools на `localhost:8092`. Открой Chrome → `http://localhost:8092` → инспектор панели. **Файл `.debug` не коммитить** — в `.gitignore`.
- **Зависимости.** Никаких npm. Единственная внешняя библиотека в runtime — `lib/CSInterface.js` (официальная Adobe, ставится вручную).
- **Языковые ограничения.** `host/*.jsx` — строго ES3 (без `let/const/arrow/forEach`). Файлы панели — ES5-стиль для единообразия.
- **Перед изменениями — прочитай [AGENTS.md](AGENTS.md).** Особенно секции «Контракты», «Конвенции и инварианты» и «Запреты».

---

## Документация

| Документ | Для кого |
|---|---|
| [README.md](README.md) | Пользователи плагина: установка, использование, ограничения |
| [AGENTS.md](AGENTS.md) | Разработчики и AI-агенты: архитектура, контракты, конвенции, точки расширения |
| [docs/html-export-spec.md](docs/html-export-spec.md) | Подробная спецификация HTML-экспорта: feature coverage, mapping AE → CSS/SVG, edge-cases |
| [docs/README.md](docs/README.md) | Индекс документации |
| [lib/README.md](lib/README.md) | Как установить `CSInterface.js` |
