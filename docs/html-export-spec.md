# HTML / GSAP / Lottie / Raw JSON exporter — спецификация

CEP-панель After Effects, которая читает активную композицию и пишет её в один из четырёх web-форматов. Документ описывает покрытие AE-фич, mapping и edge-cases.

## UI Flow

1. Пользователь собирает анимацию в AE.
2. Открывает панель **Cloud.ru Motion Export** (Window → Extensions).
3. Выбирает **Format**: CSS+SVG (zero-dep) / GSAP+SVG (timeline) / Lottie JSON (bodymovin v5.7) / Raw JSON (дамп).
4. Опционально правит **Animation name** (по умолчанию — имя композиции).
5. **Browse** — нативный `Folder.selectDialog`, выбирает выходную папку.
6. **Export** — пайплайн: `motionExport_extractCompForHtml` (host) → `HtmlExporter.generate` (client) → `fs.writeFileSync` в выбранную папку.
7. Статус-линия показывает результат (ok/error/working) с полным путём.
8. Export Log собирает warnings (expression / effect / blend-mode / mask), которые не переносятся в выходной артефакт.

### Файлы реализации

| Файл | Назначение |
|---|---|
| `index.html` | разметка панели: form controls, таблица feature-coverage, status, log |
| `styles.css` | стили панели (`.export-panel`, `.export-status.ok/.error/.working`, `.tool-log`) |
| `main.js` | UI runtime: `cacheDomRefs`, `handleExportBrowse`, `handleExportRun`, `updateExportFormatHint`, `writeExportFiles`, `setExportStatus` |
| `htmlExporter.js` | `window.HtmlExporter.generate(format, compData, opts)` — генераторы css-svg / gsap-svg / lottie-json / json-raw |
| `host/index.jsx` | `motionExport_extractCompForHtml()` + `motionExport_selectExportFolder()` |

### Реализовано (HTML ↔ AE fidelity — что переносится)

- **Размеры композиции + viewBox с hard-clip**: `<svg viewBox>` + `<clipPath>` + `overflow="hidden"` — контент вне комп-размеров обрезается даже в lenient-рендерерах (QuickLook, старые WebView).
- **Transform**: position / scale / rotation / opacity — keyframes с per-stop cubic-bezier easing (сохраняет AE speed+influence).
- **Expression-driven tracks** запекаются в keyframes с частотой comp.frameRate (cap 30fps, max 600 сэмплов на свойство).
- **Layer timing**: `animation-delay` = `inPoint`, `animation-duration` = `outPoint - inPoint`, `animation-fill-mode: both` — слой "существует" только в своём активном диапазоне.
- **Blend modes** → `mix-blend-mode`: normal / multiply / screen / overlay / darken / lighten / color-dodge / color-burn / hard-light / soft-light / difference / exclusion / hue / saturation / color / luminosity. Add / Linear Dodge → fallback на `screen`. AE-specific (Stencil/Silhouette Alpha, Alpha Add, Luminescent Premul) — warning, fallback на normal.
- **AV-слои**: footage-изображения и видео копируются в `assets/` рядом с HTML, эмитятся через `<image>` / `<foreignObject><video>`. Solid-слои эмитятся как `<rect fill>`.
- **Anchor point**: статическое значение из `ADBE Anchor Point`, offset применяется на inner-shape так что rotate/scale работают корректно для footage с центральным anchor.
- **Text-слои**: `<text>` с font-family, font-size, fill, justification, **stroke** (applyStroke + strokeColor + strokeWidth + paint-order через strokeOverFill), faux bold/italic (`font-weight`/`font-style`), letter-spacing из `tracking`.
- **Shape-слои**: rect / ellipse / bezier path с:
  - Fill color + fill-opacity
  - **Stroke**: color, width, opacity, line-cap (butt/round/square), line-join (miter/round/bevel)
- **Masks (Mask Parade) — lottie-web pattern, multi-mask composition**:
  - Все маски слоя композируются в единое определение: `<clipPath>` если все маски Add/opaque/static (fast-path), иначе `<mask>` с альфа-композицией.
  - **Координатная система**: mask path emits в layer-local пространстве без wrapping `<g transform>` — SVG применяет mask-attribute до transform родительского `<g>`, так что координаты маски автоматически совпадают с layer content (см. lottie-web `mask.js`).
  - **Add mode**: white path → reveal (add).
  - **Subtract mode**: comp-size white rect base + black path punch-out.
  - **Inverted flag**: comp-size white rect base + path в противоположном цвете mode-а.
  - **Multi-mask**: любая комбинация Add + Subtract + Inverted композируется корректно в один `<mask>`.
  - **Mask Shape animation**: SMIL `<animate attributeName="d" values=... keyTimes=... dur begin repeatCount="indefinite">`.
  - **Mask Opacity**: `fill-opacity` на path (static + animated через SMIL).
  - **Mask Feather**: SVG `<feGaussianBlur stdDeviation="feather/2">` внутри `<filter>` applied на path.
  - **Mask Expansion (static)**: SVG `<feMorphology operator="erode|dilate" radius="...">` — геометрический inset/outset.
  - **Mask Expansion (animated)**: fade-approximation через `fill-opacity` (per-frame feMorphology — roadmap).
  - **Works for ALL layer types**: text/shape/av/solid/null (layer-type-agnostic).
  - **Baseline-aligned text** (critical for text masks): `y="0"` + `dominant-baseline="alphabetic"` — AE text layer-space y=0 = baseline, так же как AE mask vertices. Автоматическое выравнивание без font-ascent compensation.
  - **Simplified modes**: Intersect/Lighten/Darken/Difference downgrade до Add с warning (lottie тоже не реализует Darken/Lighten/Difference).
- **Effects (recognized, 7 типов):**
  - **ADBE Fill** — цвет заливки слоя (override shape/text fill). Анимированный цвет эмитится как `@keyframes { fill: #color }` на inner shape element, синхронно с layer-таймингом.
  - **ADBE Drop Shadow** — CSS `filter: drop-shadow(dx dy softness rgba)`. AE direction (0°=up, clockwise) конвертируется в dx/dy; opacity → alpha канал. **Static first-frame** (animation — roadmap).
  - **ADBE Gaussian Blur / Gaussian Blur 2** — CSS `filter: blur(Xpx)`. Static first-frame.
  - **ADBE Invert** — CSS `filter: invert(100%)`.
  - **ADBE Brightness & Contrast (2)** — CSS `filter: brightness(X) contrast(Y)`. AE range −100..+100 → CSS 0..2 factor.
  - **ADBE HUE SATURATION** — CSS `filter: hue-rotate(Xdeg) saturate(Y)` + опционально `brightness(Z)` для lightness.
  - **ADBE Tint** — approximate через `filter: grayscale(A) sepia(A) hue-rotate(Hdeg)` (рассчитано из target white hue). Exact Black→White mapping требует SVG `<feColorMatrix>` (roadmap).
  - Несколько recognized effects стакаются в одном `filter:` пропе.
- **Disabled layers** (eye-off): пропускаются при экспорте.
- **Layer parenting**: `parentIndex` извлекается и логируется в diagnostic comment, **композиция transform НЕ применяется** (warning в Tool Log). Pre-compose родителя в AE перед экспортом для работоспособности.
- **Pixel Aspect Ratio**: `comp.pixelAspect` извлекается и отображается в диагностике; CSS-stretch для non-square — deferred (редкий кейс для web/banner).
- **Diagnostic HTML comment** в начале файла: комп (name, w×h, fps, duration, bg), per-layer сводка (имя, тип, in/out, tracks, blend mode) — для быстрой проверки что экстрактор увидел.
- **Diagnostic JSON (`<name>.diagnostic.json`)** рядом с HTML: structured dump для reproducible diffs:
  - `comp` — все метаданные (name, width, height, duration, frameRate, pixelAspect, bgColor)
  - `summary` — derived counts: `layersTotal`, `bakedExpressions`, `totalTransformKeyframes`, `effectsRecognized: {fill, dropShadow, blur, invert, brightnessContrast, hueSaturation, tint}`, `blendModes: {...}`, `masks: {total, withAnimatedShape, withAnimatedOpacity, withAnimatedExpansion, inverted}`, `parentedLayers`
  - `layers[]` — per-layer compact data (index, name, type, in/out, enabled, blendMode, parentIndex, tracks counts, likelyBakedExpression, masks[], effects{})
  - `warnings[]` — все сгенерированные warnings
  - `raw.layers[]` — полные raw data (каждый keyframe с t, v, ei, eo, iType, oType), для byte-level diffing
  - **Использование:** открыть оба файла (AE-export-A.diagnostic.json vs AE-export-B.diagnostic.json), сравнить через `diff` или любой JSON-differ — сразу видно что изменилось между экспортами. При жалобе на "что-то не так" можно попросить прислать `.diagnostic.json` вместо пояснений на пальцах.
- **Asset dedupe**: если N слоёв ссылаются на один файл, копируется 1 раз.
- **Detеrministic output**: никаких `Date.now` / `Math.random` в сгенерированном коде.

### Архитектурные пробелы (известные limitations)

После roadmap-проходов P1-P4 большинство прежних gaps закрыто. Что всё ещё не экспортируется:

- **Pre-compositions (nested comps)** — пропускаются полностью (`continue` в loop). *Workaround:* flatten до экспорта через Layer → Pre-compose или превратить precomp в основную comp.
- **Unsupported effects**: Glow, Fractal Noise, Lumetri Color, Levels, Curves, Stroke (отдельный effect, не путать с Shape Stroke), Gradient Ramp, Color Balance, Channel Mixer, CC* effects, 3rd-party plugins и всё остальное кроме 7 recognized (Fill / Drop Shadow / Gaussian Blur / Invert / Brightness & Contrast / Hue/Saturation / Tint). Warnings логируются.
- **Masks: Intersect/Lighten/Darken/Difference modes** — downgraded до Add при композиции. Add/Subtract/Inverted/Feather/Expansion полноценно поддерживаются.
- **Text animators: полная Range Selector математика** — стагер-MVP реализован (per-char `<tspan>` с staggered opacity keyframes), но shape / smoothness / inter-selector composition не учитываются.
- **Per-group animated transforms** — статический snapshot на t=0 (animated Vector Group Transform — roadmap).
- **Repeater: keyframed copies/offset/transform** — bake статичный на t=0 (animated Repeater — roadmap).
- **Animated anchor point** — извлекается один статический snapshot.
- **3D layers** → flattened to 2D; camera / light layers — игнорируются.
- **Time remapping** — не поддерживается.
- **Non-square pixel aspect ratio** — не учитывается (предполагается 1.0).
- **Motion blur / frame blending** — недоступно в CSS/SVG без дорогостоящей симуляции.
- **Font embedding**: используется web-font fallback. Для SBSans требуется либо пользователь добавляет `@font-face` с WOFF2, либо outline-to-path вручную.

### Что добавлено в итерации P1–P4 (из lottie-web / AE2Canvas / project-Cue audit)

- **Layer parenting chain composition**: полностью композируется multi-level parenting → композированная матрица per keyframe time.
- **Track Mattes**: Alpha / Inverted Alpha / Luma / Inverted Luma — через SVG `<mask>` с `mask-type`+filter.
- **Separate Dimensions (Position X / Y)** — union time points, независимый easing per axis.
- **Auto-orient (Along Path)** — rotation от position velocity через `atan2`.
- **Spatial Bezier (curved motion paths)** — 6 intermediate samples per bezier segment при non-zero spatial tangents.
- **Per-group Transform** (Vector Group's own Transform) — nested `<g transform="matrix(...)">` wrapping.
- **Shape multi-fill / multi-stroke stacking** — все Fill/Stroke в Contents стекаются в AE paint-order.
- **Gradient fills / strokes** (linear + radial) — SVG `<linearGradient>`/`<radialGradient>` в `<defs>` с per-stop colors.
- **Trim Paths** — `pathLength=100` + `stroke-dasharray`/`stroke-dashoffset` (стороны start/end/offset).
- **Stroke dash patterns** — `stroke-dasharray`/`stroke-dashoffset` attributes.
- **Polystar** (polygon + star) — cubic-bezier path math.
- **Round Corners** — rx/ry on rects, bezier recompute on paths.
- **Repeater** — N `<use>` clones с cumulative transform + linear opacity ramp.
- **Text on Path** — SVG `<textPath href>` ссылается на mask path.
- **Text animators (per-char stagger MVP)** — per-character `<tspan>` с staggered opacity animation.
- **Animated Drop Shadow / Blur / B&C / Hue-Sat / Tint** — union keyframe times → filter @keyframes.
- **Ease-and-Wizz palette** — 25 Penner easings доступны как `HtmlExporter.easings`.
- **Lottie JSON (bodymovin) export format** — MVP mapping для shapes + text + transforms + keyframe easing.

### Operational-детали

- GSAP-формат подгружается с CDN (cdnjs). Для Яндекс/VK-баннеров ≤150 KB пользователь вручную заменяет `<script src=...>` на инлайн-bundle (warning в диагностике).
- ZIP-packaging для баннеров с per-size вариантами не реализован — roadmap.
- Solid-цвет и comp.bgColor берутся напрямую из AE `SolidSource.color` / `CompItem.bgColor` (массив [r,g,b] в 0..1 → hex).
- Все AV-слои (и image, и video) попадают в `assets/`; `<video>` получает `autoplay muted loop playsinline`.
