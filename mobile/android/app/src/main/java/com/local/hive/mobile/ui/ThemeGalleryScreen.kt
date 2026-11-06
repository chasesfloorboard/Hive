package com.local.hive.mobile.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.data.ThemeGallery
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveText

/** A gallery value ("#3e2a20", "rgba(255,255,255,0.72)") as a Compose colour. */
private fun galleryColour(v: String?): Color {
    val s = v?.trim().orEmpty()
    runCatching {
        if (s.startsWith("#")) {
            val h = s.drop(1).let { if (it.length <= 4) it.map { c -> "$c$c" }.joinToString("") else it }
            val rgb = h.take(6).toLong(16)
            val a = if (h.length == 8) h.substring(6, 8).toInt(16) / 255f else 1f
            return Color(((rgb shr 16) and 255).toInt(), ((rgb shr 8) and 255).toInt(), (rgb and 255).toInt()).copy(alpha = a)
        }
        val n = Regex("[\\d.]+").findAll(s).map { it.value.toFloat() }.toList()
        return Color(n[0].toInt(), n[1].toInt(), n[2].toInt()).copy(alpha = n.getOrElse(3) { 1f })
    }
    return Color.Gray
}

/** Browse themes: what people shared (the gallery), each with a preview and Add. */
fun LazyListScope.themeGallery(vm: MainViewModel) {
    item { ThemeGalleryList(vm) }
}

@Composable
private fun ThemeGalleryList(vm: MainViewModel) {
    val context = LocalContext.current
    val c = Hive.colors
    var state by remember { mutableStateOf<Pair<List<ThemeGallery.Theme>, Boolean>?>(null) }
    LaunchedEffect(Unit) { state = ThemeGallery.load(context, com.local.hive.mobile.stream.AppleMusic.defaultHttp()) }
    val saved by vm.themes.saved.collectAsStateWithLifecycle()
    val current by vm.themes.name.collectAsStateWithLifecycle()
    val s = state
    Column(Modifier.padding(horizontal = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(
            when {
                s == null -> "Loading the gallery…"
                s.first.isEmpty() -> "The gallery couldn't be reached. Try again later."
                !s.second -> "Offline: the gallery as it came with Hive. ${s.first.size} themes."
                else -> "${s.first.size} themes people shared. Add one and it becomes your theme."
            },
            style = HiveText.small, color = c.textDim, modifier = Modifier.padding(horizontal = 6.dp),
        )
        if (s == null) Busy("Loading…")
        s?.first.orEmpty().chunked(2).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                row.forEach { t ->
                    val have = saved.firstOrNull { it.css == t.css }
                    GalleryCard(t, Modifier.weight(1f), using = have != null && current == have.name, added = have != null) {
                        if (have != null) vm.themes.apply(have.css, have.name) else vm.themes.saveTheme(t.name, t.css)
                    }
                }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun GalleryCard(t: ThemeGallery.Theme, modifier: Modifier, using: Boolean, added: Boolean, onUse: () -> Unit) {
    val c = Hive.colors
    val bg = galleryColour(t.vars["--bg"]); val text = galleryColour(t.vars["--text"]); val accent = galleryColour(t.vars["--accent"])
    val panel = galleryColour(t.vars["--panel"] ?: t.vars["--bg"]); val dim = galleryColour(t.vars["--text-dim"] ?: t.vars["--text"])
    Column(modifier.clip(RoundedCornerShape(16.dp)).background(c.control).padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        // A small picture of Hive in this theme: the side panel, two lines of text, the accent.
        Row(Modifier.fillMaxWidth().height(86.dp).clip(RoundedCornerShape(10.dp)).background(bg)) {
            Box(Modifier.width(30.dp).fillMaxHeight().background(panel))
            Column(Modifier.padding(10.dp).weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(Modifier.fillMaxWidth(0.85f).height(6.dp).clip(RoundedCornerShape(3.dp)).background(text))
                Box(Modifier.fillMaxWidth(0.55f).height(6.dp).clip(RoundedCornerShape(3.dp)).background(dim))
                Spacer(Modifier.weight(1f))
                Box(Modifier.fillMaxWidth(0.5f).height(12.dp).clip(RoundedCornerShape(50)).background(accent))
            }
        }
        Text(t.name, style = HiveText.rowStrong, color = c.text, maxLines = 1)
        Text(if (t.author.isNotBlank()) "by ${t.author}" else "Shared theme", style = HiveText.small, color = c.textDim, maxLines = 1)
        Box(Modifier.align(Alignment.Start)) { HiveButton(if (using) "In use" else if (added) "Use" else "Add", primary = !added, enabled = !using, onClick = onUse) }
    }
}

/** Shares the theme in use to the gallery: a GitHub form opens with its colours, once a name passes the filter. */
@Composable
fun ShareThemeDialog(vm: MainViewModel, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val c = Hive.colors
    val currentName by vm.themes.name.collectAsStateWithLifecycle()
    // "Your Hive theme" and "Custom" are labels, not names: the person names their theme.
    var name by remember { mutableStateOf(currentName.takeUnless { it == com.local.hive.mobile.ui.theme.ThemeStore.YOUR_THEME || it == com.local.hive.mobile.ui.theme.ThemeStore.CUSTOM } ?: "My theme") }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { ThemeGallery.loadBlocked(context) }
    HiveDialog(onDismiss, spacing = 10.dp) {
        Text("Share your theme", style = HiveText.year, color = c.text)
        Text("A GitHub form opens with this theme's colours (nothing else). Once approved, it shows in everyone's Browse themes.", style = HiveText.body, color = c.textDim)
        HiveField(name, { name = it; error = null }, "Theme name")
        error?.let { Text(it, style = HiveText.small, color = c.accent) }
        Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            HiveButton("Cancel", onClick = onDismiss)
            HiveButton("Share", primary = true, enabled = name.isNotBlank()) {
                val vars = ThemeGallery.varsFromCss(vm.themes.css)
                if (vars == null) { error = "This theme has no colours Hive can share."; return@HiveButton }
                runCatching { ThemeGallery.shareUrl(name.trim(), vars) }
                    .onSuccess { url -> runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }; onDismiss() }
                    .onFailure { error = it.message }
            }
        }
    }
}
