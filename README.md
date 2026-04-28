# Cloud.ru Motion Export — CEP-панель для After Effects

Расширение для After Effects (2021+), которое экспортирует активную композицию в один из четырёх web-форматов: HTML на CSS+SVG, HTML на GSAP+SVG, Lottie JSON или Raw JSON.

---

## Возможности

- **CSS + inline SVG** — zero-dependency HTML с полным покрытием фич: transform/opacity keyframes, gradients, masks, track mattes, эффекты, parent chain composition, spatial bezier, auto-orient, separate dimensions, текст.
- **GSAP + inline SVG** — GSAP timeline-API, та же геометрическая база.
- **Lottie JSON (bodymovin v5.7)** — MVP: shape / text / transform / easing. Не мапятся: gradients, эффекты, masks, repeater.
- **Raw JSON** — дамп извлечённого `compData` для диффа и debugging.

Полная таблица поддерживаемых фич — в самой панели и в [docs/html-export-spec.md](docs/html-export-spec.md).

---

## Установка

1. Скопировать проект в:
   ```
   ~/Library/Application Support/Adobe/CEP/extensions/Cloud.ru Motion Export
   ```
2. Установить `CSInterface.js`:
   ```bash
   curl -sL "https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/CEP_11.x/CSInterface.js" \
     -o "$HOME/Library/Application Support/Adobe/CEP/extensions/Cloud.ru Motion Export/lib/CSInterface.js"
   ```
3. Включить загрузку неподписанных CEP-расширений (зависит от версии AE и macOS).
4. After Effects → меню **Window** → **Extensions** → **Cloud.ru Motion Export**.

---

## Использование

1. Открыть нужную композицию в After Effects.
2. В панели выбрать **Format** (CSS+SVG / GSAP / Lottie / Raw JSON).
3. Указать **Animation name** (по умолчанию — имя композиции).
4. Кнопкой **Browse** выбрать **Output directory** (или вписать путь вручную).
5. Нажать **Export**.

В выбранную папку записываются:
- `name.html` (или `name.json` для Lottie / Raw JSON);
- `name.diagnostic.json` — структурированная диагностика, список слоёв, warnings;
- `assets/` — копии footage (если использовалось).

Экспорт детерминирован: одинаковая композиция → одинаковый артефакт.

---

## Структура проекта

| Файл / директория | Назначение |
|---|---|
| `index.html`, `styles.css` | Разметка и стили панели |
| `main.js` | UI-runtime: handlers Browse / Export, статус, лог |
| `hostBridge.js` | CSInterface-обёртка `evalScript` для вызова ExtendScript |
| `htmlExporter.js` | Генератор HTML / GSAP / Lottie / Raw из `compData` |
| `host/index.jsx` | ExtendScript: extract из активной композиции + folder picker |
| `lib/CSInterface.js` | Adobe CSInterface (устанавливается вручную, см. выше) |
| `CSXS/manifest.xml` | Манифест CEP |
| `docs/` | Документация (см. [docs/README.md](docs/README.md)) |

---

## Известные ограничения

- Pre-compositions (nested comps) — не поддерживаются (workaround: flatten / "Move all attributes").
- 3D layers / Cameras / Lights — не поддерживаются.
- Time remapping, Motion Blur, Frame Blending — не экспортируются.
- Эффекты вне списка `Fill / Drop Shadow / Gaussian Blur / Invert / Brightness & Contrast / Hue/Saturation / Tint` — игнорируются с warning.

Полный список — в таблице внутри панели и в [docs/html-export-spec.md](docs/html-export-spec.md).

---

## Документация

[docs/README.md](docs/README.md) — индекс документации.
