package com.local.hive.mobile.widget

import android.content.Context
import android.graphics.Bitmap
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.graphics.drawable.toBitmap
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalSize
import androidx.glance.action.ActionParameters
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.updateAll
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ContentScale
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import coil3.SingletonImageLoader
import coil3.request.ImageRequest
import coil3.request.allowHardware
import coil3.toBitmap
import com.local.hive.mobile.HiveApp
import com.local.hive.mobile.MainActivity
import com.local.hive.mobile.R

/** What the widget shows, saved by the player so the widget can draw without it. */
data class WidgetState(val title: String, val artist: String, val art: String?, val playing: Boolean, val accent: Int) {
    companion object {
        private const val PREFS = "widget"
        fun read(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).let { p ->
            WidgetState(p.getString("title", "").orEmpty(), p.getString("artist", "").orEmpty(), p.getString("art", null), p.getBoolean("playing", false), p.getInt("accent", 0xFFECE9F2.toInt()))
        }
        fun write(context: Context, s: WidgetState) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("title", s.title).putString("artist", s.artist).putString("art", s.art).putBoolean("playing", s.playing).putInt("accent", s.accent).apply()
    }
}

/**
 * Hive's home-screen widget: the playing song's cover, title and artist on
 * Hive's dark glass, with previous, play/pause and next. A tap on the cover
 * or names opens Hive's player.
 */
class HiveWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Responsive(setOf(SMALL, WIDE, TALL))

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val saved = WidgetState.read(context)
        // A running widget session recomposes rather than calling provideGlance again, so state is collected here.
        provideContent {
            val live by current.collectAsState()
            val state = live ?: saved
            val art by androidx.compose.runtime.produceState<Bitmap?>(null, state.art) { value = state.art?.let { loadArt(context, it) } }
            GlanceTheme { Content(state, art) }
        }
    }

    private suspend fun loadArt(context: Context, model: String): Bitmap? = runCatching {
        val result = SingletonImageLoader.get(context).execute(ImageRequest.Builder(context).data(model).size(256).allowHardware(false).build())
        result.image?.toBitmap()
    }.getOrNull()

    @Composable
    private fun Content(s: WidgetState, art: Bitmap?) {
        val size = LocalSize.current
        val accent = Color(s.accent)
        val context = androidx.glance.LocalContext.current
        val open = actionStartActivity(android.content.Intent(context, MainActivity::class.java).putExtra(MainActivity.EXTRA_OPEN_PLAYER, true).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
        val tall = size.height >= TALL.height
        val wide = size.width >= WIDE.width
        val shell = GlanceModifier.fillMaxSize().cornerRadius(24.dp).background(Color(0xF2121218)).padding(12.dp)

        @Composable
        fun Cover(side: androidx.compose.ui.unit.Dp) = Box(GlanceModifier.size(side).cornerRadius(14.dp).background(Color(0xFF26262E)).clickable(open), contentAlignment = Alignment.Center) {
            if (art != null) Image(ImageProvider(art), contentDescription = null, modifier = GlanceModifier.size(side).cornerRadius(14.dp), contentScale = ContentScale.Crop)
            else Image(ImageProvider(R.drawable.hive_logo), contentDescription = null, modifier = GlanceModifier.size(side / 2))
        }

        @Composable
        fun Names(modifier: GlanceModifier) = Column(modifier.clickable(open)) {
            Text(s.title.ifBlank { "Hive" }, maxLines = 1, style = TextStyle(color = ColorProvider(Color(0xFFECE9F2)), fontSize = 15.sp, fontWeight = FontWeight.Bold))
            Text(s.artist.ifBlank { "Tap to open" }, maxLines = 1, style = TextStyle(color = ColorProvider(Color(0xFF9A97A8)), fontSize = 13.sp))
        }

        @Composable
        fun PlayButton(side: androidx.compose.ui.unit.Dp) = Box(GlanceModifier.size(side).cornerRadius(side / 2).background(accent).clickable(actionRunCallback<TogglePlay>()), contentAlignment = Alignment.Center) {
            Image(ImageProvider(if (s.playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play), if (s.playing) "Pause" else "Play",
                GlanceModifier.size(side * 0.55f), colorFilter = androidx.glance.ColorFilter.tint(ColorProvider(if (luminance(s.accent) > 0.5) Color(0xFF0A0A0D) else Color.White)))
        }

        if (tall) {
            // Cover and names over the controls.
            Column(shell) {
                Row(GlanceModifier.defaultWeight(), verticalAlignment = Alignment.CenterVertically) {
                    Cover(64.dp)
                    Spacer(GlanceModifier.width(12.dp))
                    Names(GlanceModifier.defaultWeight())
                }
                Row(GlanceModifier.padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Spacer(GlanceModifier.defaultWeight())
                    Control(android.R.drawable.ic_media_previous, "Previous", Color(0xFFECE9F2), actionRunCallback<Previous>())
                    Spacer(GlanceModifier.width(14.dp))
                    PlayButton(48.dp)
                    Spacer(GlanceModifier.width(14.dp))
                    Control(android.R.drawable.ic_media_next, "Next", Color(0xFFECE9F2), actionRunCallback<Next>())
                    Spacer(GlanceModifier.defaultWeight())
                }
            }
        } else Row(shell, verticalAlignment = Alignment.CenterVertically) {
            Cover(48.dp)
            if (wide) { Spacer(GlanceModifier.width(12.dp)); Names(GlanceModifier.defaultWeight()) } else Spacer(GlanceModifier.defaultWeight())
            if (wide) Control(android.R.drawable.ic_media_previous, "Previous", Color(0xFFECE9F2), actionRunCallback<Previous>())
            PlayButton(44.dp)
            Control(android.R.drawable.ic_media_next, "Next", Color(0xFFECE9F2), actionRunCallback<Next>())
        }
    }

    @Composable
    private fun Control(icon: Int, label: String, tint: Color, action: androidx.glance.action.Action) {
        Box(GlanceModifier.size(40.dp).clickable(action), contentAlignment = Alignment.Center) {
            Image(ImageProvider(icon), label, GlanceModifier.size(22.dp), colorFilter = androidx.glance.ColorFilter.tint(ColorProvider(tint)))
        }
    }

    companion object {
        private val SMALL = DpSize(110.dp, 56.dp)
        private val WIDE = DpSize(180.dp, 56.dp)
        private val TALL = DpSize(180.dp, 110.dp)

        private fun luminance(argb: Int): Double {
            fun ch(v: Int) = (v / 255.0).let { if (it <= 0.03928) it / 12.92 else Math.pow((it + 0.055) / 1.055, 2.4) }
            return 0.2126 * ch((argb shr 16) and 0xFF) + 0.7152 * ch((argb shr 8) and 0xFF) + 0.0722 * ch(argb and 0xFF)
        }

        private val current = kotlinx.coroutines.flow.MutableStateFlow<WidgetState?>(null)

        /** Saves what is playing and redraws every Hive widget. */
        suspend fun update(context: Context, state: WidgetState) {
            WidgetState.write(context, state)
            current.value = state
            HiveWidget().updateAll(context)
        }
    }
}

class HiveWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = HiveWidget()
}

// Widget actions arrive off the main thread; the player may only be touched on it.
private suspend fun onPlayer(context: Context, block: (com.local.hive.mobile.playback.PlayerConnection) -> Unit) =
    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) { block((context.applicationContext as HiveApp).player) }

class TogglePlay : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) = onPlayer(context) { it.togglePlay() }
}

class Previous : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) = onPlayer(context) { it.previous() }
}

class Next : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) = onPlayer(context) { it.next() }
}
