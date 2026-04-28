;(function () {
  'use strict'

  // ── Boot error handler ─────────────────────────────────────────────────
  function showBootError (err, context) {
    try {
      var msg = (err && err.stack) ? String(err.stack) : (err && err.message ? String(err.message) : String(err))
      var header = '[Cloud.ru Motion Export] Panel error' + (context ? ' (' + context + ')' : '')
      if (typeof console !== 'undefined' && console.error) console.error(header, err)
      if (typeof document === 'undefined' || !document.body) return
      document.body.innerHTML = ''
      document.body.style.cssText = 'margin:0;padding:8px;background:#1f1f1f;color:#ffd2d2;font:11px Menlo,monospace'
      var pre = document.createElement('pre')
      pre.textContent = header + '\n\n' + msg
      document.body.appendChild(pre)
    } catch (_) {}
  }

  try {
    if (typeof window !== 'undefined') {
      window.addEventListener('error', function (e) { showBootError(e.error || new Error(e.message), 'window.error') })
      window.addEventListener('unhandledrejection', function (e) { showBootError(e.reason || new Error('Unhandled rejection'), 'unhandledrejection') })
    }
  } catch (_) {}

  // ── State ──────────────────────────────────────────────────────────────
  var state = {
    isExportInFlight: false,
    toolLog: []
  }

  // ── DOM refs ───────────────────────────────────────────────────────────
  var els = {}

  function cacheDomRefs () {
    els.exportFormatSelect = document.getElementById('export-format-select')
    els.exportName = document.getElementById('export-name')
    els.exportOutDir = document.getElementById('export-out-dir')
    els.exportBrowseBtn = document.getElementById('export-browse-btn')
    els.exportRunBtn = document.getElementById('export-run-btn')
    els.exportStatus = document.getElementById('export-status')
    els.exportHintsFormat = document.getElementById('export-hints-format')
    els.toolLog = document.getElementById('tool-log')
  }

  // ── Tool log ──────────────────────────────────────────────────────────
  function addToolLogEntry (name, status, msg) {
    var now = new Date()
    var timeStr = String(now.getHours()).padStart(2, '0') + ':' +
      String(now.getMinutes()).padStart(2, '0') + ':' +
      String(now.getSeconds()).padStart(2, '0')
    state.toolLog.push({ time: timeStr, name: name, status: status, msg: msg || '' })
    if (state.toolLog.length > 200) state.toolLog = state.toolLog.slice(-200)
    renderToolLog()
  }

  function renderToolLog () {
    if (!els.toolLog) return
    var entries = state.toolLog.slice(-100)
    var html = ''
    for (var i = entries.length - 1; i >= 0; i--) {
      var e = entries[i]
      var cls = 'tool-log-entry tool-log-' + (e.status || 'info')
      html += '<div class="' + cls + '"><span class="tool-log-time">' + e.time + '</span>' +
        '<span class="tool-log-name">' + escapeHtml(e.name) + '</span>' +
        '<span class="tool-log-msg">' + escapeHtml(e.msg) + '</span></div>'
    }
    els.toolLog.innerHTML = html
  }

  function escapeHtml (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  // ── Export tab handlers ────────────────────────────────────────────────
  var EXPORT_FORMAT_HINTS = {
    'css-svg': 'CSS + SVG: нулевые зависимости, лучший выбор для 150 KB баннеров. Поддерживает: transform/opacity keyframes (cubic-bezier + step-end для hold), gradient fills (linear/radial), shape primitives (rect/ellipse/polystar + round corners + trim paths + dashes + multi-fill/stroke + per-group transform + repeater), track mattes (alpha/luma + inverted), parent chain composition, curved motion (spatial bezier), auto-orient, separate dimensions, animated эффекты (drop-shadow/blur/brightness/hue/saturation/tint), масок (clipPath/mask + feather + expansion), текст (+ text-on-path + per-char stagger).',
    'gsap-svg': 'GSAP + SVG: точный timeline-контроль, staggers, сложные easing. ~18 KB gzipped. Для Яндекс/VK — инлайньте gsap.min.js вместо CDN. Feature coverage — аналогично CSS+SVG для геометрии; timeline использует GSAP API.',
    'json-raw': 'Raw JSON: дамп извлечённого compData без генерации HTML. Полезен для intermediate representation, диффов между прогонами, или для чтения в другом инструменте.',
    'lottie-json': 'Lottie JSON (bodymovin schema v5.7): shape (rect/ellipse/polystar/path) + solid fill/stroke + transform + easing bezier + spatial tangents. Verified against lottie-web 5.12 runtime — 8/8 shape тест-кейсов рендерятся корректно. НЕ мапятся: gradients (используется first stop color как solid), CSS filters/effects, masks, track mattes, repeater, text animators. Text: структура экспортируется, но lottie-web требует отдельной регистрации шрифтов для рендера. Для полного feature-parity → CSS+SVG.'
  }

  function updateExportFormatHint () {
    if (!els.exportHintsFormat || !els.exportFormatSelect) return
    var fmt = els.exportFormatSelect.value
    var txt = EXPORT_FORMAT_HINTS[fmt] || ''
    els.exportHintsFormat.textContent = txt
  }

  function setExportStatus (msg, kind) {
    if (!els.exportStatus) return
    els.exportStatus.textContent = msg
    els.exportStatus.classList.remove('ok', 'error', 'working')
    if (kind) els.exportStatus.classList.add(kind)
  }

  function handleExportBrowse () {
    if (!window.HOST_BRIDGE || typeof window.HOST_BRIDGE.evalHostFunction !== 'function') {
      setExportStatus('Host bridge unavailable — enter the path manually.', 'error')
      return
    }
    var current = (els.exportOutDir && els.exportOutDir.value) || ''
    var arg = JSON.stringify(current)
    setExportStatus('Opening folder picker...', 'working')
    window.HOST_BRIDGE.evalHostFunction('motionExport_selectExportFolder(' + arg + ')')
      .then(function (res) {
        if (res && res.ok && res.path) {
          if (els.exportOutDir) els.exportOutDir.value = res.path
          setExportStatus('Selected: ' + res.path, 'ok')
          return
        }
        if (res && res.cancelled) {
          setExportStatus('Picker cancelled', '')
          return
        }
        setExportStatus('Folder picker failed — enter path manually.', 'error')
      })
      .catch(function (err) {
        setExportStatus('Folder picker error: ' + (err && err.message ? err.message : String(err)), 'error')
      })
  }

  function writeExportFiles (outDir, files) {
    var fs = require('fs')
    var path = require('path')
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
    var written = []
    for (var i = 0; i < files.length; i++) {
      var full = path.join(outDir, files[i].name)
      var parentDir = path.dirname(full)
      if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true })
      if (files[i].copyFrom) {
        if (!fs.existsSync(files[i].copyFrom)) {
          throw new Error('Missing source asset: ' + files[i].copyFrom)
        }
        fs.copyFileSync(files[i].copyFrom, full)
      } else {
        fs.writeFileSync(full, files[i].content, 'utf8')
      }
      written.push(full)
    }
    return written
  }

  function handleExportRun () {
    if (state.isExportInFlight) {
      setExportStatus('Another operation is in progress. Wait for it to finish.', 'error')
      return
    }
    if (!window.HOST_BRIDGE || typeof window.HOST_BRIDGE.evalHostFunction !== 'function') {
      setExportStatus('Host bridge unavailable.', 'error')
      return
    }
    if (!window.HtmlExporter || typeof window.HtmlExporter.generate !== 'function') {
      setExportStatus('HtmlExporter module not loaded.', 'error')
      return
    }
    var format = els.exportFormatSelect ? els.exportFormatSelect.value : 'css-svg'
    var outDir = els.exportOutDir ? String(els.exportOutDir.value || '').replace(/^\s+|\s+$/g, '') : ''
    var name = els.exportName ? String(els.exportName.value || '').replace(/^\s+|\s+$/g, '') : ''
    if (!outDir) {
      setExportStatus('Select an output directory first.', 'error')
      return
    }
    state.isExportInFlight = true
    setExportStatus('Extracting composition from AE...', 'working')
    window.HOST_BRIDGE.evalHostFunction('motionExport_extractCompForHtml()')
      .then(function (compData) {
        if (!compData || !compData.ok) {
          var msg = (compData && compData.message) || 'Host extraction failed'
          setExportStatus('Extract failed: ' + msg, 'error')
          return null
        }
        if (!name) name = compData.comp && compData.comp.name ? compData.comp.name : 'animation'
        setExportStatus('Generating ' + format + ' artifact...', 'working')
        var result = window.HtmlExporter.generate(format, compData, { name: name })
        if (!result || !result.files || result.files.length === 0) {
          setExportStatus('Generator returned no files.', 'error')
          return null
        }
        try {
          var written = writeExportFiles(outDir, result.files)
          var warnMsg = result.warnings && result.warnings.length ? ' (warnings: ' + result.warnings.length + ')' : ''
          setExportStatus('Wrote ' + written.length + ' file(s) → ' + written[0] + warnMsg, 'ok')
          if (result.warnings && result.warnings.length) {
            for (var wi = 0; wi < result.warnings.length; wi++) {
              addToolLogEntry('html-export', 'warn', result.warnings[wi])
            }
          }
          addToolLogEntry('html-export', 'ok', 'Wrote ' + written.length + ' file(s) to ' + outDir)
          return result
        } catch (writeErr) {
          setExportStatus('File write failed: ' + (writeErr && writeErr.message ? writeErr.message : String(writeErr)), 'error')
          addToolLogEntry('html-export', 'error', String(writeErr))
          return null
        }
      })
      .catch(function (err) {
        setExportStatus('Export error: ' + (err && err.message ? err.message : String(err)), 'error')
        addToolLogEntry('html-export', 'error', String(err))
      })
      .then(function () {
        state.isExportInFlight = false
      })
  }

  // ── Bind events ────────────────────────────────────────────────────────
  function bindEvents () {
    if (els.exportBrowseBtn) els.exportBrowseBtn.addEventListener('click', handleExportBrowse)
    if (els.exportRunBtn) els.exportRunBtn.addEventListener('click', handleExportRun)
    if (els.exportFormatSelect) els.exportFormatSelect.addEventListener('change', updateExportFormatHint)
  }

  // ── Init ───────────────────────────────────────────────────────────────
  function init () {
    cacheDomRefs()
    bindEvents()
    updateExportFormatHint()
    setExportStatus('Ready')
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
