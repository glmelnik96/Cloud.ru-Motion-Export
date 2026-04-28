/**
 * HtmlExporter — client-side generator that converts comp data extracted by
 * motionExport_extractCompForHtml() into runnable HTML artifacts.
 *
 * Public API (attached to window):
 *   HtmlExporter.generate(format, compData, opts) →
 *     { html: string, files: [{name, content, copyFrom?}], warnings: [string] }
 *
 * Supported formats:
 *   - "css-svg"   : pure CSS @keyframes + inline SVG (zero JS deps, lightest, banner-safe)
 *   - "gsap-svg"  : GSAP timeline controlling inline SVG (via cdnjs reference)
 *   - "json-raw"  : raw comp-data JSON dump
 *
 * All generators are idempotent: same compData + opts → same output.
 * Timestamps and random numbers are never emitted into generated code.
 */
;(function () {
  'use strict'

  // ─── Helpers ──────────────────────────────────────────────────────────

  function escapeHtml (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function escapeCss (s) {
    return String(s == null ? '' : s).replace(/[^a-zA-Z0-9_-]/g, '_')
  }

  function slugify (s) {
    return String(s || 'animation').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'animation'
  }

  // P3.2: Spatial-bezier interpolation for position keyframes with non-zero to/ti tangents.
  // Cubic Bezier control pts: P0=A.v, P1=A.v+A.to, P2=B.v+B.ti, P3=B.v.
  // Falls back to linear when no tangents present; returns vec2 in comp coords.
  function hasSpatialTangent (kf) {
    if (!kf) return false
    var s = 0
    if (kf.to) s += Math.abs(kf.to[0] || 0) + Math.abs(kf.to[1] || 0)
    if (kf.ti) s += Math.abs(kf.ti[0] || 0) + Math.abs(kf.ti[1] || 0)
    return s > 1e-3
  }
  function interpPositionSpatial (kfs, t) {
    if (!kfs || kfs.length === 0) return null
    if (t <= kfs[0].t) return kfs[0].v
    if (t >= kfs[kfs.length - 1].t) return kfs[kfs.length - 1].v
    for (var i = 0; i < kfs.length - 1; i++) {
      var A = kfs[i], B = kfs[i + 1]
      if (t >= A.t && t <= B.t) {
        if (B.t === A.t) return A.v
        if (A.oType === 'hold' || B.iType === 'hold') return A.v
        var u = (t - A.t) / (B.t - A.t)
        var toA = A.to || [0, 0, 0]
        var tiB = B.ti || [0, 0, 0]
        var hasT = Math.abs(toA[0] || 0) + Math.abs(toA[1] || 0) + Math.abs(tiB[0] || 0) + Math.abs(tiB[1] || 0) > 1e-3
        if (!hasT) return lerp(A.v, B.v, u)
        var P0 = A.v, P3 = B.v
        var P1 = [P0[0] + (toA[0] || 0), P0[1] + (toA[1] || 0)]
        var P2 = [P3[0] + (tiB[0] || 0), P3[1] + (tiB[1] || 0)]
        var oU = 1 - u
        var x = oU * oU * oU * P0[0] + 3 * oU * oU * u * P1[0] + 3 * oU * u * u * P2[0] + u * u * u * P3[0]
        var y = oU * oU * oU * P0[1] + 3 * oU * oU * u * P1[1] + 3 * oU * u * u * P2[1] + u * u * u * P3[1]
        return [x, y]
      }
    }
    return kfs[kfs.length - 1].v
  }

  // Convert a keyframe to a value at time t (linear interp between keyframes).
  // For scalars (opacity, rotation) kv is number; for vec2/3 (position, scale) it's array.
  function interpValue (kfs, t) {
    if (!kfs || kfs.length === 0) return null
    if (t <= kfs[0].t) return kfs[0].v
    if (t >= kfs[kfs.length - 1].t) return kfs[kfs.length - 1].v
    for (var i = 0; i < kfs.length - 1; i++) {
      var a = kfs[i], b = kfs[i + 1]
      if (t >= a.t && t <= b.t) {
        if (b.t === a.t) return a.v
        var u = (t - a.t) / (b.t - a.t)
        if (a.oType === 'hold' || b.iType === 'hold') return a.v
        return lerp(a.v, b.v, u)
      }
    }
    return kfs[kfs.length - 1].v
  }

  function lerp (a, b, u) {
    if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * u
    if (Array.isArray(a) && Array.isArray(b)) {
      var out = []
      for (var i = 0; i < Math.min(a.length, b.length); i++) out.push(a[i] + (b[i] - a[i]) * u)
      return out
    }
    return u < 0.5 ? a : b
  }

  // Convert AE influence-in, influence-out to a CSS cubic-bezier(x1,y1,x2,y2).
  // AE uses speed+influence; for HTML export we approximate using influence-only mapping.
  // out (keyframe A) drives the curve exit; in (keyframe B) drives the entry.
  function influenceToBezier (outInf, inInf) {
    var o = (outInf == null ? 33.3 : Number(outInf)) / 100
    var i = (inInf == null ? 33.3 : Number(inInf)) / 100
    if (o < 0) o = 0; if (o > 1) o = 1
    if (i < 0) i = 0; if (i > 1) i = 1
    var x1 = o.toFixed(3)
    var y1 = (0).toFixed(3)
    var x2 = (1 - i).toFixed(3)
    var y2 = (1).toFixed(3)
    return 'cubic-bezier(' + x1 + ',' + y1 + ',' + x2 + ',' + y2 + ')'
  }

  function round3 (n) {
    if (typeof n !== 'number' || isNaN(n)) return 0
    return Math.round(n * 1000) / 1000
  }

  function roundArr (a) {
    if (!Array.isArray(a)) return a
    var out = []
    for (var i = 0; i < a.length; i++) out.push(round3(a[i]))
    return out
  }

  // ─── 2D affine matrix helpers (P3.3 parent chain) ─────────────────────
  // SVG matrix(a,b,c,d,e,f) = [[a,c,e],[b,d,f],[0,0,1]]
  function matIdent () { return [1, 0, 0, 1, 0, 0] }
  function matMul (m1, m2) {
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
    ]
  }
  function matTranslate (tx, ty) { return [1, 0, 0, 1, tx, ty] }
  function matRotate (deg) {
    var r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r)
    return [c, s, -s, c, 0, 0]
  }
  function matScale (sx, sy) { return [sx, 0, 0, sy, 0, 0] }
  // Build a layer's LOCAL transform matrix at time t (anchor-relative).
  // AE semantics: world point of anchor = position. So local = T(pos)·R(rot)·S(scale)·T(-anchor).
  function localMatrixAt (layer, t) {
    var pos = interpPositionSpatial(layer.transform.position, t) || [0, 0]
    var sc = interpValue(layer.transform.scale, t) || [100, 100]
    var rt = interpValue(layer.transform.rotation, t) || 0
    var anchor = (layer.anchor && layer.anchor.length >= 2) ? layer.anchor : [0, 0]
    var sx, sy
    if (Array.isArray(sc) && sc.length >= 2) { sx = sc[0] / 100; sy = sc[1] / 100 }
    else { sx = (Number(sc) || 100) / 100; sy = sx }
    var rtd = typeof rt === 'number' ? rt : (Array.isArray(rt) ? rt[0] : 0)
    if (layer.autoOrient) {
      var EPS = 1e-3
      var pp = interpPositionSpatial(layer.transform.position, Math.max(0, t - EPS)) || pos
      var pn = interpPositionSpatial(layer.transform.position, t + EPS) || pos
      var ddx = pn[0] - pp[0], ddy = pn[1] - pp[1]
      if (Math.abs(ddx) > 1e-4 || Math.abs(ddy) > 1e-4) rtd += Math.atan2(ddy, ddx) * 180 / Math.PI
    }
    var M = matTranslate(pos[0], pos[1])
    M = matMul(M, matRotate(rtd))
    M = matMul(M, matScale(sx, sy))
    M = matMul(M, matTranslate(-anchor[0], -anchor[1]))
    return M
  }
  // Look up parent layer by its AE 1-based index.
  function findLayerByAeIndex (layers, aeIdx) {
    for (var i = 0; i < layers.length; i++) if (layers[i].index === aeIdx) return layers[i]
    return null
  }
  // Walk parent chain, compose world matrix by (root→down) multiplication.
  // Guard against cycles with a hop cap.
  function composedMatrixAt (layer, t, layers) {
    var chain = []
    var cur = layer
    var hops = 0
    while (cur && hops < 32) {
      chain.push(cur)
      if (cur.parentIndex == null) break
      cur = findLayerByAeIndex(layers, cur.parentIndex)
      hops++
    }
    // chain[0] = this layer, chain[N-1] = root. Multiply root → leaf.
    var M = matIdent()
    for (var i = chain.length - 1; i >= 0; i--) {
      M = matMul(M, localMatrixAt(chain[i], t))
    }
    return M
  }
  // Composed opacity = product of chain opacities (AE multiplies parent & child opacities).
  function composedOpacityAt (layer, t, layers) {
    var cur = layer, o = 1, hops = 0
    while (cur && hops < 32) {
      var lo = interpValue(cur.transform.opacity, t)
      if (lo == null) lo = 100
      o *= (typeof lo === 'number' ? lo : 100) / 100
      if (cur.parentIndex == null) break
      cur = findLayerByAeIndex(layers, cur.parentIndex)
      hops++
    }
    return o
  }
  function matToCss (m) {
    return 'matrix(' + round3(m[0]) + ', ' + round3(m[1]) + ', ' + round3(m[2]) + ', ' +
      round3(m[3]) + ', ' + round3(m[4]) + ', ' + round3(m[5]) + ')'
  }

  // Pre-compute layer-local anchor for SVG placement.
  // We center each layer's first position as its translate anchor, using comp dimensions.
  function resolvePos (kfs, fallbackW, fallbackH) {
    if (!kfs || kfs.length === 0) return [fallbackW / 2, fallbackH / 2]
    var v = kfs[0].v
    if (Array.isArray(v) && v.length >= 2) return [v[0], v[1]]
    return [fallbackW / 2, fallbackH / 2]
  }

  // ─── Generators ───────────────────────────────────────────────────────

  function emptyGenerate (msg) {
    return {
      html: '<!-- ' + escapeHtml(msg) + ' -->',
      files: [],
      warnings: [msg]
    }
  }

  // Unique asset name (preserving extension) for a media layer so multiple
  // layers referencing the same source still get written once (we dedupe by path).
  function mediaAssetName (layer, idx, seenPathToName) {
    var media = layer.extras && layer.extras.media
    if (!media) return null
    var path = media.path || ''
    if (seenPathToName[path]) return seenPathToName[path]
    var base = (media.fileName || ('asset-' + idx)).replace(/[^a-zA-Z0-9._-]/g, '_')
    // If duplicate basename across different paths, prefix with index
    var final = base
    for (var key in seenPathToName) {
      if (seenPathToName.hasOwnProperty(key) && seenPathToName[key] === final) {
        final = idx + '_' + base
        break
      }
    }
    seenPathToName[path] = final
    return final
  }

  // Build an SVG <mask> definition from an AE mask (static or animated shape).
  // Animation uses SMIL <animate attributeName="d"> which syncs with the layer's
  // CSS animation via matching dur/begin.
  // Build an SVG <mask> that correctly positions the mask path in the target layer's
  // coordinate space. AE mask vertices are in LAYER space; if we used maskUnits=userSpaceOnUse
  // with the path as-is, it would appear at root SVG origin (0,0), not where the layer is
  // transformed to. We wrap the path in <g transform="translate(initPos)"> to align it with
  // the target's rendered location.
  //
  // Supports: inverted masks (full-viewBox white + path black), Mask Feather (feGaussianBlur),
  // Mask Opacity (static + animated), animated Mask Shape (SMIL <animate attributeName="d">).
  // Animated layer transforms are NOT propagated to the mask — MVP uses initPos as a static
  // offset, which is correct for static layers and approximated for animated.
  // ── Mask building (lottie-web inspired) ──────────────────────────────
  // Architecture (lottie-web mask.js:36-42 bucket rule):
  //   • Pure ADD mode + opacity=100 + not inverted + expansion=0 (static) → <clipPath> (fast)
  //   • Anything else (Subtract/Intersect/Lighten/Darken/Difference, inverted, opacity<100
  //     or keyframed, expansion or feather) → <mask> (slower but full-featured)
  //   Multi-mask: compose into ONE <mask> element with sub-paths per mode.
  //   Works for ALL layer types (text / shape / av / solid / null) because the <g>-based
  //   wrapping is layer-type-agnostic.

  // Build a single <path> element representing a mask's shape keyframes (optionally animated),
  // with optional SMIL <animate> for fill-opacity (opacity keyframes + expansion reveal approx).
  function buildMaskPath (mask, layerIn, layerDur, fillColor, filterAttr) {
    var shapeKeys = mask.shapeKeys || []
    if (shapeKeys.length === 0) return ''
    var baseOp = Math.max(0, Math.min(1, (mask.opacity == null ? 100 : mask.opacity) / 100))
    // Base path: either static d= or SMIL <animate attributeName="d">.
    var pathOpen, pathClose
    if (shapeKeys.length === 1) {
      pathOpen = '<path d="' + shapeKeys[0].d + '" fill="' + fillColor + '" fill-opacity="' + baseOp + '"' + (filterAttr || '') + '>'
      pathClose = '</path>'
    } else {
      var values = []
      var keyTimes = []
      for (var k = 0; k < shapeKeys.length; k++) {
        values.push(shapeKeys[k].d)
        var rel = layerDur > 0 ? ((shapeKeys[k].t - layerIn) / layerDur) : 0
        if (rel < 0) rel = 0
        if (rel > 1) rel = 1
        keyTimes.push(rel.toFixed(4))
      }
      if (keyTimes[0] !== '0.0000') { keyTimes.unshift('0.0000'); values.unshift(values[0]) }
      if (keyTimes[keyTimes.length - 1] !== '1.0000') {
        keyTimes.push('1.0000'); values.push(values[values.length - 1])
      }
      pathOpen = '<path fill="' + fillColor + '" fill-opacity="' + baseOp + '"' + (filterAttr || '') + '>' +
        '<animate attributeName="d" values="' + values.join(';') + '" keyTimes="' + keyTimes.join(';') +
        '" dur="' + layerDur.toFixed(3) + 's" begin="' + layerIn.toFixed(3) + 's" repeatCount="indefinite"/>'
      pathClose = '</path>'
    }
    // Optional animated fill-opacity: combines mask opacity animation + expansion-reveal approx.
    // Built as a single merged keyTimes/values series so the two don't fight over the same attribute.
    var fillOpAnim = ''
    var opAnimated = mask.opacityKeys && mask.opacityKeys.length > 1
    var expAnimated = mask.expansionKeys && mask.expansionKeys.length > 1
    if (opAnimated || expAnimated) {
      // Collect union time set (seconds in layer-local).
      var timeSet = {}
      if (opAnimated) for (var oi = 0; oi < mask.opacityKeys.length; oi++) timeSet[mask.opacityKeys[oi].t] = true
      if (expAnimated) for (var xi = 0; xi < mask.expansionKeys.length; xi++) timeSet[mask.expansionKeys[xi].t] = true
      var times = []
      for (var kt in timeSet) if (timeSet.hasOwnProperty(kt)) times.push(Number(kt))
      times.sort(function (a, b) { return a - b })
      // Sample opacity and expansion at each union time (step-hold interp since we use AE's raw types).
      function sample (keys, t) {
        if (!keys || keys.length === 0) return null
        if (t <= keys[0].t) return keys[0].v
        if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].v
        for (var i = 0; i < keys.length - 1; i++) {
          var a = keys[i], b = keys[i + 1]
          if (t >= a.t && t <= b.t) {
            if (a.oType === 'hold' || b.iType === 'hold' || b.t === a.t) return a.v
            var u = (t - a.t) / (b.t - a.t)
            return a.v + (b.v - a.v) * u
          }
        }
        return keys[keys.length - 1].v
      }
      // Expansion reveal approx: negative expansion → 0, ≥0 → 1, lerp in between.
      var minExp = 0
      if (expAnimated) {
        for (var mi = 0; mi < mask.expansionKeys.length; mi++) if (mask.expansionKeys[mi].v < minExp) minExp = mask.expansionKeys[mi].v
      }
      var vals = []
      var kts = []
      for (var ti = 0; ti < times.length; ti++) {
        var t = times[ti]
        var op = opAnimated ? (sample(mask.opacityKeys, t) / 100) : baseOp
        var expFactor = 1
        if (expAnimated && minExp < 0) {
          var ev = sample(mask.expansionKeys, t)
          expFactor = ev >= 0 ? 1 : Math.max(0, (ev - minExp) / (0 - minExp))
        }
        vals.push(round3(op * expFactor))
        var rel2 = layerDur > 0 ? ((t - layerIn) / layerDur) : 0
        if (rel2 < 0) rel2 = 0
        if (rel2 > 1) rel2 = 1
        kts.push(rel2.toFixed(4))
      }
      if (kts[0] !== '0.0000') { kts.unshift('0.0000'); vals.unshift(vals[0]) }
      if (kts[kts.length - 1] !== '1.0000') { kts.push('1.0000'); vals.push(vals[vals.length - 1]) }
      fillOpAnim = '<animate attributeName="fill-opacity" values="' + vals.join(';') +
        '" keyTimes="' + kts.join(';') +
        '" dur="' + layerDur.toFixed(3) + 's" begin="' + layerIn.toFixed(3) + 's" repeatCount="indefinite"/>'
    }
    return pathOpen + fillOpAnim + pathClose
  }

  // Build the <filter> + attribute for mask feather (SVG <feGaussianBlur>) and mask
  // expansion via <feMorphology> erode (negative expansion only — positive expansion
  // in lottie is done via stroke-width, but we keep it simple; positive expansion stays
  // as fill-opacity approximation in the path-level animate).
  function buildMaskFilter (mask, filterId) {
    var feather = (mask.feather && mask.feather.length >= 2)
      ? Math.max(Math.abs(Math.round(mask.feather[0])), Math.abs(Math.round(mask.feather[1])))
      : 0
    // Static expansion: negative → erode by abs value; positive → dilate (lottie uses
    // stroke-width=2x, but for SVG <path fill> inside <mask> we approximate via feMorphology).
    var staticExp = 0
    if (typeof mask.expansion === 'number') staticExp = mask.expansion
    // If expansion is keyframed, the dominant value for static bake is the first frame.
    if (mask.expansionKeys && mask.expansionKeys.length > 0) staticExp = mask.expansionKeys[0].v
    var primitives = []
    if (staticExp < -0.5) {
      primitives.push('<feMorphology operator="erode" radius="' + round3(Math.abs(staticExp)) + '"/>')
    } else if (staticExp > 0.5) {
      primitives.push('<feMorphology operator="dilate" radius="' + round3(staticExp) + '"/>')
    }
    if (feather > 0) {
      primitives.push('<feGaussianBlur stdDeviation="' + round3(feather / 2) + '"/>')
    }
    if (primitives.length === 0) return { def: '', attr: '' }
    return {
      def: '<filter id="' + filterId + '" x="-50%" y="-50%" width="200%" height="200%">' +
        primitives.join('') + '</filter>',
      attr: ' filter="url(#' + filterId + ')"'
    }
  }

  // Compose N masks on a layer into ONE mask definition + apply-attribute for the layer <g>.
  // Returns { def, applyAttr } where def goes into <defs>, applyAttr goes on the layer <g>.
  //
  // Mode composition rules (from lottie-web mask.js:36-42,44-49,100-117,195-202):
  //   • All masks pure 'add', not inverted, opacity=100, no expansion/feather → <clipPath>
  //     (fastest; no alpha, just binary stencil)
  //   • Any mask has invert/subtract/intersect/opacity<100/expansion/feather → <mask>
  //     - Start with empty ground (black), or prefill white if first mask is Subtract/Inverted
  //     - Additive masks (mode 'add') render as white paths
  //     - Subtract masks render as black paths on top of prior composition
  //     - Intersect wraps previous <mask> group via nested mask=url()
  //     - Inverted flag: prepend a comp-size white rect via nonzero-winding sub-path
  //
  // layerIn, layerDur are used for SMIL timing. initPos is the layer's initial SVG translation
  // (so the mask <g> internal translate matches layer transform). cw, ch are comp dims for
  // inverted rect + intersect base fill.
  function buildLayerMasking (baseId, masks, layerIn, layerDur, initPos, cw, ch) {
    var out = { def: '', applyAttr: '' }
    if (!masks || masks.length === 0) return out
    // Validate: drop masks without shape data.
    var validMasks = []
    for (var vi = 0; vi < masks.length; vi++) {
      if (masks[vi] && masks[vi].shapeKeys && masks[vi].shapeKeys.length > 0 && masks[vi].shapeKeys[0].d) {
        validMasks.push(masks[vi])
      }
    }
    if (validMasks.length === 0) return out

    // Bucketing: does any mask need alpha / non-add composition → <mask>, else → <clipPath>
    function needsAlphaMask (m) {
      if (m.inverted) return true
      if (m.mode && m.mode !== 'add') return true
      if (m.opacity != null && m.opacity < 100) return true
      if (m.opacityKeys && m.opacityKeys.length > 0) return true
      if (m.expansionKeys && m.expansionKeys.length > 0) return true
      if (m.feather && m.feather.length >= 2 && (Math.abs(m.feather[0]) > 0 || Math.abs(m.feather[1]) > 0)) return true
      if (m.expansion && Math.abs(m.expansion) > 0.5) return true
      return false
    }
    var useAlphaMask = false
    for (var bi = 0; bi < validMasks.length; bi++) {
      if (needsAlphaMask(validMasks[bi])) { useAlphaMask = true; break }
    }

    // CRITICAL (lottie-web mask.js paradigm):
    //   When `mask=` or `clip-path=` is applied to a <g> that ALSO has `transform=translate(...)`,
    //   SVG applies the mask/clip BEFORE the element's own transform — so the clip geometry
    //   must be expressed in LAYER-LOCAL coords (NOT pre-translated to world-space). AE mask
    //   vertices are already in layer-local space (same coord system as glyphs/shapes inside
    //   the layer), so we emit them UNWRAPPED. Any additional wrapper <g transform=...> would
    //   double-transform the mask.
    var wrapOpen = ''
    var wrapClose = ''

    if (!useAlphaMask) {
      // ── Pure <clipPath> path (lottie-web fast path for additive opaque masks) ─────
      // Multiple sub-paths union naturally with clip-rule="nonzero".
      var clipInner = ''
      for (var ci = 0; ci < validMasks.length; ci++) {
        var m = validMasks[ci]
        // For <clipPath> we don't need fill; just the path geometry via SMIL <animate d> if animated.
        clipInner += buildMaskPath(m, layerIn, layerDur, 'white', '').replace(/fill="white"/, '').replace(/fill-opacity="[^"]*"/, '')
      }
      out.def = '<clipPath id="' + baseId + '" clipPathUnits="userSpaceOnUse">' +
        wrapOpen + clipInner + wrapClose + '</clipPath>'
      out.applyAttr = ' clip-path="url(#' + baseId + ')"'
      return out
    }

    // ── Alpha <mask> path (lottie-web full-featured) ────────────────────────────
    // We classify masks by mode and compose. Simple case first: single mask with Add/Subtract/Inverted.
    // Multi-mask with Intersect recursively wraps.
    //
    // Strategy:
    //   1. Decide ground: if any mask has mode 'subtract' as its only/outer behaviour, or any
    //      inverted, start with a full-viewbox white rect (reveals everything, paths punch holes).
    //      Otherwise start with nothing (black), additive paths reveal.
    //   2. Iterate masks:
    //      - 'add' (or undefined) non-inverted: white path (reveals)
    //      - 'subtract' OR 'add'+inverted: black path (hides)
    //      - 'intersect': wrap preceding masks in nested <mask> then AND-combine
    //      - 'lighten' / 'darken' / 'difference': downgrade with warning (CSS/SVG can't express cleanly)
    //
    // For simplicity in the MVP, we compose into a single <mask> with additive + subtract
    // sub-paths. Intersect and the three lighten/darken/difference modes are flagged as
    // "simplified to add-only" via console-level warning (not emitted to output but documented).

    // Determine if we need a white base (any inverted or subtract mask present).
    var needsWhiteBase = false
    for (var nb = 0; nb < validMasks.length; nb++) {
      if (validMasks[nb].inverted || validMasks[nb].mode === 'subtract') { needsWhiteBase = true; break }
    }

    // Build composite inner content:
    var inner = ''
    if (needsWhiteBase) {
      // Comp-sized white rect as base (everything visible), then paths subtract from it.
      inner += '<rect x="0" y="0" width="' + cw + '" height="' + ch + '" fill="white"/>'
    }
    for (var mi2 = 0; mi2 < validMasks.length; mi2++) {
      var mm = validMasks[mi2]
      // Decide fill color per mode/inverted:
      //   'add' non-inverted = white (reveal)
      //   'add' inverted OR 'subtract' non-inverted = black (hide)
      //   'subtract' inverted = white (double negative)
      var fillColor
      var mode = mm.mode || 'add'
      var inv = !!mm.inverted
      if (mode === 'add' && !inv) fillColor = 'white'
      else if (mode === 'subtract' && inv) fillColor = 'white'
      else if (mode === 'add' && inv) fillColor = 'black'
      else if (mode === 'subtract' && !inv) fillColor = 'black'
      else fillColor = 'white' // fallback for lighten/darken/difference/intersect — simplified
      // Per-mask feather/expansion filter:
      var filterId = baseId + '-fx-' + mi2
      var fxObj = buildMaskFilter(mm, filterId)
      if (fxObj.def) inner = fxObj.def + inner // filter defs go first
      inner += buildMaskPath(mm, layerIn, layerDur, fillColor, fxObj.attr)
    }

    out.def = '<mask id="' + baseId + '" maskUnits="userSpaceOnUse">' +
      wrapOpen + inner + wrapClose + '</mask>'
    out.applyAttr = ' mask="url(#' + baseId + ')"'
    return out
  }

  // Back-compat shim: buildMaskDef was used by old single-mask callers. New composer above
  // subsumes it. Kept exported for any direct callers (tests etc.).
  function buildMaskDef (maskId, mask, layerIn, layerDur, initPos, compW, compH) {
    var out = buildLayerMasking(maskId, [mask], layerIn, layerDur, initPos, compW, compH)
    return out.def
  }

  // ── Shape layer rendering (multi-fill/stroke/shape + Polystar + RoundCorners + Trim) ──
  //
  // AE shape layer contents can have N shapes (rect/ellipse/path/polystar), N fills and
  // N strokes, in any order. Each shape is rendered separately for each fill and each
  // stroke, preserving the stacking order per lottie-web's SVGShapeElement pattern.
  // Trim Paths is approximated via stroke-dasharray/stroke-dashoffset (valid for most
  // "draw-on" animations). Round Corners: if non-zero, applies rx/ry to rects; for paths
  // it's a complex bezier re-gen which is deferred (warning emitted).

  // Build SVG `d` string for a Polystar using AE2Canvas's math (cubic bezier handles
  // derived from circle-constant 0.5522848). Works for both 'star' and 'polygon' types.
  function buildPolystarPath (ps) {
    var points = Math.max(3, Math.round(ps.points || 5))
    var isStar = ps.polystarType === 'star'
    var innerR = isStar ? (ps.innerRadius || 0) : (ps.outerRadius || 0)
    var outerR = ps.outerRadius || 0
    var innerRound = (ps.innerRoundness || 0) / 100
    var outerRound = (ps.outerRoundness || 0) / 100
    var rotDeg = ps.rotation || 0
    var rotRad = rotDeg * Math.PI / 180 - Math.PI / 2  // AE: 0° = up
    var px = (ps.position && ps.position[0]) || 0
    var py = (ps.position && ps.position[1]) || 0
    var totalVerts = isStar ? points * 2 : points
    var angleStep = (Math.PI * 2) / totalVerts
    var d = ''
    var kCirc = 0.5522848
    function vertex (i) {
      var r = isStar ? (i % 2 === 0 ? outerR : innerR) : outerR
      var angle = rotRad + i * angleStep
      return { x: px + r * Math.cos(angle), y: py + r * Math.sin(angle), r: r, angle: angle }
    }
    for (var i = 0; i < totalVerts; i++) {
      var v = vertex(i)
      var vn = vertex((i + 1) % totalVerts)
      if (i === 0) d += 'M ' + round3(v.x) + ' ' + round3(v.y)
      // Cubic bezier handle length proportional to roundness
      var round = isStar ? (i % 2 === 0 ? outerRound : innerRound) : outerRound
      var nextRound = isStar ? ((i + 1) % 2 === 0 ? outerRound : innerRound) : outerRound
      var h1Len = (v.r * Math.PI * 2 / totalVerts) * kCirc * round
      var h2Len = (vn.r * Math.PI * 2 / totalVerts) * kCirc * nextRound
      var tangent1x = v.x - Math.sin(v.angle) * h1Len
      var tangent1y = v.y + Math.cos(v.angle) * h1Len
      var tangent2x = vn.x + Math.sin(vn.angle) * h2Len
      var tangent2y = vn.y - Math.cos(vn.angle) * h2Len
      d += ' C ' + round3(tangent1x) + ' ' + round3(tangent1y) + ', ' +
           round3(tangent2x) + ' ' + round3(tangent2y) + ', ' +
           round3(vn.x) + ' ' + round3(vn.y)
    }
    d += ' Z'
    return d
  }

  // Build SVG `d` for a bezier path (vertices + tangents)
  function buildBezierPath (path) {
    if (!path || !path.vertices || path.vertices.length === 0) return ''
    var verts = path.vertices
    var inT = path.inTangents || []
    var outT = path.outTangents || []
    var d = 'M ' + round3(verts[0][0]) + ' ' + round3(verts[0][1])
    for (var i = 1; i < verts.length; i++) {
      var prev = verts[i - 1]
      var curr = verts[i]
      var ot = outT[i - 1] || [0, 0]
      var it = inT[i] || [0, 0]
      var hasBezier = ot[0] !== 0 || ot[1] !== 0 || it[0] !== 0 || it[1] !== 0
      if (hasBezier) {
        d += ' C ' + round3(prev[0] + ot[0]) + ' ' + round3(prev[1] + ot[1]) +
             ', ' + round3(curr[0] + it[0]) + ' ' + round3(curr[1] + it[1]) +
             ', ' + round3(curr[0]) + ' ' + round3(curr[1])
      } else {
        d += ' L ' + round3(curr[0]) + ' ' + round3(curr[1])
      }
    }
    if (path.closed && verts.length > 1) {
      var last = verts[verts.length - 1]
      var first = verts[0]
      var otL = outT[verts.length - 1] || [0, 0]
      var itF = inT[0] || [0, 0]
      var hasClosingBezier = otL[0] !== 0 || otL[1] !== 0 || itF[0] !== 0 || itF[1] !== 0
      if (hasClosingBezier) {
        d += ' C ' + round3(last[0] + otL[0]) + ' ' + round3(last[1] + otL[1]) +
             ', ' + round3(first[0] + itF[0]) + ' ' + round3(first[1] + itF[1]) +
             ', ' + round3(first[0]) + ' ' + round3(first[1])
      }
      d += ' Z'
    }
    return d
  }

  // Build geometry for a single shape primitive → { tag, attrs, d }
  // tag: 'rect' | 'ellipse' | 'path' | null
  function buildShapeGeometry (s, roundCornersRadius) {
    if (s.primitive === 'rect' && s.size) {
      var rw = round3(s.size[0]), rh = round3(s.size[1])
      var rx = round3(Math.max(s.roundness || 0, roundCornersRadius || 0))
      return { tag: 'rect', attrs: 'x="' + (-rw / 2) + '" y="' + (-rh / 2) + '" width="' + rw + '" height="' + rh + '" rx="' + rx + '"' }
    }
    if (s.primitive === 'ellipse' && s.size) {
      var erx = round3(s.size[0] / 2), ery = round3(s.size[1] / 2)
      return { tag: 'ellipse', attrs: 'cx="0" cy="0" rx="' + erx + '" ry="' + ery + '"' }
    }
    if (s.primitive === 'path' && s.path) {
      var d = buildBezierPath(s.path)
      if (d) return { tag: 'path', d: d }
    }
    if (s.primitive === 'polystar') {
      return { tag: 'path', d: buildPolystarPath(s) }
    }
    return null
  }

  // Build stroke attribute string from a stroke item (color, width, opacity, cap, join, miter, dash).
  // `trim` (optional): { start, end, offset } 0..100 → translates to stroke-dasharray/dashoffset
  // using a heuristic pathLength approximation. For Trim animation, caller must emit SMIL.
  function buildStrokeAttrs (stroke, trim) {
    // Gradient strokes come in without a solid .color — their stroke= is injected later via
    // resolveStrokeRef replacement. We still need to emit width/cap/join/dash/trim attrs.
    if (!stroke || stroke.width <= 0) return ''
    if (!stroke.gradient && !stroke.color) return ''
    var strokeValue = stroke.gradient ? 'currentColor' : escapeHtml(stroke.color)
    var attrs = ' stroke="' + strokeValue + '" stroke-width="' + round3(stroke.width) + '"'
    if (stroke.opacity != null && stroke.opacity < 1) attrs += ' stroke-opacity="' + round3(stroke.opacity) + '"'
    if (stroke.lineCap && stroke.lineCap !== 'butt') attrs += ' stroke-linecap="' + stroke.lineCap + '"'
    if (stroke.lineJoin && stroke.lineJoin !== 'miter') attrs += ' stroke-linejoin="' + stroke.lineJoin + '"'
    if (stroke.miterLimit && stroke.miterLimit !== 4) attrs += ' stroke-miterlimit="' + round3(stroke.miterLimit) + '"'
    if (stroke.dashArray && stroke.dashArray.length > 0) {
      attrs += ' stroke-dasharray="' + stroke.dashArray.map(round3).join(' ') + '"'
      if (stroke.dashOffset) attrs += ' stroke-dashoffset="' + round3(stroke.dashOffset) + '"'
    }
    // Trim Paths via stroke-dasharray trick (uses pathLength=100 so start/end are in percent)
    if (trim) {
      var trimStart = trim.start || 0
      var trimEnd = trim.end != null ? trim.end : 100
      var trimOffset = trim.offset || 0
      var visible = Math.max(0, trimEnd - trimStart)
      // pathLength=100 makes dash values percent-equivalent
      attrs += ' pathLength="100" stroke-dasharray="' + round3(visible) + ' 100" stroke-dashoffset="' +
        round3(-trimStart - trimOffset) + '"'
    }
    return attrs
  }

  // Render a shape layer's full contents as a concatenated SVG fragment.
  // Returns the inner SVG markup (no outer <g>; outer layer <g> is built by caller).
  // Rendering order (per lottie-web): for each shape, emit each fill pass then each stroke pass,
  // so later-declared fills/strokes overlap earlier ones — matches AE's paint order.
  // Build a SVG gradient <defs> entry for a gradient-fill or gradient-stroke.
  // Returns { def, urlRef } — def is markup to append to <defs>, urlRef is `url(#id)`.
  function buildGradientDef (grad, idBase) {
    var tag = grad.kind === 'radial' ? 'radialGradient' : 'linearGradient'
    var attrs = 'id="' + idBase + '" gradientUnits="userSpaceOnUse"'
    if (grad.kind === 'radial') {
      // For radial: start = center, end = edge → radius = distance
      var cx = round3(grad.start[0]), cy = round3(grad.start[1])
      var dxR = grad.end[0] - grad.start[0], dyR = grad.end[1] - grad.start[1]
      var radius = round3(Math.sqrt(dxR * dxR + dyR * dyR))
      attrs += ' cx="' + cx + '" cy="' + cy + '" r="' + radius + '" fx="' + cx + '" fy="' + cy + '"'
    } else {
      attrs += ' x1="' + round3(grad.start[0]) + '" y1="' + round3(grad.start[1]) +
        '" x2="' + round3(grad.end[0]) + '" y2="' + round3(grad.end[1]) + '"'
    }
    var stopsMarkup = ''
    for (var si = 0; si < grad.stops.length; si++) {
      var s = grad.stops[si]
      stopsMarkup += '<stop offset="' + round3(s.offset) + '" stop-color="' + escapeHtml(s.color) +
        '" stop-opacity="' + round3((s.alpha != null ? s.alpha : 1) * (grad.opacity != null ? grad.opacity : 1)) + '"/>'
    }
    return {
      def: '<' + tag + ' ' + attrs + '>' + stopsMarkup + '</' + tag + '>',
      urlRef: 'url(#' + idBase + ')'
    }
  }

  function renderShapeLayer (shapeData, idPrefix) {
    // Backward-compat: old callers may have only flat shape/fill/stroke.
    var shapesArr = shapeData.shapes || (shapeData.primitive ? [shapeData] : [])
    var fillsArr = shapeData.fills && shapeData.fills.length > 0 ? shapeData.fills :
      (shapeData.fillColor ? [{ color: shapeData.fillColor, opacity: shapeData.fillOpacity || 1, rule: 'nonzero' }] : [])
    var strokesArr = shapeData.strokes && shapeData.strokes.length > 0 ? shapeData.strokes :
      (shapeData.strokeColor && shapeData.strokeWidth > 0 ? [{
        color: shapeData.strokeColor, width: shapeData.strokeWidth, opacity: shapeData.strokeOpacity || 1,
        lineCap: shapeData.strokeLineCap || 'butt', lineJoin: shapeData.strokeLineJoin || 'miter',
        miterLimit: 4, dashArray: [], dashOffset: 0
      }] : [])
    var trim = shapeData.trim
    var roundCornersRadius = (shapeData.roundCorners && shapeData.roundCorners.radius) || 0
    if (shapesArr.length === 0) {
      return '<rect x="-40" y="-20" width="80" height="40" fill="#5679aa"/>'
    }
    var defsParts = []
    var parts = []
    var gradSeq = 0
    // Pre-resolve fill/stroke references: for gradient fills build a gradient <def> + urlRef;
    // for solid fills keep inline color.
    function resolveFillRef (f) {
      if (f.gradient) {
        var gid = (idPrefix || 'gr') + '-f-' + (gradSeq++)
        var g = buildGradientDef(f, gid)
        defsParts.push(g.def)
        return g.urlRef
      }
      return f.color ? escapeHtml(f.color) : 'none'
    }
    function resolveStrokeRef (s) {
      if (s.gradient) {
        var gid = (idPrefix || 'gr') + '-s-' + (gradSeq++)
        var g = buildGradientDef(s, gid)
        defsParts.push(g.def)
        return g.urlRef
      }
      return s.color ? escapeHtml(s.color) : 'none'
    }
    for (var si = 0; si < shapesArr.length; si++) {
      var primRef = shapesArr[si]
      var geo = buildShapeGeometry(primRef, roundCornersRadius)
      if (!geo) continue
      // P3.4: primitives under nested Vector Groups carry a `groupStack` of ancestor group
      // transforms. Compose them into a single matrix and wrap this shape's elements.
      var shapeParts = []
      if (fillsArr.length === 0 && strokesArr.length === 0) {
        var defaultAttrs = geo.tag === 'path' ? ' d="' + geo.d + '"' : ' ' + geo.attrs
        shapeParts.push('<' + geo.tag + defaultAttrs + ' fill="#5679aa"/>')
      } else {
        // Fills first (painted below strokes)
        for (var fi = 0; fi < fillsArr.length; fi++) {
          var f = fillsArr[fi]
          var fillRef = resolveFillRef(f)
          var fOp = (f.opacity != null && f.opacity < 1) ? ' fill-opacity="' + round3(f.opacity) + '"' : ''
          var fRule = (f.rule && f.rule !== 'nonzero') ? ' fill-rule="' + f.rule + '"' : ''
          var dAttr = geo.tag === 'path' ? ' d="' + geo.d + '"' : ' ' + geo.attrs
          shapeParts.push('<' + geo.tag + dAttr + ' fill="' + fillRef + '"' + fOp + fRule + '/>')
        }
        // Strokes on top
        for (var si2 = 0; si2 < strokesArr.length; si2++) {
          var st = strokesArr[si2]
          var strokeRef = resolveStrokeRef(st)
          // Build stroke attrs — but override `stroke=` with gradient urlRef if applicable
          var strokeAttrs = buildStrokeAttrs(st, trim)
          if (st.gradient) strokeAttrs = strokeAttrs.replace(/ stroke="[^"]*"/, ' stroke="' + strokeRef + '"')
          var dAttr2 = geo.tag === 'path' ? ' d="' + geo.d + '"' : ' ' + geo.attrs
          shapeParts.push('<' + geo.tag + dAttr2 + ' fill="none"' + strokeAttrs + '/>')
        }
      }
      if (primRef.groupStack && primRef.groupStack.length > 0) {
        var GM = matIdent()
        for (var gsi = 0; gsi < primRef.groupStack.length; gsi++) {
          var gs = primRef.groupStack[gsi]
          var sx = (gs.scale && gs.scale[0] != null ? gs.scale[0] : 100) / 100
          var sy = (gs.scale && gs.scale[1] != null ? gs.scale[1] : 100) / 100
          var lm = matMul(
            matMul(
              matMul(matTranslate(gs.position ? gs.position[0] : 0, gs.position ? gs.position[1] : 0),
                matRotate(gs.rotation || 0)),
              matScale(sx, sy)),
            matTranslate(-(gs.anchor ? gs.anchor[0] : 0), -(gs.anchor ? gs.anchor[1] : 0))
          )
          GM = matMul(GM, lm)
        }
        // Compose group opacity (product) on the wrapping <g> — keeps matches with AE semantics.
        var gOp = 1
        for (var goi = 0; goi < primRef.groupStack.length; goi++) {
          gOp *= (primRef.groupStack[goi].opacity != null ? primRef.groupStack[goi].opacity : 100) / 100
        }
        var opAttr = gOp < 1 ? ' opacity="' + round3(gOp) + '"' : ''
        parts.push('<g transform="' + matToCss(GM) + '"' + opAttr + '>' + shapeParts.join('') + '</g>')
      } else {
        parts.push(shapeParts.join(''))
      }
    }
    var inner = parts.join('')
    // P4.2: Repeater — emit N <use> copies of the source, each with an accumulated transform
    // (position, scale, rotation applied `copy` times from the origin). Opacity linearly fades
    // from startOpacity → endOpacity across copies.
    var repeater = shapeData.repeater
    if (repeater && repeater.copies > 1) {
      var srcId = (idPrefix || 'gr') + '-repeat-src'
      defsParts.push('<g id="' + srcId + '">' + inner + '</g>')
      var useList = []
      var rpC = Math.min(100, Math.max(1, repeater.copies))
      var rpOffset = repeater.offset || 0
      var rpPos = repeater.position || [0, 0]
      var rpScale = repeater.scale || [100, 100]
      var rpRot = repeater.rotation || 0
      var rpAnchor = repeater.anchor || [0, 0]
      var rpStartOp = (repeater.startOpacity != null ? repeater.startOpacity : 100) / 100
      var rpEndOp = (repeater.endOpacity != null ? repeater.endOpacity : 100) / 100
      for (var cp = 0; cp < rpC; cp++) {
        var k = cp + rpOffset
        // Per-copy transform: accumulate k copies of (T(pos)·R(rot)·S(sx^k,sy^k)·T(-anchor))
        // Simplification: apply T(pos*k) · R(rot*k) · S((sx)^k, (sy)^k) · T(-anchor)
        var sxPow = Math.pow(rpScale[0] / 100, k)
        var syPow = Math.pow(rpScale[1] / 100, k)
        var M = matMul(
          matMul(
            matMul(matTranslate(rpPos[0] * k, rpPos[1] * k), matRotate(rpRot * k)),
            matScale(sxPow, syPow)),
          matTranslate(-rpAnchor[0], -rpAnchor[1])
        )
        var tAttr = matToCss(M)
        var opK = rpC > 1 ? rpStartOp + (rpEndOp - rpStartOp) * (cp / (rpC - 1)) : rpStartOp
        var opA = opK < 1 ? ' opacity="' + round3(opK) + '"' : ''
        useList.push('<use href="#' + srcId + '" xlink:href="#' + srcId + '" transform="' + tAttr + '"' + opA + '/>')
      }
      inner = useList.join('')
    }
    var defsPrefix = defsParts.length > 0 ? '<defs>' + defsParts.join('') + '</defs>' : ''
    return defsPrefix + inner
  }

  function buildSvgShapes (compData, assetFiles) {
    // Returns { svgInner, layerMeta[], svgDefs, extraCss } — svgInner is the <g> group per layer,
    // layerMeta describes CSS animation targets, svgDefs holds masks/clipPaths, extraCss holds
    // effect-driven animations (e.g., animated fill color via @keyframes).
    var parts = []
    var meta = []
    var defs = []
    var extraCss = []
    var layers = compData.layers || []
    var cw = compData.comp.width
    var ch = compData.comp.height
    var compDur = Math.max(0.1, Number(compData.comp.duration) || 1)
    var seenPathToName = {}
    // AE layer order: index 1 = top (rendered on top). SVG paint order: later siblings
    // are drawn on top. So iterate from the LAST AE layer back to the first to flip z-order.
    for (var i = layers.length - 1; i >= 0; i--) {
      var layer = layers[i]
      var id = 'layer-' + i + '-' + escapeCss(layer.name || layer.type)
      var anchor = resolvePos(layer.transform.position, cw, ch)
      var shape = ''
      if (layer.type === 'text' && layer.extras && layer.extras.text) {
        var tx = layer.extras.text
        var fontFam = tx.fontFamily || tx.font || 'sans-serif'
        var fontSz = tx.fontSize || 48
        var textFill = tx.applyFill === false ? 'none' : escapeHtml(tx.fillColor || '#ffffff')
        var tAttrs = ''
        if (tx.applyStroke && tx.strokeColor && tx.strokeWidth > 0) {
          // paint-order=stroke puts stroke behind fill (AE strokeOverFill=false), or above (true)
          var pOrd = tx.strokeOverFill ? 'fill stroke' : 'stroke fill'
          tAttrs += ' stroke="' + escapeHtml(tx.strokeColor) + '" stroke-width="' + round3(tx.strokeWidth) +
                    '" paint-order="' + pOrd + '"'
        }
        if (tx.fauxBold) tAttrs += ' font-weight="bold"'
        if (tx.fauxItalic) tAttrs += ' font-style="italic"'
        if (tx.tracking) tAttrs += ' letter-spacing="' + round3(tx.tracking / 1000 * fontSz) + '"'
        // Baseline alignment (lottie-web approach, SVGTextElement.js line 131):
        //   In AE, text layer-space y=0 IS the baseline — not the top edge. Mask vertices
        //   are in that same baseline-relative space (e.g. user-drawn cap-height-to-descender
        //   box has y-range [-66.6, +28.8]).
        //   SVG default `dominant-baseline="alphabetic"` also puts baseline at the y coord
        //   we specify. By emitting `y=0`, the SVG baseline lands exactly where AE expects,
        //   so mask vertices naturally align with rendered glyphs. No ascent compensation
        //   on the mask side; no `text-before-edge` hack needed.
        //   This is layer-type-agnostic — keeps mask subsystem identical for text/shape/av.
        // P4.6: Text animator (minimal) — pick whichever animator property is "meaningfully
        // animated" (opacity going 0→non-0, or position with non-zero delta) and stamp a
        // per-character staggered CSS animation. This is a structural approximation of AE's
        // Range Selector semantics; full per-selector shape/offset math is roadmap.
        var textBody
        var animActive = null  // 'opacity' | 'position'
        if (tx.animator && tx.text) {
          function propIsAnimating (track) {
            if (!track || track.length === 0) return false
            var first = track[0] && track[0].v
            // Scalar: animating if any later value differs OR length>=2 with non-zero end
            if (typeof first === 'number') {
              if (track.length < 2) return first !== 0
              for (var ti = 1; ti < track.length; ti++) if (track[ti].v !== first) return true
              return first !== 0
            }
            // Vector: animating if any axis differs or non-zero static
            if (Array.isArray(first)) {
              for (var tj = 0; tj < track.length; tj++) {
                var v = track[tj].v
                if (!v) continue
                for (var vk = 0; vk < v.length; vk++) if (v[vk] !== 0 && v[vk] != null) return true
              }
            }
            return false
          }
          if (propIsAnimating(tx.animator.opacity)) animActive = 'opacity'
          else if (propIsAnimating(tx.animator.position)) animActive = 'position'
        }
        if (animActive) {
          var chars = String(tx.text).split('')
          var N = chars.length
          var animLayerIn = (layer.inPoint != null && isFinite(layer.inPoint)) ? Math.max(0, Number(layer.inPoint)) : 0
          var animLayerOut = (layer.outPoint != null && isFinite(layer.outPoint)) ? Math.min(compDur, Number(layer.outPoint)) : compDur
          var animLayerDur = Math.max(0.01, animLayerOut - animLayerIn)
          var tspans = []
          // Justification-aware x-anchor: AE defaults to left-align, multi-line not handled
          var txAnchor = (tx.justification === 'center' ? 'middle' : tx.justification === 'right' ? 'end' : 'start')
          for (var ci = 0; ci < N; ci++) {
            var tsId = escapeCss(id) + '_ch' + ci
            var delayFrac = N > 1 ? (ci / (N - 1)) * 0.4 : 0
            var delay = animLayerIn + delayFrac * animLayerDur
            var dur = Math.max(0.05, animLayerDur * 0.6)
            var kfName = 'ae-tc-' + tsId
            if (animActive === 'opacity') {
              var finalOp = tx.animator.opacity[tx.animator.opacity.length - 1].v
              var startOp = tx.animator.opacity[0].v
              // AE animator opacity is an OFFSET applied to char's base 100%. Value 0 = no change;
              // -100 = fully invisible. So effective alpha = clamp01((100 + offset)/100).
              var startAlpha = Math.max(0, Math.min(1, (100 + (startOp || 0)) / 100))
              var endAlpha = Math.max(0, Math.min(1, (100 + (finalOp || 0)) / 100))
              extraCss.push('@keyframes ' + kfName + ' {\n  0% { opacity: ' + round3(startAlpha) + '; }\n  100% { opacity: ' + round3(endAlpha) + '; }\n}')
            } else {
              // Position animator — use SVG `transform` on the tspan. Endpoints: end-state = first
              // kf (selection amount = 0 → no offset), ctx chars slide IN from animator position.
              var posEnd = tx.animator.position[tx.animator.position.length - 1].v || [0, 0, 0]
              var posStart = tx.animator.position[0].v || [0, 0, 0]
              // If start is zero-ish and end has offset, chars slide FROM end-offset → 0 (AE reveal pattern).
              // If start has offset and end zero, inverse. We animate tspan transform from start→end.
              extraCss.push('@keyframes ' + kfName + ' {\n' +
                '  0% { transform: translate(' + round3(posStart[0] || 0) + 'px, ' + round3(posStart[1] || 0) + 'px); }\n' +
                '  100% { transform: translate(' + round3(posEnd[0] || 0) + 'px, ' + round3(posEnd[1] || 0) + 'px); }\n}')
            }
            extraCss.push('#' + tsId + ' { animation: ' + kfName + ' ' + round3(dur) + 's linear ' + round3(delay) + 's infinite both; ' +
              (animActive === 'position' ? 'transform-box: fill-box; ' : '') + '}')
            tspans.push('<tspan id="' + tsId + '" class="ae-char">' + escapeHtml(chars[ci]) + '</tspan>')
          }
          textBody = tspans.join('')
          // Surface a comment so the user sees when AE Text Animator was partially mapped.
          extraCss.push('/* Text animator on layer ' + id + ': stagger-MVP over "' + animActive +
            '". Full AE Range Selector (shape/offset/smoothness) is roadmap. */')
        } else {
          textBody = escapeHtml(tx.text || '')
        }
        // P4.4: Text on path — bind text to follow a mask's shape via `<textPath>`.
        var textPathRef = null
        if (tx.pathOption && layer.masks && typeof tx.pathOption.maskIndex === 'number') {
          var mskRef = layer.masks[tx.pathOption.maskIndex]
          if (mskRef && mskRef.shapeKeys && mskRef.shapeKeys.length > 0 && mskRef.shapeKeys[0].d) {
            var tpId = 'textpath-' + escapeCss(id)
            defs.push('<path id="' + tpId + '" d="' + mskRef.shapeKeys[0].d + '" fill="none"/>')
            textPathRef = tpId
          }
        }
        if (textPathRef) {
          var tpStart = (tx.pathOption && tx.pathOption.firstMargin) ? ' startOffset="' + round3(tx.pathOption.firstMargin) + '"' : ''
          var tpSide = (tx.pathOption && tx.pathOption.reverse) ? ' side="right"' : ''
          shape = '<text dominant-baseline="alphabetic" ' +
            'font-family="' + escapeHtml(fontFam) + '" ' +
            'font-size="' + fontSz + '" ' +
            'fill="' + textFill + '"' + tAttrs + '>' +
            '<textPath href="#' + textPathRef + '" xlink:href="#' + textPathRef + '"' + tpStart + tpSide + '>' +
            textBody + '</textPath></text>'
        } else {
          shape = '<text x="0" y="0" dominant-baseline="alphabetic" ' +
            'text-anchor="' + (tx.justification === 'center' ? 'middle' : tx.justification === 'right' ? 'end' : 'start') + '" ' +
            'font-family="' + escapeHtml(fontFam) + '" ' +
            'font-size="' + fontSz + '" ' +
            'fill="' + textFill + '"' + tAttrs + '>' +
            textBody + '</text>'
        }
      } else if (layer.type === 'shape' && layer.extras && layer.extras.shape) {
        shape = renderShapeLayer(layer.extras.shape)
      } else if (layer.type === 'av' && layer.extras && layer.extras.media) {
        var media = layer.extras.media
        var mw = Number(media.width) || 0
        var mh = Number(media.height) || 0
        // Anchor point offset: AE places layer.anchor at the position value. Default
        // for footage is [W/2, H/2] (centered). Inside the <g> we offset the media
        // by (-anchorX, -anchorY) so the anchor lands at the group origin.
        var ax = (layer.anchor && layer.anchor.length >= 2) ? layer.anchor[0] : mw / 2
        var ay = (layer.anchor && layer.anchor.length >= 2) ? layer.anchor[1] : mh / 2
        if (media.isSolid) {
          shape = '<rect x="' + round3(-ax) + '" y="' + round3(-ay) +
            '" width="' + mw + '" height="' + mh +
            '" fill="' + escapeHtml(media.color || '#808080') + '"/>'
          // continue to common wrapper (the trailing <g> push below)
        } else {
        var assetName = mediaAssetName(layer, i, seenPathToName)
        var href = './assets/' + assetName
        // Register the asset file for copy (only once per unique path).
        if (assetFiles && !assetFiles._seen[media.path]) {
          assetFiles._seen[media.path] = true
          assetFiles.list.push({
            name: 'assets/' + assetName,
            copyFrom: media.path
          })
        }
        if (media.isVideo) {
          // SVG <video> is not standard — use <foreignObject> wrapping a real HTML5 <video>.
          shape = '<foreignObject x="' + round3(-ax) + '" y="' + round3(-ay) +
            '" width="' + mw + '" height="' + mh + '">' +
            '<video xmlns="http://www.w3.org/1999/xhtml" src="' + escapeHtml(href) +
            '" width="' + mw + '" height="' + mh + '" autoplay muted loop playsinline style="display:block"></video>' +
            '</foreignObject>'
        } else {
          shape = '<image xlink:href="' + escapeHtml(href) + '" href="' + escapeHtml(href) +
            '" x="' + round3(-ax) + '" y="' + round3(-ay) +
            '" width="' + mw + '" height="' + mh + '" preserveAspectRatio="none"/>'
        }
        } // end else (non-solid media)
      } else if (layer.type === 'null' || layer.type === 'av' || layer.type === 'adjustment') {
        // Fallback placeholder for null controllers, AV layers without a file source, or adjustment
        shape = '<rect x="-20" y="-20" width="40" height="40" fill="#ffffff33" stroke="#ffffff66" stroke-dasharray="3,3"/>'
      } else {
        continue // skip camera/light/precomp for now
      }
      // Resolve initial-state transform (position/scale/rotation/opacity) so static layers
      // keep their scale/rotation/opacity even when no @keyframes are emitted.
      var t0 = layer.transform.position && layer.transform.position[0] ? layer.transform.position[0].t : 0
      var initPos = interpPositionSpatial(layer.transform.position, t0) || anchor
      var initScale = interpValue(layer.transform.scale, t0)
      var initRot = interpValue(layer.transform.rotation, t0)
      var initOp = interpValue(layer.transform.opacity, t0)
      var initSx, initSy
      if (Array.isArray(initScale) && initScale.length >= 2) { initSx = initScale[0] / 100; initSy = initScale[1] / 100 }
      else if (typeof initScale === 'number') { initSx = initScale / 100; initSy = initSx }
      else { initSx = 1; initSy = 1 }
      var initRd = typeof initRot === 'number' ? initRot : (Array.isArray(initRot) ? initRot[0] : 0)
      var initOpN = (initOp == null) ? 1 : (typeof initOp === 'number' ? initOp / 100 : 1)
      // Use SVG transform attribute (user-space units) — NOT CSS transform. CSS transforms
      // on SVG children compute in viewport pixels, not user-units, which causes double-transform
      // when the SVG is also scaled by viewBox. SVG transform attribute is always in user-units
      // and composes correctly with viewBox scaling.
      //
      // P3.3: When layer is parented, compose the world matrix from the parent chain
      // (parent pose · child local), and its opacity multiplies parent opacity. Produces
      // SVG `matrix(...)` form in that case; otherwise keeps the legacy TRS string so
      // non-parented layers stay compact.
      var svgTransform
      var effOp = initOpN
      if (layer.parentIndex != null) {
        var wm = composedMatrixAt(layer, t0, layers)
        svgTransform = matToCss(wm)
        effOp = composedOpacityAt(layer, t0, layers)
      } else {
        svgTransform = 'translate(' + round3(initPos[0]) + ' ' + round3(initPos[1]) + ') ' +
          'rotate(' + round3(initRd) + ') scale(' + round3(initSx) + ' ' + round3(initSy) + ')'
      }
      var gStyle = 'opacity: ' + round3(effOp) + ';'
      // Blend mode: non-normal AE modes become CSS mix-blend-mode on the layer group.
      if (layer.blendMode && layer.blendMode !== 'normal') {
        gStyle += ' mix-blend-mode: ' + layer.blendMode + ';'
      }
      // Effects → CSS filter (stackable, fully animated via @keyframes with union time points).
      // Supports Drop Shadow, Gaussian Blur, Invert, Brightness/Contrast, Hue/Saturation, Tint.
      // Each effect's animated properties are sampled at union time set → single @keyframes
      // per layer drives `filter:` through all stops.
      if (layer.effects) {
        // ── helpers ─────────────────────────────────────────────
        function effFirst (arr, fallback) { return (arr && arr.length > 0 && arr[0].v != null) ? arr[0].v : fallback }
        function effSample (keys, t) {
          if (!keys || keys.length === 0) return null
          if (t <= keys[0].t) return keys[0].v
          if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].v
          for (var i = 0; i < keys.length - 1; i++) {
            var a = keys[i], b = keys[i + 1]
            if (t >= a.t && t <= b.t) {
              if (a.oType === 'hold' || b.iType === 'hold' || b.t === a.t) return a.v
              var u = (t - a.t) / (b.t - a.t)
              // For colors (strings like '#rrggbb'), pick nearest endpoint (don't blend in CSS keyframe-space).
              if (typeof a.v === 'string') return u < 0.5 ? a.v : b.v
              return a.v + (b.v - a.v) * u
            }
          }
          return keys[keys.length - 1].v
        }
        function hexToRgba (hex, alpha) {
          if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex
          return 'rgba(' + parseInt(hex.substr(1,2),16) + ',' + parseInt(hex.substr(3,2),16) + ',' +
            parseInt(hex.substr(5,2),16) + ',' + round3(alpha) + ')'
        }
        function hueOf (hex) {
          if (!/^#[0-9a-f]{6}$/i.test(hex)) return 0
          var r = parseInt(hex.substr(1,2),16) / 255
          var g = parseInt(hex.substr(3,2),16) / 255
          var b = parseInt(hex.substr(5,2),16) / 255
          var mx = Math.max(r,g,b), mn = Math.min(r,g,b), delta = mx - mn
          if (delta === 0) return 0
          var h = 0
          if (mx === r) h = ((g - b) / delta) * 60
          else if (mx === g) h = ((b - r) / delta + 2) * 60
          else h = ((r - g) / delta + 4) * 60
          return h
        }
        function buildFilterAtTime (t) {
          var parts = []
          var eff = layer.effects
          if (eff.dropShadow) {
            var ds = eff.dropShadow
            var color = effSample(ds.color, t) || '#000000'
            var opacity = (effSample(ds.opacity, t) || 100) / 100
            var dir = ((effSample(ds.direction, t) || 135)) * Math.PI / 180
            var dist = effSample(ds.distance, t) || 5
            var soft = effSample(ds.softness, t) || 5
            var dx = dist * Math.sin(dir)
            var dy = -dist * Math.cos(dir)
            parts.push('drop-shadow(' + round3(dx) + 'px ' + round3(dy) + 'px ' + round3(soft) + 'px ' + hexToRgba(color, opacity) + ')')
          }
          if (eff.blur && eff.blur.radius) {
            parts.push('blur(' + round3(effSample(eff.blur.radius, t) || 0) + 'px)')
          }
          if (eff.invert) parts.push('invert(100%)')
          if (eff.brightnessContrast) {
            var brV = effSample(eff.brightnessContrast.brightness, t) || 0
            var coV = effSample(eff.brightnessContrast.contrast, t) || 0
            parts.push('brightness(' + round3(1 + brV / 100) + ') contrast(' + round3(1 + coV / 100) + ')')
          }
          if (eff.hueSaturation) {
            var hV = effSample(eff.hueSaturation.hue, t) || 0
            var sV = effSample(eff.hueSaturation.saturation, t) || 0
            var lV = effSample(eff.hueSaturation.lightness, t) || 0
            parts.push('hue-rotate(' + round3(hV) + 'deg) saturate(' + round3(1 + sV / 100) + ')')
            if (lV !== 0) parts.push('brightness(' + round3(1 + lV / 100) + ')')
          }
          if (eff.tint) {
            var tWhite = effSample(eff.tint.white, t) || '#ffffff'
            var tAmt = (effSample(eff.tint.amount, t) || 100) / 100
            parts.push('grayscale(' + round3(tAmt) + ') sepia(' + round3(tAmt) + ') hue-rotate(' + round3(hueOf(tWhite)) + 'deg)')
          }
          return parts.join(' ')
        }
        // ── collect animated tracks to decide static vs keyframed ─
        var animTracks = []
        function pushTrack (keys) { if (keys && keys.length > 1) animTracks.push(keys) }
        if (layer.effects.dropShadow) {
          pushTrack(layer.effects.dropShadow.color); pushTrack(layer.effects.dropShadow.opacity)
          pushTrack(layer.effects.dropShadow.direction); pushTrack(layer.effects.dropShadow.distance)
          pushTrack(layer.effects.dropShadow.softness)
        }
        if (layer.effects.blur) pushTrack(layer.effects.blur.radius)
        if (layer.effects.brightnessContrast) {
          pushTrack(layer.effects.brightnessContrast.brightness); pushTrack(layer.effects.brightnessContrast.contrast)
        }
        if (layer.effects.hueSaturation) {
          pushTrack(layer.effects.hueSaturation.hue); pushTrack(layer.effects.hueSaturation.saturation); pushTrack(layer.effects.hueSaturation.lightness)
        }
        if (layer.effects.tint) {
          pushTrack(layer.effects.tint.color); pushTrack(layer.effects.tint.white); pushTrack(layer.effects.tint.amount)
        }
        // Static filter (no animation) — emit inline; Animated — emit @keyframes.
        if (animTracks.length === 0) {
          var staticFilter = buildFilterAtTime(0)
          if (staticFilter) gStyle += ' filter: ' + staticFilter + ';'
        } else {
          // Build union time set across ALL animated effect tracks.
          var effTimeSet = {}
          for (var at = 0; at < animTracks.length; at++) {
            for (var ati = 0; ati < animTracks[at].length; ati++) effTimeSet[animTracks[at][ati].t] = true
          }
          var effTimes = []
          for (var ttk in effTimeSet) if (effTimeSet.hasOwnProperty(ttk)) effTimes.push(Number(ttk))
          effTimes.sort(function (a, b) { return a - b })
          // Emit @keyframes ae-filter-{id} with filter: value per stop.
          var filterLayerIn = (layer.inPoint != null && isFinite(layer.inPoint)) ? Math.max(0, Number(layer.inPoint)) : 0
          var filterLayerOut = (layer.outPoint != null && isFinite(layer.outPoint)) ? Math.min(compDur, Number(layer.outPoint)) : compDur
          var filterLayerDur = Math.max(0.01, filterLayerOut - filterLayerIn)
          var filterBody = []
          for (var ft = 0; ft < effTimes.length; ft++) {
            var ftt = effTimes[ft]
            var frel = (ftt - filterLayerIn) / filterLayerDur
            if (frel < 0) frel = 0
            if (frel > 1) frel = 1
            var fv = buildFilterAtTime(ftt)
            if (fv) filterBody.push('  ' + (frel * 100).toFixed(3) + '% { filter: ' + fv + '; }')
          }
          if (filterBody.length > 0) {
            var filterKfName = 'ae-filter-' + escapeCss(id)
            extraCss.push('@keyframes ' + filterKfName + ' {\n' + filterBody.join('\n') + '\n}')
            extraCss.push('#' + escapeCss(id) + ' { animation: ' + filterKfName + ' ' + filterLayerDur.toFixed(3) +
              's linear ' + filterLayerIn.toFixed(3) + 's infinite both; }')
            // Also set static initial for FOUC avoidance
            gStyle += ' filter: ' + buildFilterAtTime(effTimes[0]) + ';'
          }
        }
      }
      // Layer active range (for mask animation timing + fill animation timing).
      var layerIn = (layer.inPoint != null && isFinite(layer.inPoint)) ? Math.max(0, Number(layer.inPoint)) : 0
      var layerOut = (layer.outPoint != null && isFinite(layer.outPoint)) ? Math.min(compDur, Number(layer.outPoint)) : compDur
      var layerDur = Math.max(0.01, layerOut - layerIn)
      // ADBE Fill effect: override the shape's fill attribute. Animated fill emits
      // an additional @keyframes rule targeting the inner element by id. If all keyframes
      // carry the same color (e.g. 301-sample wiggle with amp=0), skip the animation.
      if (layer.effects && layer.effects.fill && layer.effects.fill.color && layer.effects.fill.color.length > 0) {
        var fillKfs = layer.effects.fill.color
        var initFill = fillKfs[0].v
        // Dedupe: all same → treat as static.
        var allSameFill = true
        for (var fdi = 1; fdi < fillKfs.length; fdi++) {
          if (fillKfs[fdi].v !== initFill) { allSameFill = false; break }
        }
        shape = shape.replace(/ fill="[^"]*"/, ' fill="' + escapeHtml(initFill) + '"')
        if (fillKfs.length > 1 && !allSameFill) {
          // Give the inner shape a unique id so CSS can target its fill.
          var innerId = escapeCss(id) + '_inner'
          shape = shape.replace(/^<(\w+)/, '<$1 id="' + innerId + '"')
          var fillKfName = 'ae-fill-' + innerId
          var fillBody = []
          for (var fi = 0; fi < fillKfs.length; fi++) {
            var ft = fillKfs[fi].t
            var frel = layerDur > 0 ? (ft - layerIn) / layerDur : 0
            if (frel < 0) frel = 0
            if (frel > 1) frel = 1
            // HOLD keyframes (AE "Toggle Hold Keyframe") → CSS step-end: no interpolation,
            // fill jumps instantly to next value at next stop. Without this, CSS smoothly
            // interpolates between colors (white → grey → black) which is wrong for toggle.
            var fillEase = ''
            if (fi < fillKfs.length - 1 && fillKfs[fi].oType === 'hold') {
              fillEase = ' animation-timing-function: step-end;'
            }
            fillBody.push('  ' + (frel * 100).toFixed(3) + '% { fill: ' + fillKfs[fi].v + ';' + fillEase + ' }')
          }
          extraCss.push('@keyframes ' + fillKfName + ' {\n' + fillBody.join('\n') + '\n}')
          extraCss.push('#' + innerId + ' { animation: ' + fillKfName + ' ' + layerDur.toFixed(3) +
            's linear ' + layerIn.toFixed(3) + 's infinite both; }')
        }
      }
      // Masks: full multi-mask composition (lottie-web approach).
      // - Pure ADD / opaque / non-inverted / no feather/expansion → <clipPath> (fast)
      // - Anything else → <mask> with composed sub-paths (Add=white, Subtract=black, etc.)
      // Works for ALL layer types (text/shape/av/solid/null) — layer-type-agnostic.
      var maskAttr = ''
      if (layer.masks && layer.masks.length > 0) {
        var baseId = 'ae-mask-' + escapeCss(id)
        var composed = buildLayerMasking(baseId, layer.masks, layerIn, layerDur, initPos, cw, ch)
        if (composed.def) {
          defs.push(composed.def)
          maskAttr = composed.applyAttr
        }
        // Surface limitations as diagnostic comments (not errors; masks still work for Add/Subtract/Inverted).
        for (var mmi = 0; mmi < layer.masks.length; mmi++) {
          var mmm = layer.masks[mmi]
          if (mmm.mode === 'intersect' || mmm.mode === 'lighten' || mmm.mode === 'darken' || mmm.mode === 'difference') {
            extraCss.push('/* Layer ' + id + ' mask #' + (mmi + 1) + ': mode "' + mmm.mode +
              '" simplified to Add — full composition of this mode is roadmap. */')
          }
        }
      }
      // Track Mattes (P3.1): AE lets a layer be hidden and repurposed as a mask for the layer
      // directly below it. We emit one `<mask>` def per matte-source layer (isTrackMatte=true)
      // and set `mask="url(#trackmatte-N)"` on the consumer layer (trackMatteType ≠ 'none').
      // The matte-source layer itself is NOT pushed as a visible `<g>`.
      //   alpha            → mask-type="alpha", content = matte rendered normally
      //   alpha-inverted   → mask-type="alpha", content inverted via <filter feFuncA tableValues="1 0">
      //   luma             → default mask-type (luminance), content = matte rendered normally
      //   luma-inverted    → default mask-type, content inverted via feColorMatrix negate
      if (layer.isTrackMatte) {
        // Find the consumer (layer directly below in AE = array index i+1 because layers[0] = AE top).
        var consumerIdx = i + 1
        var consumer = layers[consumerIdx] || null
        var cmType = consumer && consumer.trackMatteType ? consumer.trackMatteType : 'alpha'
        var matteInnerTransform = svgTransform
        var needAlphaInvertFilter = (cmType === 'alpha-inverted')
        var needLumaInvertFilter = (cmType === 'luma-inverted')
        var maskType = (cmType === 'alpha' || cmType === 'alpha-inverted') ? ' style="mask-type:alpha"' : ''
        var matteId = 'trackmatte-' + (layer.index != null ? layer.index : i)
        var filterAttr = ''
        if (needAlphaInvertFilter) {
          var fAlphaId = matteId + '-ainv'
          defs.push('<filter id="' + fAlphaId + '" x="-5%" y="-5%" width="110%" height="110%">' +
            '<feComponentTransfer><feFuncA type="table" tableValues="1 0"/></feComponentTransfer></filter>')
          filterAttr = ' filter="url(#' + fAlphaId + ')"'
        } else if (needLumaInvertFilter) {
          var fLumaId = matteId + '-linv'
          defs.push('<filter id="' + fLumaId + '" x="-5%" y="-5%" width="110%" height="110%">' +
            '<feColorMatrix type="matrix" values="-1 0 0 0 1  0 -1 0 0 1  0 0 -1 0 1  0 0 0 1 0"/></filter>')
          filterAttr = ' filter="url(#' + fLumaId + ')"'
        }
        defs.push('<mask id="' + matteId + '" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" ' +
          'x="0" y="0" width="' + cw + '" height="' + ch + '"' + maskType + '>' +
          '<g transform="' + matteInnerTransform + '"' + filterAttr + '>' + shape + '</g>' +
          '</mask>')
        // Skip visible render for matte source layer.
      } else {
        // If this layer CONSUMES a track matte, add mask attribute referencing the source.
        var trackMatteAttr = ''
        if (layer.trackMatteType && layer.trackMatteType !== 'none') {
          var matteSrc = layers[i - 1]
          if (matteSrc && matteSrc.isTrackMatte) {
            var srcId = 'trackmatte-' + (matteSrc.index != null ? matteSrc.index : (i - 1))
            trackMatteAttr = ' mask="url(#' + srcId + ')"'
          }
        }
        parts.push('<g id="' + escapeHtml(id) + '" class="ae-layer" transform="' + svgTransform + '"' + maskAttr + trackMatteAttr + ' style="' + gStyle + '">' +
          shape + '</g>')
        meta.push({ id: id, anchor: anchor, layer: layer })
      }
    }
    return {
      svgInner: parts.join('\n      '),
      layerMeta: meta,
      svgDefs: defs.join('\n      '),
      extraCss: extraCss.join('\n')
    }
  }

  // Build a human-readable HTML comment summarising what was extracted. Placed at the
  // top of the output so users can diff AE's real composition against what the exporter
  // actually saw (layer count, types, sources, blend modes, animation tracks).
  function buildDiagnosticComment (compData, format) {
    var c = compData.comp || {}
    var lines = []
    lines.push('AE Motion Agent — HTML export (' + format + ')')
    lines.push('Composition: "' + (c.name || '?') + '" ' + c.width + 'x' + c.height +
      ' @ ' + (c.frameRate || '?') + 'fps, ' + (c.duration != null ? Number(c.duration).toFixed(2) + 's' : '?') +
      ', bg=' + (c.bgColor || '?'))
    var layers = compData.layers || []
    lines.push('Layers (AE order, top→bottom):')
    for (var i = 0; i < layers.length; i++) {
      var ly = layers[i]
      var kinds = []
      var t = ly.transform || {}
      function kindFor (name, track) {
        if (!track || track.length === 0) return null
        if (track.length === 1 && track[0].iType === 'hold') return null
        return name + '(' + track.length + ')'
      }
      var parts2 = [kindFor('pos', t.position), kindFor('scale', t.scale), kindFor('rot', t.rotation), kindFor('op', t.opacity)]
      for (var pi = 0; pi < parts2.length; pi++) { if (parts2[pi]) kinds.push(parts2[pi]) }
      var kindStr = kinds.length ? kinds.join('/') : 'static'
      var extraDesc = ''
      if (ly.extras && ly.extras.text) extraDesc = ' text="' + (ly.extras.text.text || '') + '"'
      else if (ly.extras && ly.extras.media) {
        var med = ly.extras.media
        extraDesc = med.isSolid ? (' solid ' + med.color + ' ' + med.width + 'x' + med.height)
                                : (' media ' + med.fileName + ' ' + med.width + 'x' + med.height)
      }
      var inOut = 't=[' + (ly.inPoint != null ? Number(ly.inPoint).toFixed(2) : '?') + '..' +
                  (ly.outPoint != null ? Number(ly.outPoint).toFixed(2) : '?') + ']s'
      var blendStr = (ly.blendMode && ly.blendMode !== 'normal') ? ' blend=' + ly.blendMode : ''
      lines.push('  ' + (i + 1) + '. "' + (ly.name || '') + '" (' + ly.type + ')' + extraDesc +
        ' ' + inOut + ' tracks:' + kindStr + blendStr)
    }
    if (compData.warnings && compData.warnings.length) {
      lines.push('Warnings:')
      for (var wi = 0; wi < compData.warnings.length; wi++) {
        lines.push('  • ' + String(compData.warnings[wi]).replace(/--/g, '-').replace(/\n/g, ' '))
      }
    }
    // Strip anything that would close the HTML comment prematurely.
    var text = lines.join('\n').replace(/-->/g, '--').replace(/<!--/g, '&lt;!--')
    return '<!--\n' + text + '\n-->\n'
  }

  // Build a structured diagnostic JSON that gets emitted alongside the HTML.
  // Use case: reproducible diffs between exports. User (or a test harness) can
  // inspect exactly what was extracted, what was translated, and what was dropped —
  // without visually comparing HTML to AE previews. Every animated track, every mask
  // property (incl. expansion/opacity keyframes), every effect with its parameters,
  // plus a derived summary of counts. Output is fully deterministic (JSON.stringify
  // with stable key order from host + no timestamps/random).
  function buildDiagnosticJson (compData, format) {
    var c = compData.comp || {}
    var layers = compData.layers || []
    // Summary: derived counts that help the user scan for anomalies at a glance.
    var effectCounts = { fill: 0, dropShadow: 0, blur: 0, invert: 0, brightnessContrast: 0, hueSaturation: 0, tint: 0 }
    var blendCounts = {}
    var maskCount = 0
    var maskWithShapeAnim = 0
    var maskWithOpacityAnim = 0
    var maskWithExpansionAnim = 0
    var maskInvertedCount = 0
    var parented = []
    var bakedExpressions = 0
    var totalKeyframes = 0
    var perLayerSummary = []
    for (var i = 0; i < layers.length; i++) {
      var ly = layers[i] || {}
      // Transform keyframe counts
      var t = ly.transform || {}
      var posN = (t.position && t.position.length) || 0
      var scN = (t.scale && t.scale.length) || 0
      var rtN = (t.rotation && t.rotation.length) || 0
      var opN = (t.opacity && t.opacity.length) || 0
      totalKeyframes += posN + scN + rtN + opN
      // Heuristic: an expression bake shows up as 30–600 samples with linear iType/oType
      var likelyBaked = posN > 10 && t.position[0] && t.position[0].iType === 'linear' && t.position[0].ei == null
      if (likelyBaked) bakedExpressions++
      // Effects
      var eff = ly.effects || {}
      if (eff.fill) effectCounts.fill++
      if (eff.dropShadow) effectCounts.dropShadow++
      if (eff.blur) effectCounts.blur++
      if (eff.invert) effectCounts.invert++
      if (eff.brightnessContrast) effectCounts.brightnessContrast++
      if (eff.hueSaturation) effectCounts.hueSaturation++
      if (eff.tint) effectCounts.tint++
      // Blend modes
      var bm = ly.blendMode || 'normal'
      blendCounts[bm] = (blendCounts[bm] || 0) + 1
      // Masks
      var masks = ly.masks || []
      maskCount += masks.length
      for (var mi = 0; mi < masks.length; mi++) {
        var m = masks[mi]
        if (m.shapeKeys && m.shapeKeys.length > 1) maskWithShapeAnim++
        if (m.opacityKeys && m.opacityKeys.length > 1) maskWithOpacityAnim++
        if (m.expansionKeys && m.expansionKeys.length > 1) maskWithExpansionAnim++
        if (m.inverted) maskInvertedCount++
      }
      // Parent chain
      if (ly.parentIndex != null) parented.push({ layer: ly.name || '', parentIndex: ly.parentIndex })
      // Per-layer compact summary
      perLayerSummary.push({
        index: i + 1,
        name: ly.name || '',
        type: ly.type,
        inPoint: ly.inPoint,
        outPoint: ly.outPoint,
        enabled: ly.enabled,
        blendMode: bm,
        parentIndex: ly.parentIndex || null,
        tracks: { position: posN, scale: scN, rotation: rtN, opacity: opN },
        likelyBakedExpression: !!likelyBaked,
        masks: masks.map(function (mm) {
          return {
            name: mm.name,
            inverted: !!mm.inverted,
            opacity: mm.opacity,
            expansion: mm.expansion,
            feather: mm.feather,
            shapeKeyframes: (mm.shapeKeys || []).length,
            opacityKeyframes: (mm.opacityKeys || []).length,
            expansionKeyframes: (mm.expansionKeys || []).length
          }
        }),
        effects: Object.keys(eff || {}).reduce(function (acc, k) {
          acc[k] = true
          return acc
        }, {})
      })
    }

    var summary = {
      layersTotal: layers.length,
      bakedExpressions: bakedExpressions,
      totalTransformKeyframes: totalKeyframes,
      effectsRecognized: effectCounts,
      blendModes: blendCounts,
      masks: {
        total: maskCount,
        withAnimatedShape: maskWithShapeAnim,
        withAnimatedOpacity: maskWithOpacityAnim,
        withAnimatedExpansion: maskWithExpansionAnim,
        inverted: maskInvertedCount
      },
      parentedLayers: parented
    }

    var doc = {
      exporter: 'AE Motion Agent HTML export',
      format: format,
      comp: {
        name: c.name || null,
        width: c.width,
        height: c.height,
        duration: c.duration,
        frameRate: c.frameRate,
        pixelAspect: c.pixelAspect || 1,
        bgColor: c.bgColor || null
      },
      summary: summary,
      layers: perLayerSummary,
      warnings: (compData.warnings || []).slice(),
      // Full raw data for byte-level diffs between exports. Grow-resistant — the
      // enriched per-layer summary above is always the fast-path for human reading.
      raw: {
        layers: layers
      }
    }
    return JSON.stringify(doc, null, 2)
  }

  function generateCssSvg (compData, opts) {
    var assetFiles = { list: [], _seen: {} }
    var svg = buildSvgShapes(compData, assetFiles)
    var comp = compData.comp
    var name = slugify(opts.name || comp.name)
    var dur = Math.max(0.1, Number(comp.duration) || 1)
    var cssRules = []
    var layerAnims = []

    for (var mi = 0; mi < svg.layerMeta.length; mi++) {
      var m = svg.layerMeta[mi]
      var layer = m.layer
      // P3.3: Parented layers need to inherit keyframe times from ancestors so their
      // baked CSS animation samples the parent's motion even when the child itself is static.
      var kfTimes
      if (layer.parentIndex != null) {
        var tset = {}
        var ka = collectKeyTimes(layer.transform)
        for (var kti = 0; kti < ka.length; kti++) tset[ka[kti]] = true
        var cur = layer, hops = 0
        while (cur && hops < 32) {
          if (cur.parentIndex == null) break
          cur = findLayerByAeIndex(compData.layers, cur.parentIndex)
          if (!cur) break
          var pk = collectKeyTimes(cur.transform)
          for (var ppi = 0; ppi < pk.length; ppi++) tset[pk[ppi]] = true
          hops++
        }
        kfTimes = []
        for (var tk in tset) if (tset.hasOwnProperty(tk)) kfTimes.push(Number(tk))
        kfTimes.sort(function (a, b) { return a - b })
      } else {
        kfTimes = collectKeyTimes(layer.transform)
      }
      if (kfTimes.length < 2) continue
      // Layer's active time range (falls back to full comp duration when unknown).
      var layerIn = (layer.inPoint != null && isFinite(layer.inPoint)) ? Math.max(0, Number(layer.inPoint)) : 0
      var layerOut = (layer.outPoint != null && isFinite(layer.outPoint)) ? Math.min(dur, Number(layer.outPoint)) : dur
      var layerDur = Math.max(0.01, layerOut - layerIn)
      // Build @keyframes for this layer with a transform string + opacity per stop.
      // Percent is normalized to the LAYER's own duration so the animation can be
      // scheduled via animation-delay/duration matching the layer's active range.
      var keyframeBody = []
      for (var ki = 0; ki < kfTimes.length; ki++) {
        var t = kfTimes[ki]
        var rel = (t - layerIn) / layerDur
        if (rel < 0) rel = 0
        if (rel > 1) rel = 1
        var pct = (rel * 100).toFixed(3)
        var pos = interpPositionSpatial(layer.transform.position, t) || m.anchor
        var sc = interpValue(layer.transform.scale, t) || [100, 100]
        var rt = interpValue(layer.transform.rotation, t) || 0
        var op = interpValue(layer.transform.opacity, t)
        if (op == null) op = 100
        var dx = round3(pos[0] - m.anchor[0])
        var dy = round3(pos[1] - m.anchor[1])
        var sxN, syN
        if (Array.isArray(sc) && sc.length >= 2) {
          sxN = sc[0] / 100
          syN = sc[1] / 100
        } else {
          sxN = (Number(sc) || 100) / 100
          syN = sxN
        }
        var rtDeg = typeof rt === 'number' ? rt : (Array.isArray(rt) ? rt[0] : 0)
        // Auto-orient: rotation derived from position velocity (atan2 of delta between samples).
        // Merged on top of keyframed rotation so users can combine both.
        if (layer.autoOrient) {
          var EPS = 1e-3
          var pPrev = interpPositionSpatial(layer.transform.position, Math.max(0, t - EPS)) || pos
          var pNext = interpPositionSpatial(layer.transform.position, t + EPS) || pos
          var ddx = pNext[0] - pPrev[0]
          var ddy = pNext[1] - pPrev[1]
          if (Math.abs(ddx) > 1e-4 || Math.abs(ddy) > 1e-4) {
            rtDeg += Math.atan2(ddy, ddx) * 180 / Math.PI
          }
        }
        // Per-stop easing: animation-timing-function applied AT a keyframe stop controls
        // the transition from that stop to the NEXT one. Encodes AE's speed+influence
        // bezier so curves aren't flattened to linear interpolation.
        // HOLD keyframes (AE "Toggle Hold Keyframe") → CSS `step-end`: no interpolation,
        // value jumps instantly at the next stop (matches AE's instant-switch behaviour).
        var easingDecl = ''
        if (ki < kfTimes.length - 1) {
          // A HOLD stop exists if ANY animated track has oType='hold' at this time
          // (position/scale/rotation/opacity). If so, we force step-end so the final
          // composed transform jumps rather than interpolating between keys.
          // IMPORTANT: a STATIC track (single keyframe from _ehtmlExtractKeyframes) carries
          // oType='hold' by convention — that's an artifact, not a user-set Toggle Hold.
          // Skip tracks with <2 keyframes and skip the FINAL keyframe of any track (its oType
          // is meaningless). Otherwise a static position could lock scale/rotation to step-end
          // and freeze the composed transform until the last stop.
          var holdHere = false
          var tr = layer.transform
          var tracks = [tr.position, tr.scale, tr.rotation, tr.opacity]
          for (var tri = 0; tri < tracks.length; tri++) {
            var trk = tracks[tri]
            if (!trk || trk.length < 2) continue
            for (var tki = 0; tki < trk.length - 1; tki++) {
              if (Math.abs(trk[tki].t - t) < 1e-6 && trk[tki].oType === 'hold') { holdHere = true; break }
            }
            if (holdHere) break
          }
          if (holdHere) {
            easingDecl = ' animation-timing-function: step-end;'
          } else {
            var aRec = findKfAtTime(layer.transform, t)
            easingDecl = ' animation-timing-function: ' + influenceToBezier(aRec.oInf, aRec.iInfNext) + ';'
          }
        }
        // P3.3: Parented layers get a composed world matrix; unparented keep the compact TRS form.
        if (layer.parentIndex != null) {
          var wmK = composedMatrixAt(layer, t, compData.layers)
          var opK = composedOpacityAt(layer, t, compData.layers)
          keyframeBody.push('  ' + pct + '% { transform: ' + matToCss(wmK) +
            '; opacity: ' + round3(opK) + ';' + easingDecl + ' }')
        } else {
          keyframeBody.push('  ' + pct + '% { transform: translate(' + round3(m.anchor[0] + dx) + 'px, ' + round3(m.anchor[1] + dy) +
            'px) rotate(' + round3(rtDeg) + 'deg) scale(' + round3(sxN) + ', ' + round3(syN) + '); opacity: ' + round3(op / 100) + ';' + easingDecl + ' }')
        }
      }
      var kfName = 'ae-kf-' + escapeCss(name) + '-' + mi
      cssRules.push('@keyframes ' + kfName + ' {\n' + keyframeBody.join('\n') + '\n}')
      // Delay by layer inPoint, span only the layer's active range. fill-mode=both keeps
      // the element at its first keyframe before start and at the last after end, so the
      // layer behaves like a real AE layer that "exists" only during [inPoint, outPoint].
      layerAnims.push('#' + m.id + ' { animation: ' + kfName + ' ' + round3(layerDur) + 's linear ' + round3(layerIn) + 's infinite both; }')
    }

    var html = buildDiagnosticComment(compData, 'css-svg') + '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>' +
      escapeHtml(name) + '</title>\n<style>\n' +
      'html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: ' + escapeHtml(comp.bgColor || '#000000') + '; }\n' +
      '/* Composition native size: ' + comp.width + 'x' + comp.height + '. SVG width=100%/height=100% + preserveAspectRatio letterboxes. All positioning is done in SVG user-units via SVG transform attribute (not CSS transform — which has broken behaviour on SVG children in some browsers). */\n' +
      '.ae-stage { position: absolute; inset: 0; overflow: hidden; }\n' +
      '.ae-svg { display: block; width: 100%; height: 100%; overflow: hidden; }\n' +
      '.ae-layer { }\n' +
      layerAnims.join('\n') + '\n\n' +
      cssRules.join('\n\n') + (svg.extraCss ? '\n\n' + svg.extraCss : '') + '\n</style>\n</head>\n<body>\n' +
      '<div class="ae-stage">\n  <svg class="ae-svg" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ' + comp.width + ' ' + comp.height + '" preserveAspectRatio="xMidYMid meet" overflow="hidden">\n' +
      '    <defs>\n      <clipPath id="ae-comp-clip"><rect x="0" y="0" width="' + comp.width + '" height="' + comp.height + '"/></clipPath>\n      ' + (svg.svgDefs || '') + '\n    </defs>\n' +
      '    <g clip-path="url(#ae-comp-clip)">\n      ' + svg.svgInner + '\n    </g>\n  </svg>\n</div>\n' +
      '</body>\n</html>\n'

    var warnings = []
    if (svg.layerMeta.length === 0) warnings.push('No exportable layers found — output contains empty stage.')
    if (layerAnims.length === 0 && svg.layerMeta.length > 0) warnings.push('No animated properties found — static snapshot exported.')

    return {
      html: html,
      files: [
        { name: name + '.html', content: html },
        { name: name + '.diagnostic.json', content: buildDiagnosticJson(compData, 'css-svg') }
      ].concat(assetFiles.list),
      warnings: warnings
    }
  }

  function generateGsapSvg (compData, opts) {
    var assetFiles = { list: [], _seen: {} }
    var svg = buildSvgShapes(compData, assetFiles)
    var comp = compData.comp
    var name = slugify(opts.name || comp.name)
    var dur = Math.max(0.1, Number(comp.duration) || 1)
    var timelineCalls = []

    for (var mi = 0; mi < svg.layerMeta.length; mi++) {
      var m = svg.layerMeta[mi]
      var layer = m.layer
      var kfTimes = collectKeyTimes(layer.transform)
      if (kfTimes.length === 0) continue
      // First keyframe = set() on the layer.
      var firstT = kfTimes[0]
      var firstPos = interpPositionSpatial(layer.transform.position, firstT) || m.anchor
      var firstScale = interpValue(layer.transform.scale, firstT) || [100, 100]
      var firstRot = interpValue(layer.transform.rotation, firstT)
      var firstOp = interpValue(layer.transform.opacity, firstT)
      if (firstRot == null) firstRot = 0
      if (firstOp == null) firstOp = 100
      var fSx = Array.isArray(firstScale) ? firstScale[0] / 100 : (firstScale / 100)
      var fSy = Array.isArray(firstScale) && firstScale.length > 1 ? firstScale[1] / 100 : fSx
      var fx = round3(firstPos[0] - m.anchor[0])
      var fy = round3(firstPos[1] - m.anchor[1])
      var fRd = typeof firstRot === 'number' ? firstRot : (Array.isArray(firstRot) ? firstRot[0] : 0)

      timelineCalls.push('tl.set("#' + m.id + '", { x: ' + fx + ', y: ' + fy + ', rotation: ' + round3(fRd) +
        ', scaleX: ' + round3(fSx) + ', scaleY: ' + round3(fSy) + ', opacity: ' + round3(firstOp / 100) + ', transformOrigin: "50% 50%" }, ' + round3(firstT) + ');')

      for (var ki = 1; ki < kfTimes.length; ki++) {
        var a = kfTimes[ki - 1]
        var t = kfTimes[ki]
        var pos = interpPositionSpatial(layer.transform.position, t) || m.anchor
        var sc = interpValue(layer.transform.scale, t) || [100, 100]
        var rt = interpValue(layer.transform.rotation, t)
        var op = interpValue(layer.transform.opacity, t)
        if (rt == null) rt = 0
        if (op == null) op = 100
        var sx = Array.isArray(sc) ? sc[0] / 100 : (sc / 100)
        var sy = Array.isArray(sc) && sc.length > 1 ? sc[1] / 100 : sx
        var dx = round3(pos[0] - m.anchor[0])
        var dy = round3(pos[1] - m.anchor[1])
        var rtDeg = typeof rt === 'number' ? rt : (Array.isArray(rt) ? rt[0] : 0)
        // Find the relevant keyframe record to grab easing influences
        var aRec = findKfAtTime(layer.transform, a)
        var bezier = influenceToBezier(aRec.oInf, aRec.iInfNext)
        var durTween = round3(Math.max(0.001, t - a))
        timelineCalls.push('tl.to("#' + m.id + '", { x: ' + dx + ', y: ' + dy + ', rotation: ' + round3(rtDeg) +
          ', scaleX: ' + round3(sx) + ', scaleY: ' + round3(sy) + ', opacity: ' + round3(op / 100) +
          ', duration: ' + durTween + ', ease: "' + bezier + '" }, ' + round3(a) + ');')
      }
    }

    var tlBody = timelineCalls.join('\n    ')
    var gsapSrc = 'https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js'
    var html = buildDiagnosticComment(compData, 'gsap-svg') + '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>' +
      escapeHtml(name) + '</title>\n<style>\n' +
      'html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: ' + escapeHtml(comp.bgColor || '#000000') + '; }\n' +
      '/* Composition native size: ' + comp.width + 'x' + comp.height + '. SVG width=100%/height=100% + preserveAspectRatio letterboxes. All positioning is done in SVG user-units via SVG transform attribute (not CSS transform — which has broken behaviour on SVG children in some browsers). */\n' +
      '.ae-stage { position: absolute; inset: 0; overflow: hidden; }\n' +
      '.ae-svg { display: block; width: 100%; height: 100%; overflow: hidden; }\n' +
      '.ae-layer { }\n' +
      (svg.extraCss ? svg.extraCss + '\n' : '') +
      '</style>\n</head>\n<body>\n' +
      '<div class="ae-stage">\n  <svg class="ae-svg" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ' + comp.width + ' ' + comp.height + '" preserveAspectRatio="xMidYMid meet" overflow="hidden">\n' +
      '    <defs>\n      <clipPath id="ae-comp-clip"><rect x="0" y="0" width="' + comp.width + '" height="' + comp.height + '"/></clipPath>\n      ' + (svg.svgDefs || '') + '\n    </defs>\n' +
      '    <g clip-path="url(#ae-comp-clip)">\n      ' + svg.svgInner + '\n    </g>\n  </svg>\n</div>\n' +
      '<script src="' + gsapSrc + '"><\/script>\n' +
      '<script>\n' +
      '  // For banner delivery on Яндекс/VK: replace the CDN <script> above with an inlined\n' +
      '  // gsap.min.js to satisfy the "no external network calls" rule.\n' +
      '  document.addEventListener("DOMContentLoaded", function () {\n' +
      '    var tl = gsap.timeline({ repeat: -1 });\n    ' + tlBody + '\n  });\n' +
      '<\/script>\n' +
      '</body>\n</html>\n'

    var warnings = []
    if (svg.layerMeta.length === 0) warnings.push('No exportable layers found — output contains empty stage.')
    warnings.push('GSAP is loaded from CDN. For Яндекс/VK HTML5 banners, download gsap.min.js and inline it.')

    return {
      html: html,
      files: [
        { name: name + '.html', content: html },
        { name: name + '.diagnostic.json', content: buildDiagnosticJson(compData, 'gsap-svg') }
      ].concat(assetFiles.list),
      warnings: warnings
    }
  }

  // P2.3: Lottie JSON (bodymovin) generator — maps our extracted comp model to the
  // bodymovin schema consumed by lottie-web / lottiefiles. This is an MVP supporting:
  // shape layers (rect/ellipse/star/path + solid fill/stroke), text layers (basic doc),
  // transforms (anchor/position/scale/rotation/opacity with easing bezier), animated
  // properties (linear / hold / cubic-bezier via ei/eo). Gradient fills, effects, masks,
  // repeaters, track mattes, and text animators are intentionally NOT mapped — users
  // needing those should export CSS+SVG. The output is a minimal but valid Lottie file.
  function generateLottieJson (compData, opts) {
    var name = slugify(opts.name || (compData.comp && compData.comp.name) || 'animation')
    var comp = compData.comp || {}
    var fr = Number(comp.frameRate) || Number(comp.fps) || 30
    var dur = Math.max(0.1, Number(comp.duration) || 1)
    var ip = 0
    var op = Math.ceil(dur * fr)
    // Convert one of our keyframe arrays to bodymovin `.k` array or scalar.
    // Vec props: wrap each value as array; scalar: pass through. Supports linear/hold/bezier easing.
    function toLottieProp (kfs, scalar) {
      if (!kfs || kfs.length === 0) return { a: 0, k: scalar ? 0 : [0, 0, 0] }
      if (kfs.length === 1) {
        var v = kfs[0].v
        if (Array.isArray(v)) return { a: 0, k: v.slice() }
        return { a: 0, k: scalar ? v : [v] }
      }
      var k = []
      for (var i = 0; i < kfs.length; i++) {
        var a = kfs[i], b = kfs[i + 1]
        var entry = { t: a.t * fr }
        var sv = a.v
        entry.s = Array.isArray(sv) ? sv.slice() : [sv]
        if (b) {
          var ev = b.v
          entry.e = Array.isArray(ev) ? ev.slice() : [ev]
          if (a.oType === 'hold' || b.iType === 'hold') {
            entry.h = 1
          } else {
            // Lottie Bezier easing: i/o each {x:[...], y:[...]}.
            var xO = Math.max(0, Math.min(1, (a.eo == null ? 33.3 : a.eo) / 100))
            var xI = Math.max(0, Math.min(1, (b.ei == null ? 33.3 : b.ei) / 100))
            entry.o = { x: [xO], y: [0] }
            entry.i = { x: [1 - xI], y: [1] }
          }
          // P3.2: spatial tangents for position keyframes
          if (a.to) entry.to = a.to.slice()
          if (b.ti) entry.ti = b.ti.slice()
        }
        k.push(entry)
      }
      return { a: 1, k: k }
    }
    // Map our shape primitive + fill/stroke to bodymovin shape items.
    function mapShapePrimitive (s) {
      if (s.primitive === 'rect') {
        return { ty: 'rc', nm: 'Rect', d: 1, p: { a: 0, k: s.position || [0, 0] },
          s: { a: 0, k: s.size || [100, 100] }, r: { a: 0, k: s.roundness || 0 } }
      }
      if (s.primitive === 'ellipse') {
        return { ty: 'el', nm: 'Ellipse', d: 1, p: { a: 0, k: s.position || [0, 0] }, s: { a: 0, k: s.size || [100, 100] } }
      }
      if (s.primitive === 'polystar') {
        return { ty: 'sr', nm: 'Polystar', d: 1, sy: s.polystarType === 'polygon' ? 2 : 1,
          pt: { a: 0, k: s.points || 5 }, p: { a: 0, k: s.position || [0, 0] },
          r: { a: 0, k: s.rotation || 0 }, ir: { a: 0, k: s.innerRadius || 0 },
          is: { a: 0, k: s.innerRoundness || 0 }, or: { a: 0, k: s.outerRadius || 50 },
          os: { a: 0, k: s.outerRoundness || 0 } }
      }
      if (s.primitive === 'path' && s.path) {
        // Lottie path: {i:[], o:[], v:[], c:bool}
        return { ty: 'sh', nm: 'Path', ks: { a: 0, k: {
          i: s.path.inTangents || [], o: s.path.outTangents || [], v: s.path.vertices || [], c: !!s.path.closed
        } } }
      }
      return null
    }
    function hexToLottieColor (hex, alpha) {
      if (!hex || typeof hex !== 'string') return [1, 1, 1, alpha == null ? 1 : alpha]
      var m3 = /^#?([a-f0-9]{3})$/i.exec(hex)
      var h
      if (m3) {
        // Expand 3-char shorthand (#rgb → #rrggbb)
        h = m3[1].charAt(0) + m3[1].charAt(0) +
            m3[1].charAt(1) + m3[1].charAt(1) +
            m3[1].charAt(2) + m3[1].charAt(2)
      } else {
        var m6 = /^#?([a-f0-9]{6})$/i.exec(hex)
        if (!m6) return [1, 1, 1, alpha == null ? 1 : alpha]
        h = m6[1]
      }
      return [
        parseInt(h.substr(0, 2), 16) / 255,
        parseInt(h.substr(2, 2), 16) / 255,
        parseInt(h.substr(4, 2), 16) / 255,
        alpha == null ? 1 : alpha
      ]
    }
    function lottieFill (f) {
      if (f.gradient) {
        // Gradient fills aren't mapped in this MVP — substitute first stop as solid.
        var firstStop = f.stops && f.stops[0]
        return { ty: 'fl', nm: 'Fill', c: { a: 0, k: hexToLottieColor(firstStop ? firstStop.color : '#ffffff', 1) },
          o: { a: 0, k: Math.round((f.opacity || 1) * 100) } }
      }
      return { ty: 'fl', nm: 'Fill', c: { a: 0, k: hexToLottieColor(f.color, 1) },
        o: { a: 0, k: Math.round((f.opacity || 1) * 100) } }
    }
    function lottieStroke (s) {
      return { ty: 'st', nm: 'Stroke',
        c: { a: 0, k: hexToLottieColor(s.color, 1) },
        o: { a: 0, k: Math.round((s.opacity || 1) * 100) },
        w: { a: 0, k: s.width || 1 },
        lc: s.lineCap === 'round' ? 2 : (s.lineCap === 'square' ? 3 : 1),
        lj: s.lineJoin === 'round' ? 2 : (s.lineJoin === 'bevel' ? 3 : 1),
        ml: s.miterLimit || 4 }
    }
    function layerTransform (layer) {
      var pos = toLottieProp(layer.transform.position || []) // vec3
      if (pos.a === 0 && Array.isArray(pos.k) && pos.k.length === 2) pos.k.push(0)
      var scl = toLottieProp(layer.transform.scale || [])
      if (scl.a === 0 && Array.isArray(scl.k) && scl.k.length === 2) scl.k.push(100)
      var rot = toLottieProp(layer.transform.rotation || [], true)
      var op = toLottieProp(layer.transform.opacity || [], true)
      var anc = layer.anchor || [0, 0]
      return {
        o: op,
        r: rot,
        p: pos,
        a: { a: 0, k: [anc[0], anc[1], 0] },
        s: scl
      }
    }
    var layersOut = []
    var srcLayers = compData.layers || []
    for (var li = 0; li < srcLayers.length; li++) {
      var ly = srcLayers[li]
      var entry = {
        ddd: 0,
        ind: ly.index || (li + 1),
        nm: ly.name || '',
        sr: 1,
        ks: layerTransform(ly),
        ao: ly.autoOrient ? 1 : 0,
        ip: Math.round((ly.inPoint != null ? ly.inPoint : 0) * fr),
        op: Math.round((ly.outPoint != null ? ly.outPoint : dur) * fr),
        st: 0,
        bm: 0
      }
      if (ly.parentIndex) entry.parent = ly.parentIndex
      if (ly.type === 'shape' && ly.extras && ly.extras.shape) {
        entry.ty = 4
        var sh = ly.extras.shape
        var items = []
        var shapesList = sh.shapes || []
        for (var si = 0; si < shapesList.length; si++) {
          var sItem = mapShapePrimitive(shapesList[si])
          if (sItem) items.push(sItem)
        }
        var fillsList = sh.fills || []
        for (var fi = 0; fi < fillsList.length; fi++) items.push(lottieFill(fillsList[fi]))
        var strokesList = sh.strokes || []
        for (var sti = 0; sti < strokesList.length; sti++) items.push(lottieStroke(strokesList[sti]))
        // Group-wrap as bodymovin expects items inside a "gr" group
        items.push({ ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] },
          r: { a: 0, k: 0 }, o: { a: 0, k: 100 } })
        entry.shapes = [{ ty: 'gr', nm: 'Group 1', it: items }]
      } else if (ly.type === 'text' && ly.extras && ly.extras.text) {
        entry.ty = 5
        var tx = ly.extras.text
        entry.t = {
          d: { k: [{ s: {
            s: tx.fontSize || 48,
            f: tx.fontFamily || 'sans-serif',
            t: tx.text || '',
            j: tx.justification === 'center' ? 1 : (tx.justification === 'right' ? 2 : 0),
            tr: tx.tracking || 0,
            lh: tx.leading || (tx.fontSize || 48) * 1.2,
            ls: 0,
            fc: hexToLottieColor(tx.fillColor || '#ffffff').slice(0, 3)
          }, t: 0 }] },
          p: {},
          m: { g: 1, a: { a: 0, k: [0, 0] } },
          a: []
        }
      } else if (ly.type === 'av' || ly.type === 'null' || ly.type === 'adjustment') {
        // Generic solid layer fallback.
        entry.ty = 1
        entry.sw = comp.width || 100
        entry.sh = comp.height || 100
        entry.sc = (ly.extras && ly.extras.media && ly.extras.media.color) || '#808080'
      } else {
        continue
      }
      layersOut.push(entry)
    }
    var lottie = {
      v: '5.7.0',
      fr: fr,
      ip: ip,
      op: op,
      w: comp.width || 100,
      h: comp.height || 100,
      nm: comp.name || name,
      ddd: 0,
      assets: [],
      layers: layersOut,
      meta: {
        g: 'AE Motion Agent HTML Exporter (P2.3 MVP)'
      }
    }
    var jsonStr = JSON.stringify(lottie)
    return {
      html: '',
      files: [
        { name: name + '.json', content: jsonStr },
        { name: name + '.diagnostic.json', content: buildDiagnosticJson(compData, 'lottie') }
      ],
      warnings: layersOut.length === 0 ? ['No exportable layers found for Lottie output.'] :
        ['Lottie MVP: gradients, effects, masks, repeaters, track mattes, text animators are NOT mapped. Export CSS+SVG to preserve those.']
    }
  }

  function generateJsonRaw (compData, opts) {
    var name = slugify(opts.name || (compData.comp && compData.comp.name) || 'animation')
    var jsonStr = JSON.stringify(compData, null, 2)
    return {
      html: '',
      files: [
        { name: name + '.json', content: jsonStr },
        { name: name + '.diagnostic.json', content: buildDiagnosticJson(compData, 'json-raw') }
      ],
      warnings: compData.layers && compData.layers.length === 0 ? ['No layers in comp'] : []
    }
  }

  // ─── Shared helpers ───────────────────────────────────────────────────

  function collectKeyTimes (transform) {
    var set = {}
    function add (kfs) {
      if (!kfs) return
      for (var i = 0; i < kfs.length; i++) set[kfs[i].t] = true
    }
    add(transform.position); add(transform.scale); add(transform.rotation); add(transform.opacity)
    // P3.2: Spatial-bezier subdivision — between every pair of position keyframes that have
    // non-zero out/in tangents, insert intermediate time samples so the baked CSS @keyframes
    // trace the curve instead of zigzagging linearly.
    var pos = transform.position
    if (pos && pos.length >= 2) {
      var SUBDIV = 6 // 6 intermediate samples per curved segment (7 total steps incl. endpoints)
      for (var pi = 0; pi < pos.length - 1; pi++) {
        var A = pos[pi], B = pos[pi + 1]
        if (A.oType === 'hold' || B.iType === 'hold') continue
        if (!hasSpatialTangent(A) && !hasSpatialTangent(B)) continue
        var span = B.t - A.t
        if (span <= 1e-6) continue
        for (var sk = 1; sk < SUBDIV; sk++) {
          set[A.t + span * (sk / SUBDIV)] = true
        }
      }
    }
    var arr = []
    for (var k in set) if (set.hasOwnProperty(k)) arr.push(Number(k))
    arr.sort(function (a, b) { return a - b })
    return arr
  }

  function findKfAtTime (transform, t) {
    // Return easing influences around time t (using position track as primary).
    var kfs = transform.position && transform.position.length ? transform.position : (transform.opacity || [])
    var out = { oInf: 33.3, iInfNext: 33.3 }
    for (var i = 0; i < kfs.length; i++) {
      if (Math.abs(kfs[i].t - t) < 1e-6) {
        out.oInf = kfs[i].eo != null ? kfs[i].eo : 33.3
        var next = kfs[i + 1]
        if (next) out.iInfNext = next.ei != null ? next.ei : 33.3
        return out
      }
    }
    return out
  }

  // ─── Public entry ─────────────────────────────────────────────────────

  function generate (format, compData, opts) {
    opts = opts || {}
    if (!compData || !compData.comp) return emptyGenerate('compData missing comp info')
    if (!compData.layers) compData.layers = []
    var result
    if (format === 'css-svg') result = generateCssSvg(compData, opts)
    else if (format === 'gsap-svg') result = generateGsapSvg(compData, opts)
    else if (format === 'json-raw') result = generateJsonRaw(compData, opts)
    else if (format === 'lottie' || format === 'lottie-json') result = generateLottieJson(compData, opts)
    else return emptyGenerate('Unknown format: ' + format)

    // Merge host-side warnings from comp extraction
    if (compData.warnings && compData.warnings.length) {
      result.warnings = (result.warnings || []).concat(compData.warnings)
    }
    return result
  }

  // Ease-and-Wizz palette: 25 Penner easings as CSS cubic-bezier tuples.
  // Usage: HtmlExporter.easings['outBounce'] → 'cubic-bezier(0.34, 1.56, 0.64, 1)'.
  // Canonical Penner/Robert-Penner set.
  var EASINGS = {
    linear:       'cubic-bezier(0.000, 0.000, 1.000, 1.000)',
    inSine:       'cubic-bezier(0.470, 0.000, 0.745, 0.715)',
    outSine:      'cubic-bezier(0.390, 0.575, 0.565, 1.000)',
    inOutSine:    'cubic-bezier(0.445, 0.050, 0.550, 0.950)',
    inQuad:       'cubic-bezier(0.550, 0.085, 0.680, 0.530)',
    outQuad:      'cubic-bezier(0.250, 0.460, 0.450, 0.940)',
    inOutQuad:    'cubic-bezier(0.455, 0.030, 0.515, 0.955)',
    inCubic:      'cubic-bezier(0.550, 0.055, 0.675, 0.190)',
    outCubic:     'cubic-bezier(0.215, 0.610, 0.355, 1.000)',
    inOutCubic:   'cubic-bezier(0.645, 0.045, 0.355, 1.000)',
    inQuart:      'cubic-bezier(0.895, 0.030, 0.685, 0.220)',
    outQuart:     'cubic-bezier(0.165, 0.840, 0.440, 1.000)',
    inOutQuart:   'cubic-bezier(0.770, 0.000, 0.175, 1.000)',
    inQuint:      'cubic-bezier(0.755, 0.050, 0.855, 0.060)',
    outQuint:     'cubic-bezier(0.230, 1.000, 0.320, 1.000)',
    inOutQuint:   'cubic-bezier(0.860, 0.000, 0.070, 1.000)',
    inExpo:       'cubic-bezier(0.950, 0.050, 0.795, 0.035)',
    outExpo:      'cubic-bezier(0.190, 1.000, 0.220, 1.000)',
    inOutExpo:    'cubic-bezier(1.000, 0.000, 0.000, 1.000)',
    inCirc:       'cubic-bezier(0.600, 0.040, 0.980, 0.335)',
    outCirc:      'cubic-bezier(0.075, 0.820, 0.165, 1.000)',
    inOutCirc:    'cubic-bezier(0.785, 0.135, 0.150, 0.860)',
    inBack:       'cubic-bezier(0.600, -0.280, 0.735, 0.045)',
    outBack:      'cubic-bezier(0.175, 0.885, 0.320, 1.275)',
    inOutBack:    'cubic-bezier(0.680, -0.550, 0.265, 1.550)'
  }

  window.HtmlExporter = { generate: generate, easings: EASINGS }
})()
