package com.local.hive.mobile.ui

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.util.Base64
import android.util.Log
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil3.request.allowHardware
import com.local.hive.mobile.data.PluginStore
import com.local.hive.mobile.playback.NowPlaying
import com.local.hive.mobile.playback.SpectrumBus
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveText
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

/**
 * Sandboxed Android WebView runtime for Hive API v2 JS/CSS plugins (both Verified
 * and Community/Untested).
 *
 * Security invariants matching desktop's `plugin-frame.html`:
 * - Zero network access (`blockNetworkLoads = true`, `shouldInterceptRequest` refuses all URLs, strict CSP).
 * - Zero file/content URI access (`allowFileAccess = false`, `allowContentAccess = false`).
 * - Permission checks enforced for every `Hive.*` capability (`player.read`, `player.control`,
 *   `spectrum.read`, `settings`, `ui.view`).
 */
@Composable
fun PluginHostScreen(
    vm: MainViewModel,
    pluginId: String,
    onToast: (String) -> Unit,
    onBack: () -> Unit,
) {
    AllowLandscape(true)
    val c = Hive.colors
    val context = LocalContext.current
    val installed by vm.plugins.installed.collectAsStateWithLifecycle()
    val entry = installed.firstOrNull { it.plugin.id == pluginId }
    val now by vm.nowPlaying.collectAsStateWithLifecycle()

    if (entry == null) {
        Box(Modifier.fillMaxSize().background(c.bg).statusBarsPadding().navigationBarsPadding()) {
            PageBar("Plugin", 0f, onBack)
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("This plugin is no longer installed.", style = HiveText.body, color = c.textDim)
            }
        }
        return
    }

    val plugin = entry.plugin
    val hasSpectrum = "spectrum.read" in plugin.permissions
    var editingSettings by remember { mutableStateOf(false) }
    var webViewRef by remember { mutableStateOf<WebView?>(null) }
    var pageReady by remember { mutableStateOf(false) }
    var coverDataUri by remember { mutableStateOf<String?>(null) }

    if (hasSpectrum) {
        DisposableEffect(plugin.id) {
            SpectrumBus.acquire()
            onDispose { SpectrumBus.release() }
        }
    }

    // Load playing cover art safely as a base64 data URI (never exposing file/content paths to the WebView).
    LaunchedEffect(now.artworkUri, plugin.id) {
        val uri = now.artworkUri
        if (uri == null || "player.read" !in plugin.permissions) {
            coverDataUri = null
            return@LaunchedEffect
        }
        coverDataUri = withContext(Dispatchers.IO) {
            runCatching {
                val res = coil3.SingletonImageLoader.get(context).execute(
                    coil3.request.ImageRequest.Builder(context)
                        .data(uri)
                        .size(320)
                        .allowHardware(false)
                        .build()
                )
                val bm = (res.image as? coil3.BitmapImage)?.bitmap ?: return@runCatching null
                val out = ByteArrayOutputStream()
                bm.compress(Bitmap.CompressFormat.JPEG, 82, out)
                "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
            }.getOrNull()
        }
    }

    // Push track updates into the sandboxed WebView once the HTML runtime finishes loading.
    LaunchedEffect(webViewRef, pageReady, now.mediaId, now.title, now.artist, now.album, coverDataUri) {
        val wv = webViewRef ?: return@LaunchedEffect
        if (!pageReady || "player.read" !in plugin.permissions) return@LaunchedEffect
        val payload = buildTrackJson(now, coverDataUri)
        wv.evaluateJavascript("window.__hiveDeliver && window.__hiveDeliver('track-change', $payload);", null)
    }

    // Push playback state updates into the sandboxed WebView.
    LaunchedEffect(webViewRef, pageReady, now.isPlaying, now.mediaId, now.durationMs) {
        val wv = webViewRef ?: return@LaunchedEffect
        if (!pageReady || "player.read" !in plugin.permissions) return@LaunchedEffect
        val trackPart = buildTrackJson(now, coverDataUri)
        val posSec = vm.position.value / 1000.0
        val durSec = now.durationMs / 1000.0
        val paused = !now.isPlaying
        wv.evaluateJavascript(
            """window.__hiveDeliver && window.__hiveDeliver('playback', {"state":{"track":$trackPart,"position":$posSec,"duration":$durSec,"paused":$paused}});""",
            null,
        )
    }

    // Push settings updates into the sandboxed WebView.
    LaunchedEffect(webViewRef, pageReady, entry.settings) {
        val wv = webViewRef ?: return@LaunchedEffect
        if (!pageReady || "settings" !in plugin.permissions) return@LaunchedEffect
        val payload = buildSettingsJson(entry)
        wv.evaluateJavascript("window.__hiveDeliver && window.__hiveDeliver('settings', $payload);", null)
    }

    // Push latency-aligned 60 fps spectrum frames when the plugin declared `spectrum.read`.
    LaunchedEffect(webViewRef, pageReady, hasSpectrum, now.isPlaying, now.speed) {
        val wv = webViewRef ?: return@LaunchedEffect
        if (!pageReady || !hasSpectrum) return@LaunchedEffect
        val scratch = FloatArray(SpectrumBus.BANDS)
        var routeCheckTick = 0
        var latencyMs = SpectrumBus.estimatedOutputLatencyMs(context)
        while (true) {
            if (routeCheckTick++ % 120 == 0) latencyMs = SpectrumBus.estimatedOutputLatencyMs(context)
            val levels = SpectrumBus.sampleNow(now.isPlaying, now.speed, latencyMs, scratch)
            val arr = levels.joinToString(",", "[", "]") { "%.3f".format(java.util.Locale.US, it) }
            wv.evaluateJavascript("window.__hiveDeliver && window.__hiveDeliver('spectrum', $arr);", null)
            delay(16L)
        }
    }

    val html = remember(plugin.id, plugin.version, c.bg, c.text, c.textDim, c.accent, c.panelStrong) {
        buildSandboxHtml(
            entry = entry,
            initialTrackJson = if ("player.read" in plugin.permissions) buildTrackJson(now, coverDataUri) else "null",
            initialPaused = !now.isPlaying,
            bg = c.bg,
            panel = c.panelStrong,
            text = c.text,
            textDim = c.textDim,
            accent = c.accent,
        )
    }

    Column(Modifier.fillMaxSize().background(c.bg).statusBarsPadding().navigationBarsPadding()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BarIcon(Icons.AutoMirrored.Rounded.ArrowBack, "Back", onBack)
            Text(plugin.name, style = HiveText.rowStrong, color = c.text, modifier = Modifier.padding(start = 4.dp))
            Spacer(Modifier.width(8.dp))
            Text(
                if (plugin.verified) "Verified" else "Untested",
                style = HiveText.small,
                color = if (plugin.verified) Color(0xFF6EE7B7) else Color(0xFFFBBF24),
                modifier = Modifier
                    .clip(RoundedCornerShape(999.dp))
                    .background(if (plugin.verified) Color(0x2834D399) else Color(0x28F59E0B))
                    .padding(horizontal = 8.dp, vertical = 2.dp),
            )
            Spacer(Modifier.weight(1f))
            if (plugin.settings.isNotEmpty()) {
                BarIcon(Icons.Rounded.Tune, "Plugin settings", { editingSettings = true }, tint = c.textDim)
            }
        }

        AndroidView(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            factory = { ctx ->
                createSandboxedWebView(ctx, vm, entry, c.bg.toArgb(), onToast, onReady = { pageReady = true }).also { wv ->
                    webViewRef = wv
                    pageReady = false
                    // Use a synthetic non-null base URL so Android WebView never treats `#` in CSS hex colors
                    // as a `data:` URI fragment. Zero network access is enforced by `blockNetworkLoads = true`
                    // + `shouldInterceptRequest` returning 403 for every request + `connect-src 'none'` CSP.
                    wv.loadDataWithBaseURL("https://sandbox.hive.invalid/", html, "text/html", "utf-8", null)
                }
            },
            onRelease = { wv ->
                webViewRef = null
                pageReady = false
                wv.stopLoading()
                wv.removeJavascriptInterface("HiveNative")
                wv.destroy()
            },
        )
    }

    if (editingSettings) {
        PluginSettingsDialog(vm, entry) { editingSettings = false }
    }
}

@SuppressLint("SetJavaScriptEnabled")
private fun createSandboxedWebView(
    context: android.content.Context,
    vm: MainViewModel,
    entry: PluginStore.InstalledPlugin,
    bgArgb: Int,
    onToast: (String) -> Unit,
    onReady: () -> Unit,
): WebView {
    val perms = entry.plugin.permissions.toSet()
    return WebView(context).apply {
        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        setBackgroundColor(bgArgb)
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = false
            databaseEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            blockNetworkLoads = true
            blockNetworkImage = true
            cacheMode = WebSettings.LOAD_NO_CACHE
            setSupportMultipleWindows(false)
            setGeolocationEnabled(false)
        }
        webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: ConsoleMessage?): Boolean {
                if (msg != null) Log.d("HivePluginWebView", "[${entry.plugin.id}] ${msg.messageLevel()}: ${msg.message()}")
                return true
            }
        }
        webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                onReady()
            }
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = true
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                // Allow only the host-loaded main-frame `data:` document from loadDataWithBaseURL;
                // refuse every network, file, content, or subresource request (zero-network sandbox).
                val scheme = request?.url?.scheme
                if (request?.isForMainFrame == true && scheme.equals("data", ignoreCase = true)) {
                    return null
                }
                return WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
            }
        }
        addJavascriptInterface(object {
            @JavascriptInterface
            fun toast(message: String) {
                val clean = message.take(140)
                post { onToast(clean) }
            }

            @JavascriptInterface
            fun saveSettings(jsonText: String) {
                if ("settings" !in perms) return
                val parsed = runCatching {
                    val obj = org.json.JSONObject(jsonText)
                    val out = LinkedHashMap<String, String>()
                    val keys = obj.keys()
                    while (keys.hasNext()) {
                        val k = keys.next()
                        if (k.length <= 64) out[k] = obj.optString(k, "")
                    }
                    out
                }.getOrNull() ?: return
                post { vm.plugins.updateSettings(entry.plugin.id, parsed) }
            }

            @JavascriptInterface
            fun control(action: String) {
                if ("player.control" !in perms) return
                post {
                    when (action) {
                        "play" -> if (!vm.nowPlaying.value.isPlaying) vm.player.togglePlay()
                        "pause" -> if (vm.nowPlaying.value.isPlaying) vm.player.togglePlay()
                        "toggle" -> vm.player.togglePlay()
                        "next" -> vm.player.next()
                        "previous" -> vm.player.previous()
                    }
                }
            }
        }, "HiveNative")
    }
}

private fun colorHex(color: Color): String = String.format("#%06X", color.toArgb() and 0xFFFFFF)

private fun jsonQuote(s: String): String = Json.encodeToString(JsonPrimitive.serializer(), JsonPrimitive(s))

private fun buildTrackJson(now: NowPlaying, coverDataUri: String?): String {
    if (now.mediaId == null) return "null"
    val coverPart = if (coverDataUri != null) jsonQuote(coverDataUri) else "null"
    return """{"title":${jsonQuote(now.title)},"artist":${jsonQuote(now.artist)},"album":${jsonQuote(now.album)},"duration":${now.durationMs / 1000.0},"cover":$coverPart}"""
}

private fun buildSettingsJson(entry: PluginStore.InstalledPlugin): String {
    val defs = entry.plugin.settings.associateBy { it.id }
    val parts = entry.settings.entries.map { (k, v) ->
        val type = defs[k]?.type
        val rendered = when (type) {
            "boolean" -> if (v.equals("true", true)) "true" else "false"
            "number" -> (v.toDoubleOrNull() ?: 0.0).toString()
            else -> jsonQuote(v)
        }
        "${jsonQuote(k)}:$rendered"
    }
    return "{${parts.joinToString(",")}}"
}

private fun buildSandboxHtml(
    entry: PluginStore.InstalledPlugin,
    initialTrackJson: String,
    initialPaused: Boolean,
    bg: Color,
    panel: Color,
    text: Color,
    textDim: Color,
    accent: Color,
): String {
    val plugin = entry.plugin
    val permsJson = plugin.permissions.joinToString(",", "[", "]") { jsonQuote(it) }
    val initialSettings = buildSettingsJson(entry)
    val safeCss = plugin.css.replace("</style", "<\\/style", ignoreCase = true)
    val safeJs = jsonQuote(plugin.js).replace("</script", "<\\/script", ignoreCase = true)
    return """
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; connect-src 'none';">
<style>
:root {
  --bg: ${colorHex(bg)};
  --panel: ${colorHex(panel)};
  --text: ${colorHex(text)};
  --text-dim: ${colorHex(textDim)};
  --accent: ${colorHex(accent)};
  --hive-vw: 1vw;
  --hive-vh: 1vh;
}
html, body, #host { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: var(--bg); color: var(--text); font-family: sans-serif; }
$safeCss
</style>
</head>
<body>
<div id="host"></div>
<script>
(function () {
  const PERMS = new Set($permsJson);
  const need = p => { if (!PERMS.has(p)) throw new Error('Plugin lacks permission: ' + p); };
  let currentTrack = $initialTrackJson;
  let currentState = { track: currentTrack, position: 0, duration: currentTrack ? (Number(currentTrack.duration) || 0) : 0, paused: $initialPaused };
  let latestSpectrum = [];
  let currentSettings = $initialSettings;
  const eventListeners = new Map();
  const spectrumListeners = new Set();
  const settingsListeners = new Set();
  const unloads = [];
  const host = document.getElementById('host');

  const Hive = {
    version: 2,
    id: ${jsonQuote(plugin.id)},
    name: ${jsonQuote(plugin.name)},
    player: {
      getCurrent: () => { need('player.read'); return currentTrack ? Object.assign({}, currentTrack) : null; },
      getState: () => { need('player.read'); return Object.assign({}, currentState, { track: currentTrack ? Object.assign({}, currentTrack) : null }); },
      getCoverUrl: (t) => { need('player.read'); const target = t || currentTrack; return target && target.cover ? target.cover : null; },
      play: () => { need('player.control'); window.HiveNative && window.HiveNative.control('play'); },
      pause: () => { need('player.control'); window.HiveNative && window.HiveNative.control('pause'); },
      next: () => { need('player.control'); window.HiveNative && window.HiveNative.control('next'); },
      previous: () => { need('player.control'); window.HiveNative && window.HiveNative.control('previous'); }
    },
    events: {
      on: (name, fn) => {
        if (name === 'track-change' || name === 'playback') need('player.read');
        if (name === 'spectrum') need('spectrum.read');
        if (!eventListeners.has(name)) eventListeners.set(name, new Set());
        eventListeners.get(name).add(fn);
        return () => eventListeners.get(name)?.delete(fn);
      }
    },
    audio: {
      getSpectrum: () => { need('spectrum.read'); return latestSpectrum.slice(); },
      onSpectrum: (fn) => {
        need('spectrum.read');
        spectrumListeners.add(fn);
        return () => spectrumListeners.delete(fn);
      }
    },
    settings: {
      load: async () => { need('settings'); return Object.assign({}, currentSettings); },
      save: async (next) => {
        need('settings');
        currentSettings = Object.assign({}, currentSettings, next || {});
        if (window.HiveNative && window.HiveNative.saveSettings) {
          try { window.HiveNative.saveSettings(JSON.stringify(currentSettings)); } catch {}
        }
        return currentSettings;
      },
      onChange: (fn) => { need('settings'); settingsListeners.add(fn); return () => settingsListeners.delete(fn); }
    },
    ui: {
      toast: (msg) => { window.HiveNative && window.HiveNative.toast(String(msg || '')); },
      addStyle: (css) => { const st = document.createElement('style'); st.textContent = String(css || ''); document.head.appendChild(st); return () => st.remove(); },
      registerView: (def) => {
        need('ui.view');
        if (def && typeof def.mount === 'function') {
          try {
            def.mount(host, { mobile: true, isVisible: () => true, onVisibilityChange: () => () => {} });
          } catch (e) {
            host.textContent = 'Plugin error: ' + e.message;
          }
        }
        return () => { try { def && def.unmount && def.unmount(host); } catch {} };
      }
    },
    lifecycle: {
      onUnload: (fn) => { if (typeof fn === 'function') unloads.push(fn); return () => {}; }
    }
  };

  window.__hiveDeliver = function (type, payload) {
    if (type === 'track-change') {
      currentTrack = payload;
      currentState = Object.assign({}, currentState, { track: payload, duration: payload ? (Number(payload.duration) || 0) : 0 });
      const set = eventListeners.get('track-change');
      if (set) set.forEach(fn => { try { fn(payload); } catch {} });
    } else if (type === 'playback') {
      if (payload && payload.state) currentState = payload.state;
      const set = eventListeners.get('playback');
      if (set) set.forEach(fn => { try { fn(payload); } catch {} });
    } else if (type === 'spectrum') {
      latestSpectrum = Array.isArray(payload) ? payload : [];
      spectrumListeners.forEach(fn => { try { fn(latestSpectrum); } catch {} });
      const set = eventListeners.get('spectrum');
      if (set) set.forEach(fn => { try { fn(latestSpectrum); } catch {} });
    } else if (type === 'settings') {
      currentSettings = payload || {};
      settingsListeners.forEach(fn => { try { fn(currentSettings); } catch {} });
    }
  };

  try {
    const fn = new Function('Hive', $safeJs);
    Promise.resolve(fn(Hive)).catch(err => {
      host.textContent = 'Plugin error: ' + (err && err.message ? err.message : String(err));
    });
  } catch (err) {
    host.textContent = 'Plugin load error: ' + (err && err.message ? err.message : String(err));
  }
})();
</script>
</body>
</html>
""".trimIndent()
}
