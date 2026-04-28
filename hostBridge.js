/**
 * Host Bridge — wraps CSInterface.evalScript calls to ExtendScript.
 * Provides promise-based execution of host functions.
 */
(function () {
  'use strict'

  var hostScriptPath = null
  var hostScriptLoaded = false
  var hostScriptLoadPromise = null

  /**
   * Load the host script (index.jsx) once into ExtendScript engine.
   * Subsequent calls are no-ops. Returns a promise that resolves when ready.
   */
  function ensureHostScriptLoaded () {
    if (hostScriptLoaded) return Promise.resolve()
    if (hostScriptLoadPromise) return hostScriptLoadPromise

    hostScriptLoadPromise = new Promise(function (resolve, reject) {
      try {
        var cs = new CSInterface()
        var ext = cs.getSystemPath(SystemPath.EXTENSION)
        hostScriptPath = ext + '/host/index.jsx'
        var escapedPath = hostScriptPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        // Load once via $.evalFile — defines all functions in the ExtendScript engine.
        cs.evalScript('$.evalFile("' + escapedPath + '"); "ok"', function (resultStr) {
          if (resultStr === 'ok') {
            hostScriptLoaded = true
            resolve()
          } else {
            // Fallback: try reading and inlining the script.
            try {
              var fs = require('fs')
              var content = fs.readFileSync(hostScriptPath, 'utf8')
              cs.evalScript(content + '\n"ok"', function (r2) {
                hostScriptLoaded = true
                resolve()
              })
            } catch (eFallback) {
              reject(new Error('Failed to load host script: ' + (resultStr || eFallback.message)))
            }
          }
        })
      } catch (e) {
        reject(new Error('ensureHostScriptLoaded error: ' + e.message))
      }
    })

    return hostScriptLoadPromise
  }

  /**
   * Execute a host function and return a promise that resolves with the parsed JSON result.
   * The host script is loaded once on first call, then only the function call is sent.
   */
  function evalHostFunction (functionCall) {
    return ensureHostScriptLoaded().then(function () {
      return new Promise(function (resolve, reject) {
        try {
          var cs = new CSInterface()
          cs.evalScript(functionCall, function (resultStr) {
            if (!resultStr || resultStr === 'undefined' || resultStr === 'null') {
              reject(new Error('Host returned empty result for: ' + functionCall))
              return
            }
            try {
              if (resultStr.indexOf('EvalScript error') === 0) {
                reject(new Error(resultStr))
                return
              }
              var parsed = JSON.parse(resultStr)
              resolve(parsed)
            } catch (parseErr) {
              resolve({ ok: true, message: resultStr, raw: resultStr })
            }
          })
        } catch (e) {
          reject(new Error('evalHostFunction error: ' + e.message))
        }
      })
    })
  }

  // Export
  if (typeof window !== 'undefined') {
    window.HOST_BRIDGE = {
      evalHostFunction: evalHostFunction,
      ensureHostScriptLoaded: ensureHostScriptLoaded
    }
  }
})()
