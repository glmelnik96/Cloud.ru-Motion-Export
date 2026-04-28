// ============================================================================
// Cloud.ru Motion Export — ExtendScript host script
// ============================================================================
//
// Exposes two host functions called from the panel UI (main.js via hostBridge.js):
//   • motionExport_extractCompForHtml()  — read active comp into JSON
//   • motionExport_selectExportFolder()  — open native folder picker
//
// All code is ES3-compatible (ExtendScript). No let/const/arrow/forEach.
// ============================================================================

// ============================================================================
// HTML Export — comp data extraction for the Export panel
// ============================================================================
//
// motionExport_extractCompForHtml()
//   Extracts the active composition into a structured JSON suitable for
//   client-side HTML animation generation (CSS/SVG/GSAP).
//   Returns: { ok, comp, layers, warnings, message? }
//
// All code is ES3-compatible (no let/const/arrow/forEach).
// ============================================================================

function _ehtmlSafeGet (fn) {
  try { return fn(); } catch (e) { return null; }
}

function _ehtmlLayerType (layer) {
  if (layer instanceof TextLayer) return 'text';
  if (layer instanceof ShapeLayer) return 'shape';
  if (layer instanceof CameraLayer) return 'camera';
  if (layer instanceof LightLayer) return 'light';
  try { if (layer.nullLayer) return 'null'; } catch (eNl) {}
  try { if (layer.adjustmentLayer) return 'adjustment'; } catch (eAdj) {}
  try { if (layer.source instanceof CompItem) return 'precomp'; } catch (ePc) {}
  return 'av';
}

function _ehtmlColorToCss (arr) {
  if (!arr || !(arr instanceof Array) || arr.length < 3) return '#000000';
  function ch (x) {
    var n = Math.round((x || 0) * 255);
    if (n < 0) n = 0;
    if (n > 255) n = 255;
    var h = n.toString(16);
    if (h.length < 2) h = '0' + h;
    return h;
  }
  return '#' + ch(arr[0]) + ch(arr[1]) + ch(arr[2]);
}

function _ehtmlInterpTypeName (t) {
  if (typeof KeyframeInterpolationType === 'undefined') return 'bezier';
  if (t === KeyframeInterpolationType.LINEAR) return 'linear';
  if (t === KeyframeInterpolationType.HOLD) return 'hold';
  return 'bezier';
}

// Detect whether a property has an active (enabled, non-empty) expression.
// Expressions must be baked into keyframe samples for HTML export to reproduce motion.
function _ehtmlHasActiveExpression (prop) {
  try {
    if (!prop.canSetExpression) return false;
    if (!prop.expressionEnabled) return false;
    var expr = prop.expression;
    if (!expr || expr.length === 0) return false;
    return true;
  } catch (e) { return false; }
}

// Bake expression-driven property values into discrete keyframes by sampling
// valueAtTime(t, false) across the layer's active range. Resolution is the
// comp frame rate, capped so very long comps don't produce huge JSON.
function _ehtmlBakeExpression (prop, layer, comp) {
  var out = [];
  var fps = (comp && comp.frameRate) ? comp.frameRate : 25;
  if (fps > 60) fps = 60; // cap for sane output size; up to 60fps preserves expression fidelity on high-fps comps
  var step = 1.0 / fps;
  var inT = 0, outT = 1;
  try {
    if (layer && typeof layer.inPoint === 'number') inT = layer.inPoint;
    if (layer && typeof layer.outPoint === 'number') outT = layer.outPoint;
  } catch (eBT) {}
  if (comp) {
    if (inT < 0) inT = 0;
    if (outT > comp.duration) outT = comp.duration;
  }
  if (outT <= inT) {
    var vStatic = _ehtmlSafeGet(function () { return prop.valueAtTime(inT, false); });
    if (vStatic !== null) out.push({ t: inT, v: vStatic, iType: 'linear', oType: 'linear', ei: null, eo: null });
    return out;
  }
  var maxSamples = 600; // hard safety cap
  var t = inT;
  var count = 0;
  while (t <= outT && count < maxSamples) {
    var v = _ehtmlSafeGet(function () { return prop.valueAtTime(t, false); });
    if (v !== null) {
      out.push({ t: t, v: v, iType: 'linear', oType: 'linear', ei: null, eo: null });
    }
    t += step;
    count++;
  }
  // Ensure the final boundary is captured.
  if (out.length > 0 && out[out.length - 1].t < outT - 1e-6) {
    var vLast = _ehtmlSafeGet(function () { return prop.valueAtTime(outT, false); });
    if (vLast !== null) out.push({ t: outT, v: vLast, iType: 'linear', oType: 'linear', ei: null, eo: null });
  }
  return out;
}

function _ehtmlExtractKeyframes (prop, layer, comp, baked, captureSpatial) {
  var out = [];
  if (!prop) return out;
  // Expressions take priority — sample post-expression values across the layer span.
  if (_ehtmlHasActiveExpression(prop)) {
    var samples = _ehtmlBakeExpression(prop, layer, comp);
    if (baked && typeof baked === 'object') {
      baked.count = (baked.count || 0) + 1;
      baked.samples = (baked.samples || 0) + samples.length;
    }
    return samples;
  }
  var numKeys = 0;
  try { numKeys = prop.numKeys; } catch (eNk) { numKeys = 0; }
  if (numKeys > 0) {
    for (var i = 1; i <= numKeys; i++) {
      var kt = _ehtmlSafeGet(function () { return prop.keyTime(i); });
      var kv = _ehtmlSafeGet(function () { return prop.keyValue(i); });
      var iIn = _ehtmlSafeGet(function () { return prop.keyInInterpolationType(i); });
      var iOut = _ehtmlSafeGet(function () { return prop.keyOutInterpolationType(i); });
      var easeIn = _ehtmlSafeGet(function () { return prop.keyInTemporalEase(i); });
      var easeOut = _ehtmlSafeGet(function () { return prop.keyOutTemporalEase(i); });
      var eiInf = null, eoInf = null;
      if (easeIn && easeIn.length > 0) eiInf = easeIn[0].influence;
      if (easeOut && easeOut.length > 0) eoInf = easeOut[0].influence;
      var kfEntry = {
        t: kt,
        v: kv,
        iType: _ehtmlInterpTypeName(iIn),
        oType: _ehtmlInterpTypeName(iOut),
        ei: eiInf,
        eo: eoInf
      };
      // P3.2: Spatial tangents for position — `to` (out-tangent from this keyframe) and
      // `ti` (in-tangent into next keyframe from this one). Used for curved motion paths.
      // Only meaningful for spatial props (position), so we fetch only if captureSpatial=true.
      if (captureSpatial) {
        var spTo = _ehtmlSafeGet(function () { return prop.keyOutSpatialTangent(i); });
        var spTi = _ehtmlSafeGet(function () { return prop.keyInSpatialTangent(i); });
        if (spTo) kfEntry.to = [spTo[0] || 0, spTo[1] || 0, spTo[2] || 0];
        if (spTi) kfEntry.ti = [spTi[0] || 0, spTi[1] || 0, spTi[2] || 0];
      }
      out.push(kfEntry);
    }
  } else {
    var staticVal = _ehtmlSafeGet(function () { return prop.value; });
    if (staticVal !== null) {
      out.push({ t: 0, v: staticVal, iType: 'hold', oType: 'hold', ei: null, eo: null });
    }
  }
  return out;
}

// Merge two independent scalar keyframe arrays (X / Y) into vec2 keyframes by union time
// points. Used for AE's Separate Dimensions mode (Position X / Position Y as separate tracks
// with independent easing). Callers get a standard vec2 stream that flows through the same
// client-side interpolation path as regular position.
function _ehtmlMergeSeparateDims (xKeys, yKeys, staticX, staticY) {
  if ((!xKeys || xKeys.length === 0) && (!yKeys || yKeys.length === 0)) {
    // Fully static: one keyframe pair
    return [{ t: 0, v: [staticX || 0, staticY || 0, 0], iType: 'hold', oType: 'hold', ei: null, eo: null }];
  }
  var timeSet = {};
  if (xKeys) for (var i = 0; i < xKeys.length; i++) timeSet[xKeys[i].t] = true;
  if (yKeys) for (var j = 0; j < yKeys.length; j++) timeSet[yKeys[j].t] = true;
  var times = [];
  for (var k in timeSet) if (timeSet.hasOwnProperty(k)) times.push(Number(k));
  times.sort(function (a, b) { return a - b; });
  function sampleScalar (keys, t, fallback) {
    if (!keys || keys.length === 0) return fallback;
    if (t <= keys[0].t) return keys[0].v;
    if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].v;
    for (var m = 0; m < keys.length - 1; m++) {
      var a = keys[m], b = keys[m + 1];
      if (t >= a.t && t <= b.t) {
        if (a.oType === 'hold' || b.iType === 'hold' || b.t === a.t) return a.v;
        var u = (t - a.t) / (b.t - a.t);
        return a.v + (b.v - a.v) * u;
      }
    }
    return keys[keys.length - 1].v;
  }
  var merged = [];
  for (var t = 0; t < times.length; t++) {
    var ti = times[t];
    // Use the ei/eo from whichever axis has this keyframe (prefer X if both).
    var srcKey = null;
    if (xKeys) for (var xi = 0; xi < xKeys.length; xi++) if (Math.abs(xKeys[xi].t - ti) < 1e-6) { srcKey = xKeys[xi]; break; }
    if (!srcKey && yKeys) for (var yi = 0; yi < yKeys.length; yi++) if (Math.abs(yKeys[yi].t - ti) < 1e-6) { srcKey = yKeys[yi]; break; }
    merged.push({
      t: ti,
      v: [sampleScalar(xKeys, ti, staticX || 0), sampleScalar(yKeys, ti, staticY || 0), 0],
      iType: srcKey ? srcKey.iType : 'linear',
      oType: srcKey ? srcKey.oType : 'linear',
      ei: srcKey ? srcKey.ei : null,
      eo: srcKey ? srcKey.eo : null
    });
  }
  return merged;
}

function _ehtmlExtractTransform (layer, comp, baked) {
  var tProp = _ehtmlSafeGet(function () { return layer.property('ADBE Transform Group'); });
  if (!tProp) return { position: [], scale: [], rotation: [], opacity: [] };
  // Try compound Position first; fall back to Separate Dimensions (Position_0 / Position_1)
  // when AE's "Separate Dimensions" toggle is on (typical for bounce animations with different
  // X/Y easing).
  var pos = _ehtmlSafeGet(function () { return tProp.property('ADBE Position'); });
  var positionOut;
  var hasCompoundPosition = false;
  if (pos) {
    try { if (pos.numKeys > 0 || pos.value) hasCompoundPosition = true; } catch (ePs) {}
  }
  if (hasCompoundPosition && !(_ehtmlSafeGet(function () { return pos.dimensionsSeparated; }))) {
    positionOut = _ehtmlExtractKeyframes(pos, layer, comp, baked, true /* captureSpatial for curved motion */);
  } else {
    var posX = _ehtmlSafeGet(function () { return tProp.property('ADBE Position_0'); });
    var posY = _ehtmlSafeGet(function () { return tProp.property('ADBE Position_1'); });
    if (posX || posY) {
      var xKeys = _ehtmlExtractKeyframes(posX, layer, comp, baked);
      var yKeys = _ehtmlExtractKeyframes(posY, layer, comp, baked);
      // xKeys/yKeys from _ehtmlExtractKeyframes are vec-shaped ({v: number}); already scalar.
      // Separate Dimensions disables spatial tangents (AE behavior — tangents are a per-vec2 concept).
      var staticX = _ehtmlSafeGet(function () { return posX.value; });
      var staticY = _ehtmlSafeGet(function () { return posY.value; });
      positionOut = _ehtmlMergeSeparateDims(xKeys, yKeys, staticX, staticY);
    } else {
      positionOut = _ehtmlExtractKeyframes(pos, layer, comp, baked, true);
    }
  }
  var scale = _ehtmlSafeGet(function () { return tProp.property('ADBE Scale'); });
  var rot = _ehtmlSafeGet(function () {
    var r = tProp.property('ADBE Rotate Z');
    if (!r) r = tProp.property('ADBE Rotation');
    return r;
  });
  var opacity = _ehtmlSafeGet(function () { return tProp.property('ADBE Opacity'); });
  return {
    position: positionOut,
    scale: _ehtmlExtractKeyframes(scale, layer, comp, baked),
    rotation: _ehtmlExtractKeyframes(rot, layer, comp, baked),
    opacity: _ehtmlExtractKeyframes(opacity, layer, comp, baked)
  };
}

function _ehtmlExtractTextExtras (layer) {
  var txt = _ehtmlSafeGet(function () {
    return layer.property('ADBE Text Properties').property('ADBE Text Document').value;
  });
  if (!txt) return null;
  var fill = _ehtmlSafeGet(function () { return txt.fillColor; });
  var fontSz = _ehtmlSafeGet(function () { return txt.fontSize; });
  var justif = _ehtmlSafeGet(function () { return txt.justification; });
  var justifStr = 'left';
  if (typeof ParagraphJustification !== 'undefined') {
    if (justif === ParagraphJustification.CENTER_JUSTIFY) justifStr = 'center';
    else if (justif === ParagraphJustification.RIGHT_JUSTIFY) justifStr = 'right';
  }
  // Stroke properties (availability varies by AE version — guard each).
  var applyFill = _ehtmlSafeGet(function () { return txt.applyFill; });
  var applyStroke = _ehtmlSafeGet(function () { return txt.applyStroke; });
  var strokeColor = _ehtmlSafeGet(function () { return txt.strokeColor; });
  var strokeWidth = _ehtmlSafeGet(function () { return txt.strokeWidth; });
  var strokeOverFill = _ehtmlSafeGet(function () { return txt.strokeOverFill; });
  var fauxBold = _ehtmlSafeGet(function () { return txt.fauxBold; });
  var fauxItalic = _ehtmlSafeGet(function () { return txt.fauxItalic; });
  var tracking = _ehtmlSafeGet(function () { return txt.tracking; });
  var leading = _ehtmlSafeGet(function () { return txt.leading; });
  // AE's reported bbox for the text layer at t=0. This tells us where AE considers
  // the text's visible box to be in layer-space — crucial for aligning SVG <text>
  // with user-drawn masks (which are in layer-space around AE's bbox, not around
  // browser-computed font metrics which may include higher ascenders).
  var srcRect = _ehtmlSafeGet(function () { return layer.sourceRectAtTime(0, false); });
  var bbox = null;
  if (srcRect) {
    bbox = {
      top: _ehtmlSafeGet(function () { return srcRect.top; }) || 0,
      left: _ehtmlSafeGet(function () { return srcRect.left; }) || 0,
      width: _ehtmlSafeGet(function () { return srcRect.width; }) || 0,
      height: _ehtmlSafeGet(function () { return srcRect.height; }) || 0
    };
  }
  // P4.6: Text animators (minimal) — detect presence of animators and extract the
  // first animator's Opacity / Position / Scale / Rotation property keyframes plus the
  // range selector's Start/End/Offset tracks. Client uses these to stamp per-character
  // <tspan> elements with a staggered animation. Full animator math (shape/smoothness
  // Range Selector Advanced, multiple animators, Fill Color) is roadmap.
  var animators = _ehtmlSafeGet(function () {
    return layer.property('ADBE Text Properties').property('ADBE Text Animators');
  });
  var textAnimator = null;
  if (animators) {
    var animNum = _ehtmlSafeGet(function () { return animators.numProperties; }) || 0;
    if (animNum > 0) {
      // Take the first animator only.
      var anim = _ehtmlSafeGet(function () { return animators.property(1); });
      if (anim) {
        var animProps = _ehtmlSafeGet(function () { return anim.property('ADBE Text Animator Properties'); });
        var animRange = _ehtmlSafeGet(function () { return anim.property('ADBE Text Selectors'); });
        function animKeys (propMN) {
          var p = _ehtmlSafeGet(function () { return animProps.property(propMN); });
          if (!p) return null;
          return _ehtmlExtractKeyframes(p, layer, null, null);
        }
        function selKeys (sel, propMN) {
          if (!sel) return null;
          var p = _ehtmlSafeGet(function () { return sel.property(propMN); });
          if (!p) return null;
          return _ehtmlExtractKeyframes(p, layer, null, null);
        }
        var sel1 = null;
        if (animRange) {
          var selNum = _ehtmlSafeGet(function () { return animRange.numProperties; }) || 0;
          if (selNum > 0) sel1 = _ehtmlSafeGet(function () { return animRange.property(1); });
        }
        textAnimator = {
          opacity: animKeys('ADBE Text Opacity'),
          position: animKeys('ADBE Text Position 3D'),
          scale: animKeys('ADBE Text Scale 3D'),
          rotation: animKeys('ADBE Text Rotation'),
          rangeStart: selKeys(sel1, 'ADBE Text Percent Start'),
          rangeEnd: selKeys(sel1, 'ADBE Text Percent End'),
          rangeOffset: selKeys(sel1, 'ADBE Text Percent Offset')
        };
      }
    }
  }

  // P4.4: Text on Path — AE's text layer can bind to a mask path via the Path Options group.
  // `ADBE Text Path` returns the 1-based index of the mask to follow (0 = none).
  var pathIndex = _ehtmlSafeGet(function () {
    return layer.property('ADBE Text Properties')
      .property('ADBE Text Path Options').property('ADBE Text Path').value;
  });
  var pathAttrs = null;
  if (typeof pathIndex === 'number' && pathIndex > 0) {
    var pReverse = _ehtmlSafeGet(function () {
      return layer.property('ADBE Text Properties')
        .property('ADBE Text Path Options').property('ADBE Text Reverse Path').value;
    });
    var pForceAlign = _ehtmlSafeGet(function () {
      return layer.property('ADBE Text Properties')
        .property('ADBE Text Path Options').property('ADBE Text Force Alignment').value;
    });
    var pFirstMargin = _ehtmlSafeGet(function () {
      return layer.property('ADBE Text Properties')
        .property('ADBE Text Path Options').property('ADBE Text First Margin').value;
    });
    pathAttrs = {
      maskIndex: pathIndex - 1, // zero-based for client-side mask array lookup
      reverse: pReverse === true || pReverse === 1,
      forceAlignment: pForceAlign === true || pForceAlign === 1,
      firstMargin: (typeof pFirstMargin === 'number') ? pFirstMargin : 0
    };
  }
  return {
    text: _ehtmlSafeGet(function () { return txt.text; }) || '',
    font: _ehtmlSafeGet(function () { return txt.font; }) || '',
    fontFamily: _ehtmlSafeGet(function () { return txt.fontFamily; }) || '',
    fontSize: fontSz,
    fillColor: _ehtmlColorToCss(fill),
    justification: justifStr,
    bbox: bbox,
    applyFill: applyFill !== false,
    applyStroke: applyStroke === true,
    strokeColor: strokeColor ? _ehtmlColorToCss(strokeColor) : null,
    strokeWidth: (typeof strokeWidth === 'number') ? strokeWidth : 0,
    strokeOverFill: strokeOverFill !== false,
    fauxBold: fauxBold === true,
    fauxItalic: fauxItalic === true,
    tracking: (typeof tracking === 'number') ? tracking : 0,
    leading: (typeof leading === 'number') ? leading : 0,
    pathOption: pathAttrs,
    animator: textAnimator
  };
}

// Extract mask(s) from a layer's ADBE Mask Parade. Each mask captures its shape
// (possibly animated), mode, opacity and expansion. Enables reveal-style animations
// where the mask shape is keyframed over time.
// Returns [{ name, mode, opacity, expansion, feather, shapeKeys: [{t, d, iType, oType, ei, eo}] }] | null
function _ehtmlExtractMasks (layer) {
  var parade = _ehtmlSafeGet(function () { return layer.property('ADBE Mask Parade'); });
  if (!parade) return null;
  var n = _ehtmlSafeGet(function () { return parade.numProperties; }) || 0;
  if (n === 0) return null;
  var out = [];
  for (var i = 1; i <= n; i++) {
    var mask = _ehtmlSafeGet(function () { return parade.property(i); });
    if (!mask) continue;
    var maskName = _ehtmlSafeGet(function () { return mask.name; }) || ('Mask ' + i);
    var inverted = _ehtmlSafeGet(function () { return mask.inverted; }) === true;
    var modeVal = _ehtmlSafeGet(function () { return mask.maskMode; });
    var modeStr = 'add';
    if (typeof MaskMode !== 'undefined' && modeVal != null) {
      if (modeVal === MaskMode.NONE) modeStr = 'none';
      else if (modeVal === MaskMode.SUBTRACT) modeStr = 'subtract';
      else if (modeVal === MaskMode.INTERSECT) modeStr = 'intersect';
      else if (modeVal === MaskMode.LIGHTEN) modeStr = 'lighten';
      else if (modeVal === MaskMode.DARKEN) modeStr = 'darken';
      else if (modeVal === MaskMode.DIFFERENCE) modeStr = 'difference';
      else modeStr = 'add';
    }
    var shapeProp = _ehtmlSafeGet(function () { return mask.property('ADBE Mask Shape'); });
    if (!shapeProp) continue;
    var opacityProp = _ehtmlSafeGet(function () { return mask.property('ADBE Mask Opacity'); });
    var feathProp = _ehtmlSafeGet(function () { return mask.property('ADBE Mask Feather'); });
    // NB: AE internal match name for Mask Expansion is "ADBE Mask Offset" (not "ADBE Mask Expansion").
    var expandProp = _ehtmlSafeGet(function () { return mask.property('ADBE Mask Offset'); });
    var opacityVal = _ehtmlSafeGet(function () { return opacityProp ? opacityProp.value : 100; });
    var feathVal = _ehtmlSafeGet(function () { return feathProp ? feathProp.value : [0, 0]; });
    var expandVal = _ehtmlSafeGet(function () { return expandProp ? expandProp.value : 0; });
    // Build "d" (SVG path) samples for each shape keyframe (or static if no anim).
    function shapeToD (sh) {
      if (!sh) return '';
      var verts = _ehtmlSafeGet(function () { return sh.vertices; }) || [];
      var inT = _ehtmlSafeGet(function () { return sh.inTangents; }) || [];
      var outT = _ehtmlSafeGet(function () { return sh.outTangents; }) || [];
      var closed = _ehtmlSafeGet(function () { return sh.closed; }) || false;
      if (verts.length === 0) return '';
      var d = 'M ' + verts[0][0] + ' ' + verts[0][1];
      for (var vi = 1; vi < verts.length; vi++) {
        var prev = verts[vi - 1];
        var curr = verts[vi];
        var ot = outT[vi - 1] || [0, 0];
        var it = inT[vi] || [0, 0];
        // Cubic bezier: C (prev + outT[prev]), (curr + inT[curr]), curr
        d += ' C ' + (prev[0] + ot[0]) + ' ' + (prev[1] + ot[1]) +
             ', ' + (curr[0] + it[0]) + ' ' + (curr[1] + it[1]) +
             ', ' + curr[0] + ' ' + curr[1];
      }
      if (closed && verts.length > 1) {
        // Close via final cubic back to first vertex
        var last = verts[verts.length - 1];
        var first = verts[0];
        var otL = outT[verts.length - 1] || [0, 0];
        var itF = inT[0] || [0, 0];
        d += ' C ' + (last[0] + otL[0]) + ' ' + (last[1] + otL[1]) +
             ', ' + (first[0] + itF[0]) + ' ' + (first[1] + itF[1]) +
             ', ' + first[0] + ' ' + first[1];
        d += ' Z';
      }
      return d;
    }
    var shapeKeys = [];
    var numShapeKeys = _ehtmlSafeGet(function () { return shapeProp.numKeys; }) || 0;
    if (numShapeKeys > 0) {
      for (var sk = 1; sk <= numShapeKeys; sk++) {
        var kt = _ehtmlSafeGet(function () { return shapeProp.keyTime(sk); });
        var kv = _ehtmlSafeGet(function () { return shapeProp.keyValue(sk); });
        var iType = _ehtmlSafeGet(function () { return shapeProp.keyInInterpolationType(sk); });
        var oType = _ehtmlSafeGet(function () { return shapeProp.keyOutInterpolationType(sk); });
        var inEase = _ehtmlSafeGet(function () { return shapeProp.keyInTemporalEase(sk); });
        var outEase = _ehtmlSafeGet(function () { return shapeProp.keyOutTemporalEase(sk); });
        var ei = (inEase && inEase.length > 0) ? inEase[0].influence : null;
        var eo = (outEase && outEase.length > 0) ? outEase[0].influence : null;
        shapeKeys.push({
          t: kt,
          d: shapeToD(kv),
          iType: _ehtmlInterpTypeName(iType),
          oType: _ehtmlInterpTypeName(oType),
          ei: ei,
          eo: eo
        });
      }
    } else {
      var staticShape = _ehtmlSafeGet(function () { return shapeProp.value; });
      if (staticShape) {
        shapeKeys.push({ t: 0, d: shapeToD(staticShape), iType: 'hold', oType: 'hold', ei: null, eo: null });
      }
    }
    if (shapeKeys.length === 0 || !shapeKeys[0].d) continue;
    // Extract Mask Opacity keyframes for animated reveal (fade in/out of the mask itself)
    var opacityKeys = [];
    if (opacityProp) {
      var opKfs = _ehtmlScalarKeys(_ehtmlExtractKeyframes(opacityProp, layer, null, null));
      if (opKfs.length > 1) opacityKeys = opKfs;
    }
    // Mask Offset (UI label: "Mask Expansion") — grows/shrinks the mask shape outward.
    // Extracted as keyframes; if animated, client will apply approximation (scale the path)
    // and emit a diagnostic warning since true path-offset is geometrically complex.
    var expansionKeys = [];
    if (expandProp) {
      var exKfs = _ehtmlScalarKeys(_ehtmlExtractKeyframes(expandProp, layer, null, null));
      if (exKfs.length > 1) expansionKeys = exKfs;
    }
    out.push({
      name: maskName,
      mode: modeStr,
      inverted: inverted,
      opacity: (typeof opacityVal === 'number') ? opacityVal : 100,
      opacityKeys: opacityKeys,
      expansion: (typeof expandVal === 'number') ? expandVal : 0,
      expansionKeys: expansionKeys,
      feather: (feathVal instanceof Array) ? [feathVal[0] || 0, feathVal[1] || 0] : [0, 0],
      shapeKeys: shapeKeys
    });
  }
  return out.length ? out : null;
}

// Convert raw keyframes containing RGBA-in-0..1 arrays to CSS-hex color keys.
function _ehtmlColorKeys (kfs) {
  var out = [];
  for (var k = 0; k < (kfs || []).length; k++) {
    var c = kfs[k].v;
    if (c && c instanceof Array && c.length >= 3) {
      out.push({
        t: kfs[k].t,
        v: _ehtmlColorToCss([c[0], c[1], c[2]]),
        iType: kfs[k].iType,
        oType: kfs[k].oType,
        ei: kfs[k].ei,
        eo: kfs[k].eo
      });
    }
  }
  return out;
}

// Convert raw keyframes containing scalar numbers to {t, v, ...} CSS-ready stops.
function _ehtmlScalarKeys (kfs) {
  var out = [];
  for (var k = 0; k < (kfs || []).length; k++) {
    var v = kfs[k].v;
    if (typeof v === 'number' && isFinite(v)) {
      out.push({ t: kfs[k].t, v: v, iType: kfs[k].iType, oType: kfs[k].oType, ei: kfs[k].ei, eo: kfs[k].eo });
    }
  }
  return out;
}

// Extract recognized layer effects that have a CSS/SVG equivalent. Supports
// multiple effects on the same layer, and keyframed values so animated
// filter/fill changes reproduce in the exported HTML.
//
// Returns object shaped like:
//   { fill: { color: [...] },
//     dropShadow: { color, opacity, direction, distance, softness },  // each is keyframes array
//     blur: { radius: [...] } }
// or null when no recognized effects are present.
function _ehtmlExtractEffects (layer) {
  var parade = _ehtmlSafeGet(function () { return layer.property('ADBE Effect Parade'); });
  if (!parade) return null;
  var n = _ehtmlSafeGet(function () { return parade.numProperties; }) || 0;
  if (n === 0) return null;
  var out = null;
  function ensure () { if (!out) out = {}; return out; }
  function pickProp (eff, names) {
    for (var pi = 0; pi < names.length; pi++) {
      var p = _ehtmlSafeGet(function () { return eff.property(names[pi]); });
      if (p) return p;
    }
    return null;
  }

  for (var i = 1; i <= n; i++) {
    var eff = _ehtmlSafeGet(function () { return parade.property(i); });
    if (!eff) continue;
    var enabledEff = _ehtmlSafeGet(function () { return eff.enabled; });
    if (enabledEff === false) continue;
    var mn = _ehtmlSafeGet(function () { return eff.matchName; }) || '';

    // ── ADBE Fill ──────────────────────────────────────────────────
    if (mn === 'ADBE Fill') {
      // Properties: 1=All Masks, 2=Color, 3=Invert, 4=HFeather, 5=VFeather, 6=Opacity
      var fillColor = pickProp(eff, ['Color', 'ADBE Fill-0002']);
      if (!fillColor) fillColor = _ehtmlSafeGet(function () { return eff.property(2); });
      if (fillColor) {
        var cKeys = _ehtmlColorKeys(_ehtmlExtractKeyframes(fillColor, layer, null, null));
        if (cKeys.length > 0 && !(out && out.fill)) {
          ensure().fill = { color: cKeys };
        }
      }
      continue;
    }

    // ── ADBE Drop Shadow ───────────────────────────────────────────
    if (mn === 'ADBE Drop Shadow') {
      // Properties by name: Shadow Color, Opacity, Direction, Distance, Softness, Shadow Only
      var sCol = pickProp(eff, ['Shadow Color', 'ADBE Drop Shadow-0002']);
      var sOp = pickProp(eff, ['Opacity', 'ADBE Drop Shadow-0003']);
      var sDir = pickProp(eff, ['Direction', 'ADBE Drop Shadow-0004']);
      var sDist = pickProp(eff, ['Distance', 'ADBE Drop Shadow-0005']);
      var sSoft = pickProp(eff, ['Softness', 'ADBE Drop Shadow-0006']);
      var colKeys = sCol ? _ehtmlColorKeys(_ehtmlExtractKeyframes(sCol, layer, null, null)) : [];
      var opKeys = sOp ? _ehtmlScalarKeys(_ehtmlExtractKeyframes(sOp, layer, null, null)) : [];
      var dirKeys = sDir ? _ehtmlScalarKeys(_ehtmlExtractKeyframes(sDir, layer, null, null)) : [];
      var distKeys = sDist ? _ehtmlScalarKeys(_ehtmlExtractKeyframes(sDist, layer, null, null)) : [];
      var softKeys = sSoft ? _ehtmlScalarKeys(_ehtmlExtractKeyframes(sSoft, layer, null, null)) : [];
      if (colKeys.length || distKeys.length || softKeys.length) {
        ensure().dropShadow = {
          color: colKeys.length ? colKeys : [{ t: 0, v: '#000000' }],
          opacity: opKeys.length ? opKeys : [{ t: 0, v: 100 }],
          direction: dirKeys.length ? dirKeys : [{ t: 0, v: 135 }],
          distance: distKeys.length ? distKeys : [{ t: 0, v: 5 }],
          softness: softKeys.length ? softKeys : [{ t: 0, v: 5 }]
        };
      }
      continue;
    }

    // ── ADBE Gaussian Blur (original + "2" variant) ───────────────
    if (mn === 'ADBE Gaussian Blur 2' || mn === 'ADBE Gaussian Blur') {
      var blurR = pickProp(eff, ['Blurriness', 'ADBE Gaussian Blur 2-0001', 'ADBE Gaussian Blur-0001']);
      if (!blurR) blurR = _ehtmlSafeGet(function () { return eff.property(1); });
      if (blurR) {
        var rKeys = _ehtmlScalarKeys(_ehtmlExtractKeyframes(blurR, layer, null, null));
        if (rKeys.length > 0 && !(out && out.blur)) {
          ensure().blur = { radius: rKeys };
        }
      }
      continue;
    }

    // ── ADBE Invert (Channel → Invert) ──────────────────────────────
    if (mn === 'ADBE Invert') {
      ensure().invert = true;
      continue;
    }

    // ── ADBE Brightness & Contrast (2) ─────────────────────────────
    if (mn === 'ADBE Brightness & Contrast 2' || mn === 'ADBE Brightness & Contrast') {
      var brProp = pickProp(eff, ['Brightness', 'ADBE Brightness & Contrast 2-0001']);
      var coProp = pickProp(eff, ['Contrast', 'ADBE Brightness & Contrast 2-0002']);
      if (!brProp) brProp = _ehtmlSafeGet(function () { return eff.property(1); });
      if (!coProp) coProp = _ehtmlSafeGet(function () { return eff.property(2); });
      var brKeys = brProp ? _ehtmlScalarKeys(_ehtmlExtractKeyframes(brProp, layer, null, null)) : [];
      var coKeys = coProp ? _ehtmlScalarKeys(_ehtmlExtractKeyframes(coProp, layer, null, null)) : [];
      if (brKeys.length || coKeys.length) {
        ensure().brightnessContrast = {
          brightness: brKeys.length ? brKeys : [{ t: 0, v: 0 }],
          contrast: coKeys.length ? coKeys : [{ t: 0, v: 0 }]
        };
      }
      continue;
    }

    // ── ADBE HUE SATURATION ────────────────────────────────────────
    if (mn === 'ADBE HUE SATURATION' || mn === 'ADBE Hue/Saturation') {
      var hueProp = pickProp(eff, ['Master Hue', 'ADBE HUE SATURATION-0001']);
      var satProp = pickProp(eff, ['Master Saturation', 'ADBE HUE SATURATION-0002']);
      var ltProp = pickProp(eff, ['Master Lightness', 'ADBE HUE SATURATION-0003']);
      // Fallback by index if named lookup failed — first 3 scalar props after "Channel Control"
      var hKeys = hueProp ? _ehtmlScalarKeys(_ehtmlExtractKeyframes(hueProp, layer, null, null)) : [];
      var sKeys = satProp ? _ehtmlScalarKeys(_ehtmlExtractKeyframes(satProp, layer, null, null)) : [];
      var lKeys = ltProp ? _ehtmlScalarKeys(_ehtmlExtractKeyframes(ltProp, layer, null, null)) : [];
      if (hKeys.length || sKeys.length || lKeys.length) {
        ensure().hueSaturation = {
          hue: hKeys.length ? hKeys : [{ t: 0, v: 0 }],
          saturation: sKeys.length ? sKeys : [{ t: 0, v: 0 }],
          lightness: lKeys.length ? lKeys : [{ t: 0, v: 0 }]
        };
      }
      continue;
    }

    // ── ADBE Tint ──────────────────────────────────────────────────
    if (mn === 'ADBE Tint') {
      var bkProp = pickProp(eff, ['Map Black To', 'ADBE Tint-0001']);
      var whProp = pickProp(eff, ['Map White To', 'ADBE Tint-0002']);
      var amProp = pickProp(eff, ['Amount to Tint', 'ADBE Tint-0003']);
      var bkKeys = bkProp ? _ehtmlColorKeys(_ehtmlExtractKeyframes(bkProp, layer, null, null)) : [];
      var whKeys = whProp ? _ehtmlColorKeys(_ehtmlExtractKeyframes(whProp, layer, null, null)) : [];
      var amKeys = amProp ? _ehtmlScalarKeys(_ehtmlExtractKeyframes(amProp, layer, null, null)) : [];
      if (bkKeys.length || whKeys.length) {
        ensure().tint = {
          black: bkKeys.length ? bkKeys : [{ t: 0, v: '#000000' }],
          white: whKeys.length ? whKeys : [{ t: 0, v: '#ffffff' }],
          amount: amKeys.length ? amKeys : [{ t: 0, v: 100 }]
        };
      }
      continue;
    }
  }
  return out;
}

// Map AE BlendingMode enum value to a CSS mix-blend-mode keyword (or null if
// the mode has no direct CSS equivalent — caller can emit a warning).
function _ehtmlBlendModeName (val) {
  if (typeof BlendingMode === 'undefined' || val == null) return 'normal';
  if (val === BlendingMode.NORMAL) return 'normal';
  if (val === BlendingMode.MULTIPLY) return 'multiply';
  if (val === BlendingMode.SCREEN) return 'screen';
  if (val === BlendingMode.OVERLAY) return 'overlay';
  if (val === BlendingMode.DARKEN) return 'darken';
  if (val === BlendingMode.LIGHTEN) return 'lighten';
  if (val === BlendingMode.COLOR_DODGE) return 'color-dodge';
  if (val === BlendingMode.COLOR_BURN) return 'color-burn';
  if (val === BlendingMode.HARD_LIGHT) return 'hard-light';
  if (val === BlendingMode.SOFT_LIGHT) return 'soft-light';
  if (val === BlendingMode.DIFFERENCE) return 'difference';
  if (val === BlendingMode.EXCLUSION) return 'exclusion';
  if (val === BlendingMode.HUE) return 'hue';
  if (val === BlendingMode.SATURATION) return 'saturation';
  if (val === BlendingMode.COLOR) return 'color';
  if (val === BlendingMode.LUMINOSITY) return 'luminosity';
  // No direct CSS equivalent (Add, Linear Dodge, Dissolve, Stencil/Silhouette Alpha, etc.)
  // Fallback: approximate by nearest neighbour.
  if (val === BlendingMode.ADD || val === BlendingMode.LINEAR_DODGE) return 'screen';
  if (val === BlendingMode.LINEAR_BURN) return 'color-burn';
  return 'normal';
}

// Extract anchor point for a layer (single static value — anchor rarely animates).
// Returns [x, y] or null if unavailable.
function _ehtmlExtractAnchorPoint (layer) {
  var tProp = _ehtmlSafeGet(function () { return layer.property('ADBE Transform Group'); });
  if (!tProp) return null;
  var ap = _ehtmlSafeGet(function () { return tProp.property('ADBE Anchor Point'); });
  if (!ap) return null;
  var v = _ehtmlSafeGet(function () { return ap.value; });
  if (!v || !(v instanceof Array) || v.length < 2) return null;
  return [v[0], v[1]];
}

// For AV footage layers (images, video) — capture the source file path + dimensions
// so the client-side exporter can emit <image> with the real asset.
function _ehtmlExtractMediaExtras (layer) {
  var src = _ehtmlSafeGet(function () { return layer.source; });
  if (!src) return null;
  var isFootage = false;
  try { isFootage = (src instanceof FootageItem); } catch (eFi) { isFootage = false; }
  if (!isFootage) return null;
  var mainSrc = _ehtmlSafeGet(function () { return src.mainSource; });
  var file = _ehtmlSafeGet(function () { return mainSrc && mainSrc.file ? mainSrc.file : null; });
  var w = _ehtmlSafeGet(function () { return src.width; }) || 0;
  var h = _ehtmlSafeGet(function () { return src.height; }) || 0;
  // Solid source: no file, but has color
  var isSolid = false;
  try { isSolid = (mainSrc instanceof SolidSource); } catch (eSs) { isSolid = false; }
  if (isSolid) {
    var col = _ehtmlSafeGet(function () { return mainSrc.color; });
    return {
      isSolid: true,
      color: _ehtmlColorToCss(col),
      width: w,
      height: h
    };
  }
  var filePath = null;
  if (file) {
    filePath = _ehtmlSafeGet(function () { return file.fsName; });
  }
  if (!filePath) return null;
  var fileName = _ehtmlSafeGet(function () { return file.name; }) || 'media';
  var ext = '';
  var dotIdx = fileName.lastIndexOf('.');
  if (dotIdx >= 0) ext = fileName.substring(dotIdx + 1).toLowerCase();
  var isVideo = (ext === 'mp4' || ext === 'mov' || ext === 'webm' || ext === 'mkv' || ext === 'm4v' || ext === 'avi');
  return {
    path: filePath,
    fileName: fileName,
    width: w,
    height: h,
    ext: ext,
    isVideo: isVideo
  };
}

// Extract a gradient-fill / gradient-stroke item (ADBE Vector Graphic - G-Fill / G-Stroke).
// Returns { kind: 'linear'|'radial', start: [x,y], end: [x,y], stops: [{offset, color, alpha}], opacity, highlight }
// Gradient color stops are read from the effect's "Colors" property; AE packs them as a
// flattened array with the first N entries = [offset, r, g, b] per color stop and the trailing
// entries = [offset, alpha] per alpha stop. Here we decode both.
function _ehtmlExtractGradient (eff) {
  var typeIdx = _ehtmlSafeGet(function () { return eff.property('ADBE Vector Grad Type').value; });
  var kind = typeIdx === 2 ? 'radial' : 'linear';
  var start = _ehtmlSafeGet(function () { return eff.property('ADBE Vector Grad Start Pt').value; }) || [0, 0];
  var end = _ehtmlSafeGet(function () { return eff.property('ADBE Vector Grad End Pt').value; }) || [0, 0];
  var highlightLen = _ehtmlSafeGet(function () { return eff.property('ADBE Vector Grad HiLite Length').value; }) || 0;
  var highlightAng = _ehtmlSafeGet(function () { return eff.property('ADBE Vector Grad HiLite Angle').value; }) || 0;
  var opacity = _ehtmlSafeGet(function () { return eff.property('ADBE Vector Fill Opacity').value; });
  if (opacity == null) opacity = _ehtmlSafeGet(function () { return eff.property('ADBE Vector Stroke Opacity').value; });
  // Colors is a "no value" Property whose .value on Gradient Colors returns a flat array;
  // we use .valueAtTime(0, false) since `.value` may not work on this property type.
  var colorsProp = _ehtmlSafeGet(function () { return eff.property('ADBE Vector Colors'); });
  var stops = [];
  if (colorsProp) {
    // AE's GradientColorData object: has colorStops (and alphaStops) arrays.
    var raw = _ehtmlSafeGet(function () { return colorsProp.valueAtTime(0, false); });
    if (raw) {
      // Colors: array of [offset, r, g, b, ...] entries followed by alpha stops [offset, alpha, ...]
      // Structure: colorStopsCount encoded as first element, then 4*N color-stop floats,
      // then alphaStopsCount, then 2*M alpha-stop floats. But shape varies across AE versions —
      // we treat `raw` as a GradientColorData object if available, else a flat Array.
      if (typeof raw === 'object' && raw.colorStops && raw.colorStops.stops) {
        var cs = raw.colorStops.stops;
        for (var i = 0; i < cs.length; i++) {
          stops.push({
            offset: cs[i][0],
            color: _ehtmlColorToCss([cs[i][1], cs[i][2], cs[i][3]]),
            alpha: (raw.alphaStops && raw.alphaStops.stops && raw.alphaStops.stops[i]) ? raw.alphaStops.stops[i][1] : 1
          });
        }
      } else if (raw instanceof Array) {
        // Legacy flat-array layout: parse as pairs of [offset, r, g, b, ...]
        for (var k = 0; k + 3 < raw.length; k += 4) {
          stops.push({
            offset: raw[k] || 0,
            color: _ehtmlColorToCss([raw[k + 1] || 0, raw[k + 2] || 0, raw[k + 3] || 0]),
            alpha: 1
          });
        }
      }
    }
  }
  if (stops.length === 0) {
    // Fallback: two black→white stops so output is valid even on extraction failure.
    stops = [{ offset: 0, color: '#000000', alpha: 1 }, { offset: 1, color: '#ffffff', alpha: 1 }];
  }
  return {
    kind: kind,
    start: [start[0], start[1]],
    end: [end[0], end[1]],
    stops: stops,
    opacity: (typeof opacity === 'number') ? (opacity / 100) : 1,
    highlightLen: highlightLen,
    highlightAng: highlightAng
  };
}

// Extract one Fill item (ADBE Vector Graphic - Fill) → structured object
// including fill rule + static color/opacity (gradients handled separately in P2.1).
function _ehtmlExtractFill (eff) {
  var fc = _ehtmlSafeGet(function () { return eff.property('ADBE Vector Fill Color').value; });
  var fop = _ehtmlSafeGet(function () { return eff.property('ADBE Vector Fill Opacity').value; });
  var ruleIdx = _ehtmlSafeGet(function () { return eff.property('ADBE Vector Fill Rule').value; });
  var ruleMap = { 1: 'nonzero', 2: 'evenodd' };
  return {
    color: fc ? _ehtmlColorToCss(fc) : null,
    opacity: (typeof fop === 'number') ? (fop / 100) : 1,
    rule: ruleMap[ruleIdx] || 'nonzero'
  };
}

// Extract one Stroke item → structured object with dashes + line cap/join/miter.
function _ehtmlExtractStroke (eff) {
  var sc = _ehtmlSafeGet(function () { return eff.property('ADBE Vector Stroke Color').value; });
  var sw = _ehtmlSafeGet(function () { return eff.property('ADBE Vector Stroke Width').value; });
  var sop = _ehtmlSafeGet(function () { return eff.property('ADBE Vector Stroke Opacity').value; });
  var capIdx = _ehtmlSafeGet(function () { return eff.property('ADBE Vector Stroke Line Cap').value; });
  var joinIdx = _ehtmlSafeGet(function () { return eff.property('ADBE Vector Stroke Line Join').value; });
  var miter = _ehtmlSafeGet(function () { return eff.property('ADBE Vector Stroke Miter Limit').value; });
  var capMap = { 1: 'butt', 2: 'round', 3: 'square' };
  var joinMap = { 1: 'miter', 2: 'round', 3: 'bevel' };
  // Dashes: ADBE Vector Stroke Dashes group with alternating ADBE Vector Stroke Dash 1..N + ADBE Vector Stroke Gap 1..N + ADBE Vector Stroke Offset
  var dashArray = [];
  var dashOffset = 0;
  var dashGroup = _ehtmlSafeGet(function () { return eff.property('ADBE Vector Stroke Dashes'); });
  if (dashGroup) {
    var dn = _ehtmlSafeGet(function () { return dashGroup.numProperties; }) || 0;
    for (var di = 1; di <= dn; di++) {
      var dItem = _ehtmlSafeGet(function () { return dashGroup.property(di); });
      if (!dItem) continue;
      var dMn = _ehtmlSafeGet(function () { return dItem.matchName; }) || '';
      if (dMn.indexOf('ADBE Vector Stroke Dash') === 0 || dMn.indexOf('ADBE Vector Stroke Gap') === 0) {
        var v = _ehtmlSafeGet(function () { return dItem.value; });
        if (typeof v === 'number' && v > 0) dashArray.push(v);
      } else if (dMn === 'ADBE Vector Stroke Offset') {
        var ov = _ehtmlSafeGet(function () { return dItem.value; });
        if (typeof ov === 'number') dashOffset = ov;
      }
    }
  }
  return {
    color: sc ? _ehtmlColorToCss(sc) : null,
    width: (typeof sw === 'number') ? sw : 0,
    opacity: (typeof sop === 'number') ? (sop / 100) : 1,
    lineCap: capMap[capIdx] || 'butt',
    lineJoin: joinMap[joinIdx] || 'miter',
    miterLimit: (typeof miter === 'number') ? miter : 4,
    dashArray: dashArray,
    dashOffset: dashOffset
  };
}

// Extract one shape primitive (Rect / Ellipse / Path / Polystar) → structured object.
function _ehtmlExtractShapePrimitive (child, mn) {
  if (mn === 'ADBE Vector Shape - Rect') {
    return {
      primitive: 'rect',
      size: _ehtmlSafeGet(function () { return child.property('ADBE Vector Rect Size').value; }),
      position: _ehtmlSafeGet(function () { return child.property('ADBE Vector Rect Position').value; }),
      roundness: _ehtmlSafeGet(function () { return child.property('ADBE Vector Rect Roundness').value; }) || 0
    };
  }
  if (mn === 'ADBE Vector Shape - Ellipse') {
    return {
      primitive: 'ellipse',
      size: _ehtmlSafeGet(function () { return child.property('ADBE Vector Ellipse Size').value; }),
      position: _ehtmlSafeGet(function () { return child.property('ADBE Vector Ellipse Position').value; })
    };
  }
  if (mn === 'ADBE Vector Shape - Group') {
    var shapeVal = _ehtmlSafeGet(function () { return child.property('ADBE Vector Shape').value; });
    if (!shapeVal) return null;
    return {
      primitive: 'path',
      path: {
        vertices: _ehtmlSafeGet(function () { return shapeVal.vertices; }) || [],
        inTangents: _ehtmlSafeGet(function () { return shapeVal.inTangents; }) || [],
        outTangents: _ehtmlSafeGet(function () { return shapeVal.outTangents; }) || [],
        closed: _ehtmlSafeGet(function () { return shapeVal.closed; }) || false
      }
    };
  }
  if (mn === 'ADBE Vector Shape - Star') {
    // Polystar (star / polygon). Type 1 = star, 2 = polygon.
    var typeIdx = _ehtmlSafeGet(function () { return child.property('ADBE Vector Star Type').value; });
    return {
      primitive: 'polystar',
      polystarType: typeIdx === 2 ? 'polygon' : 'star',
      points: _ehtmlSafeGet(function () { return child.property('ADBE Vector Star Points').value; }) || 5,
      position: _ehtmlSafeGet(function () { return child.property('ADBE Vector Star Position').value; }) || [0, 0],
      rotation: _ehtmlSafeGet(function () { return child.property('ADBE Vector Star Rotation').value; }) || 0,
      innerRadius: _ehtmlSafeGet(function () { return child.property('ADBE Vector Star Inner Radius').value; }) || 0,
      outerRadius: _ehtmlSafeGet(function () { return child.property('ADBE Vector Star Outer Radius').value; }) || 0,
      innerRoundness: _ehtmlSafeGet(function () { return child.property('ADBE Vector Star Inner Roundness').value; }) || 0,
      outerRoundness: _ehtmlSafeGet(function () { return child.property('ADBE Vector Star Outer Roundness').value; }) || 0
    };
  }
  return null;
}

// Refactored shape extractor: returns { shapes: [...], fills: [...], strokes: [...], trim: {...}|null }
// Each shape / fill / stroke is independent, preserving AE's order inside contents group
// for layered rendering (lottie-web pattern). Backward-compat fields (primitive/fillColor/…) are
// populated from the first shape/fill/stroke for callers that don't yet read arrays.
function _ehtmlExtractShapeExtras (layer) {
  var contents = _ehtmlSafeGet(function () { return layer.property('ADBE Root Vectors Group'); });
  if (!contents) return null;
  var shapes = [];
  var fills = [];
  var strokes = [];
  var trim = null;
  var repeater = null;
  var roundCorners = null;
  // P3.4: Vector Group transforms. Each nested `ADBE Vector Group` carries its own
  // Transform (anchor/position/scale/rotation/skew/opacity). We flatten primitives but
  // stamp each with the stack of ancestor-group transforms so the client can emit a
  // wrapping <g transform="..."> chain. Static snapshot at t=0 is enough for Phase 3
  // — animated group transforms are a future extension.
  function extractGroupTransformStatic (trProp) {
    var anchor = _ehtmlSafeGet(function () { return trProp.property('ADBE Vector Anchor').value; });
    var position = _ehtmlSafeGet(function () { return trProp.property('ADBE Vector Position').value; });
    var scale = _ehtmlSafeGet(function () { return trProp.property('ADBE Vector Scale').value; });
    var rot = _ehtmlSafeGet(function () { return trProp.property('ADBE Vector Rotation').value; });
    var skew = _ehtmlSafeGet(function () { return trProp.property('ADBE Vector Skew').value; });
    var skewAxis = _ehtmlSafeGet(function () { return trProp.property('ADBE Vector Skew Axis').value; });
    var opVal = _ehtmlSafeGet(function () { return trProp.property('ADBE Vector Group Opacity').value; });
    var isIdentity =
      (!anchor || (anchor[0] === 0 && anchor[1] === 0)) &&
      (!position || (position[0] === 0 && position[1] === 0)) &&
      (!scale || (scale[0] === 100 && scale[1] === 100)) &&
      (!rot || rot === 0) &&
      (!skew || skew === 0) &&
      (opVal == null || opVal === 100);
    if (isIdentity) return null;
    return {
      anchor: anchor ? [anchor[0] || 0, anchor[1] || 0] : [0, 0],
      position: position ? [position[0] || 0, position[1] || 0] : [0, 0],
      scale: scale ? [scale[0] || 100, scale[1] || 100] : [100, 100],
      rotation: (typeof rot === 'number') ? rot : 0,
      skew: (typeof skew === 'number') ? skew : 0,
      skewAxis: (typeof skewAxis === 'number') ? skewAxis : 0,
      opacity: (typeof opVal === 'number') ? opVal : 100
    };
  }
  var groupStack = [];
  function scan (group) {
    var n = _ehtmlSafeGet(function () { return group.numProperties; }) || 0;
    for (var i = 1; i <= n; i++) {
      var child = _ehtmlSafeGet(function () { return group.property(i); });
      if (!child) continue;
      var mn = _ehtmlSafeGet(function () { return child.matchName; }) || '';
      if (mn === 'ADBE Vector Shape - Rect' || mn === 'ADBE Vector Shape - Ellipse' ||
          mn === 'ADBE Vector Shape - Group' || mn === 'ADBE Vector Shape - Star') {
        var prim = _ehtmlExtractShapePrimitive(child, mn);
        if (prim) {
          if (groupStack.length > 0) prim.groupStack = groupStack.slice();
          shapes.push(prim);
        }
      } else if (mn === 'ADBE Vector Graphic - Fill') {
        fills.push(_ehtmlExtractFill(child));
      } else if (mn === 'ADBE Vector Graphic - Stroke') {
        strokes.push(_ehtmlExtractStroke(child));
      } else if (mn === 'ADBE Vector Graphic - G-Fill') {
        var gf = _ehtmlExtractGradient(child);
        gf.gradient = true;
        fills.push(gf);
      } else if (mn === 'ADBE Vector Graphic - G-Stroke') {
        var gs = _ehtmlExtractGradient(child);
        // Blend stroke attributes (width, cap, join) — same shape as regular stroke
        var sw = _ehtmlSafeGet(function () { return child.property('ADBE Vector Stroke Width').value; });
        var capIdx = _ehtmlSafeGet(function () { return child.property('ADBE Vector Stroke Line Cap').value; });
        var joinIdx = _ehtmlSafeGet(function () { return child.property('ADBE Vector Stroke Line Join').value; });
        var capMap2 = { 1: 'butt', 2: 'round', 3: 'square' };
        var joinMap2 = { 1: 'miter', 2: 'round', 3: 'bevel' };
        gs.gradient = true;
        gs.width = (typeof sw === 'number') ? sw : 0;
        gs.lineCap = capMap2[capIdx] || 'butt';
        gs.lineJoin = joinMap2[joinIdx] || 'miter';
        gs.miterLimit = 4;
        gs.dashArray = [];
        gs.dashOffset = 0;
        strokes.push(gs);
      } else if (mn === 'ADBE Vector Filter - Trim') {
        // Trim paths modifier (P2.2)
        var trimStart = _ehtmlSafeGet(function () { return child.property('ADBE Vector Trim Start').value; });
        var trimEnd = _ehtmlSafeGet(function () { return child.property('ADBE Vector Trim End').value; });
        var trimOffset = _ehtmlSafeGet(function () { return child.property('ADBE Vector Trim Offset').value; });
        trim = {
          start: (typeof trimStart === 'number') ? trimStart : 0,
          end: (typeof trimEnd === 'number') ? trimEnd : 100,
          offset: (typeof trimOffset === 'number') ? trimOffset : 0
        };
      } else if (mn === 'ADBE Vector Filter - Repeater') {
        // Repeater modifier (P4.2) — extract full per-copy transform so client can stamp N copies.
        var copies = _ehtmlSafeGet(function () { return child.property('ADBE Vector Repeater Copies').value; });
        var rOffset = _ehtmlSafeGet(function () { return child.property('ADBE Vector Repeater Offset').value; });
        var rTrans = _ehtmlSafeGet(function () { return child.property('ADBE Vector Repeater Transform'); });
        var rAnchor = _ehtmlSafeGet(function () { return rTrans.property('ADBE Vector Repeater Anchor Point').value; });
        var rPos = _ehtmlSafeGet(function () { return rTrans.property('ADBE Vector Repeater Position').value; });
        var rScale = _ehtmlSafeGet(function () { return rTrans.property('ADBE Vector Repeater Scale').value; });
        var rRot = _ehtmlSafeGet(function () { return rTrans.property('ADBE Vector Repeater Rotation').value; });
        var rStartOp = _ehtmlSafeGet(function () { return rTrans.property('ADBE Vector Repeater Start Opacity').value; });
        var rEndOp = _ehtmlSafeGet(function () { return rTrans.property('ADBE Vector Repeater End Opacity').value; });
        repeater = {
          copies: (typeof copies === 'number') ? Math.round(copies) : 1,
          offset: (typeof rOffset === 'number') ? rOffset : 0,
          anchor: rAnchor ? [rAnchor[0] || 0, rAnchor[1] || 0] : [0, 0],
          position: rPos ? [rPos[0] || 0, rPos[1] || 0] : [0, 0],
          scale: rScale ? [rScale[0] || 100, rScale[1] || 100] : [100, 100],
          rotation: (typeof rRot === 'number') ? rRot : 0,
          startOpacity: (typeof rStartOp === 'number') ? rStartOp : 100,
          endOpacity: (typeof rEndOp === 'number') ? rEndOp : 100
        };
      } else if (mn === 'ADBE Vector Filter - RC') {
        // Round Corners modifier (P4.3)
        var rcRadius = _ehtmlSafeGet(function () { return child.property('ADBE Vector RoundCorner Radius').value; });
        roundCorners = { radius: (typeof rcRadius === 'number') ? rcRadius : 0 };
      } else if (mn === 'ADBE Vector Group' || mn === 'ADBE Vectors Group') {
        var trProp = _ehtmlSafeGet(function () { return child.property('ADBE Vector Transform Group'); });
        var groupTr = trProp ? extractGroupTransformStatic(trProp) : null;
        if (groupTr) groupStack.push(groupTr);
        var inner = _ehtmlSafeGet(function () { return child.property('ADBE Vectors Group'); });
        if (inner) scan(inner);
        if (groupTr) groupStack.pop();
      }
    }
  }
  scan(contents);
  if (shapes.length === 0) return null;
  // Backward-compat: populate legacy flat fields from first shape + first fill + first stroke.
  var firstShape = shapes[0];
  var firstFill = fills[0] || { color: null, opacity: 1 };
  var firstStroke = strokes[0] || { color: null, width: 0, opacity: 1, lineCap: 'butt', lineJoin: 'miter' };
  return {
    // New array-based API
    shapes: shapes,
    fills: fills,
    strokes: strokes,
    trim: trim,
    repeater: repeater,
    roundCorners: roundCorners,
    // Legacy flat fields (first of each kind) — kept for backward compatibility
    primitive: firstShape.primitive,
    size: firstShape.size,
    position: firstShape.position,
    path: firstShape.path || null,
    roundness: firstShape.roundness || 0,
    polystarType: firstShape.polystarType,
    points: firstShape.points,
    rotation: firstShape.rotation,
    innerRadius: firstShape.innerRadius,
    outerRadius: firstShape.outerRadius,
    innerRoundness: firstShape.innerRoundness,
    outerRoundness: firstShape.outerRoundness,
    fillColor: firstFill.color,
    fillOpacity: firstFill.opacity,
    strokeColor: firstStroke.color,
    strokeWidth: firstStroke.width,
    strokeOpacity: firstStroke.opacity,
    strokeLineCap: firstStroke.lineCap,
    strokeLineJoin: firstStroke.lineJoin
  };
}

function motionExport_extractCompForHtml () {
  var warnings = [];
  var comp = null;
  try { comp = app.project.activeItem; } catch (eAi) { comp = null; }
  if (!comp || !(comp instanceof CompItem)) {
    return resultToJson({ ok: false, message: 'No active composition' });
  }
  var compInfo = {
    name: comp.name,
    width: comp.width,
    height: comp.height,
    duration: comp.duration,
    frameRate: comp.frameRate,
    pixelAspect: _ehtmlSafeGet(function () { return comp.pixelAspect; }) || 1,
    bgColor: _ehtmlColorToCss(_ehtmlSafeGet(function () { return comp.bgColor; }))
  };
  var layersOut = [];
  var numL = comp.numLayers || 0;
  for (var li = 1; li <= numL; li++) {
    var layer = null;
    try { layer = comp.layer(li); } catch (eLay) { continue; }
    if (!layer) continue;
    // Skip disabled (hidden / eye off) layers — AE doesn't render them, HTML shouldn't either.
    var layerEnabled = _ehtmlSafeGet(function () { return layer.enabled; }) !== false;
    if (!layerEnabled) continue;
    var lType = _ehtmlLayerType(layer);
    var layerBake = { count: 0, samples: 0 };
    // Parent chain: AE layer.parent → another layer (or null). We record 1-based index
    // so client-side can walk the chain and compose transforms.
    var parentLayer = _ehtmlSafeGet(function () { return layer.parent; });
    var parentIdxVal = parentLayer ? _ehtmlSafeGet(function () { return parentLayer.index; }) : null;
    var ent = {
      type: lType,
      name: _ehtmlSafeGet(function () { return layer.name; }) || '',
      index: li,
      parentIndex: parentIdxVal,
      inPoint: _ehtmlSafeGet(function () { return layer.inPoint; }),
      outPoint: _ehtmlSafeGet(function () { return layer.outPoint; }),
      enabled: layerEnabled,
      anchor: _ehtmlExtractAnchorPoint(layer),
      autoOrient: _ehtmlSafeGet(function () {
        if (typeof AutoOrientType === 'undefined') return false;
        var ao = layer.autoOrient;
        return ao === AutoOrientType.ALONG_PATH;
      }) === true,
      // Track Matte: AE enum values NO_TRACK_MATTE / ALPHA / ALPHA_INVERTED / LUMA / LUMA_INVERTED.
      // `isTrackMatte` marks this layer as the matte source for the layer BELOW it.
      trackMatteType: _ehtmlSafeGet(function () {
        if (typeof TrackMatteType === 'undefined') return 'none';
        var tm = layer.trackMatteType;
        if (tm === TrackMatteType.ALPHA) return 'alpha';
        if (tm === TrackMatteType.ALPHA_INVERTED) return 'alpha-inverted';
        if (tm === TrackMatteType.LUMA) return 'luma';
        if (tm === TrackMatteType.LUMA_INVERTED) return 'luma-inverted';
        return 'none';
      }) || 'none',
      isTrackMatte: _ehtmlSafeGet(function () { return layer.isTrackMatte === true; }) === true,
      transform: _ehtmlExtractTransform(layer, comp, layerBake),
      extras: null
    };
    if (layerBake.count > 0) {
      warnings.push('Layer "' + ent.name + '": baked ' + layerBake.count +
        ' expression-driven propert' + (layerBake.count === 1 ? 'y' : 'ies') +
        ' into ' + layerBake.samples + ' sample keyframe(s)');
    }
    // Parent chain composition (P3.3) is applied client-side: the exporter walks the
    // `parentIndex` chain at each keyframe time and composes world matrices. No warning needed.
    if (lType === 'text') {
      ent.extras = { text: _ehtmlExtractTextExtras(layer) };
    } else if (lType === 'shape') {
      ent.extras = { shape: _ehtmlExtractShapeExtras(layer) };
    } else if (lType === 'av') {
      var mediaInfo = _ehtmlExtractMediaExtras(layer);
      if (mediaInfo) {
        ent.extras = { media: mediaInfo };
        if (mediaInfo.isVideo) {
          warnings.push('Layer "' + ent.name + '" is video (' + mediaInfo.fileName + ') — embedded as <video>; looping not yet wired, use pre-rendered WebM for autoplay on banners');
        }
      }
    }
    // Effects: extract what we can translate (Fill effect → CSS fill override),
    // warn only for unsupported effects so user sees what was dropped.
    var effects = _ehtmlExtractEffects(layer);
    if (effects) ent.effects = effects;
    var numEffects = _ehtmlSafeGet(function () { return layer.property('ADBE Effect Parade').numProperties; }) || 0;
    var supportedEffects = 0;
    if (effects) {
      if (effects.fill) supportedEffects++;
      if (effects.dropShadow) supportedEffects++;
      if (effects.blur) supportedEffects++;
      if (effects.invert) supportedEffects++;
      if (effects.brightnessContrast) supportedEffects++;
      if (effects.hueSaturation) supportedEffects++;
      if (effects.tint) supportedEffects++;
    }
    if (numEffects > supportedEffects) {
      warnings.push('Layer "' + ent.name + '" has ' + (numEffects - supportedEffects) +
        ' unsupported effect(s) — not exported (supported: Fill, Drop Shadow, Gaussian Blur, Invert, Brightness & Contrast, Hue/Saturation, Tint)');
    }
    // Masks: extract shape + keyframes for reveal animations.
    var masks = _ehtmlExtractMasks(layer);
    if (masks) ent.masks = masks;
    var blend = _ehtmlSafeGet(function () { return layer.blendingMode; });
    ent.blendMode = _ehtmlBlendModeName(blend);
    if (typeof BlendingMode !== 'undefined' && blend && blend !== BlendingMode.NORMAL && ent.blendMode === 'normal') {
      // We couldn't map this blend mode to CSS — warn the user it was dropped.
      warnings.push('Layer "' + ent.name + '" uses a blend mode with no CSS equivalent — falling back to normal');
    }
    layersOut.push(ent);
  }
  return resultToJson({
    ok: true,
    comp: compInfo,
    layers: layersOut,
    warnings: warnings
  });
}

function motionExport_selectExportFolder (defaultPath) {
  try {
    var dp = defaultPath && defaultPath.length > 0 ? defaultPath : '~';
    var f = Folder.selectDialog('Select output folder for HTML export', new Folder(dp));
    if (!f) return resultToJson({ ok: false, cancelled: true });
    return resultToJson({ ok: true, path: f.fsName });
  } catch (e) {
    return resultToJson({ ok: false, message: 'selectDialog error: ' + e.toString() });
  }
}

// ============================================================================
// JSON serialization
// ============================================================================

function resultToJson (obj) {
  // Recursive JSON stringifier for simple objects and arrays used by this panel.
  // ExtendScript does not have JSON.stringify by default in older versions, so we
  // provide a minimal, safe implementation.
  function serializeValue (value) {
    if (value === null || value === undefined) {
      return 'null';
    }
    var t = typeof value;
    if (t === 'string') {
      return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    }
    if (t === 'boolean') {
      return value ? 'true' : 'false';
    }
    if (t === 'number') {
      return value.toString();
    }
    // Arrays
    if (value instanceof Array) {
      var items = [];
      for (var i = 0; i < value.length; i++) {
        items.push(serializeValue(value[i]));
      }
      return '[' + items.join(',') + ']';
    }
    // Plain objects (best-effort; ignores prototype chain).
    var parts = [];
    for (var key in value) {
      if (!value.hasOwnProperty(key)) continue;
      parts.push('"' + key + '":' + serializeValue(value[key]));
    }
    return '{' + parts.join(',') + '}';
  }

  return serializeValue(obj);
}

