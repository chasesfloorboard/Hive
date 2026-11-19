package com.local.hive.mobile.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.rounded.PlaylistAdd
import androidx.compose.material.icons.automirrored.rounded.PlaylistPlay
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.Album
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.FavoriteBorder
import androidx.compose.material.icons.rounded.Image
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.rounded.MusicNote
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Radio
import androidx.compose.material.icons.rounded.RemoveCircleOutline
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import com.local.hive.mobile.data.StreamTrack
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.mix

@Composable
fun TrackMenu(expanded: Boolean, loved: Boolean, onDismiss: () -> Unit, track: Track, actions: TrackActions) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val toast = LocalToast.current
    val editor = LocalEditor.current
    HiveMenu(expanded, onDismiss) {
        // Two pages: the everyday actions, and "More" for the rest (Samsung Music keeps its song menu this short).
        // Kept inside the menu, so it opens on the first page every time instead of switching to it in view.
        var more by remember { mutableStateOf(false) }
        val openSettings = LocalOpenSettings.current
        SongMenuPages(more) { showMore ->
            if (!showMore) {
                SongMenuHeader(track.songArtUri, track.title, listOf(track.artist, track.album).filter { it.isNotBlank() }.joinToString(" · "))
                SongMenuQuickRow {
                    SongMenuQuick("Next", Icons.AutoMirrored.Rounded.PlaylistPlay) { onDismiss(); actions.onPlayNext(track) }
                    SongMenuQuick("Queue", Icons.AutoMirrored.Rounded.QueueMusic) { onDismiss(); actions.onAddToQueue(track) }
                    SongMenuQuick(if (loved) "Loved" else "Love", if (loved) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder, active = loved) { onDismiss(); actions.onToggleLove(track) }
                    SongMenuQuick("Share", Icons.Rounded.Share) { onDismiss(); Share.tracks(context, listOf(track)) }
                }
                HiveMenuItem("Add to playlist", Icons.AutoMirrored.Rounded.PlaylistAdd) { onDismiss(); actions.onAddToPlaylist(listOf(track)) }
                HiveMenuItem("Go to album", Icons.Rounded.Album) { onDismiss(); actions.onGoToAlbum(track) }
                HiveMenuItem("Go to artist", Icons.Rounded.Person) { onDismiss(); actions.onGoToArtist(track) }
                HiveSubmenuItem("More", Icons.Rounded.MoreHoriz) { more = true }
                HiveMenuDivider()
                actions.onRemoveFromPlaylist?.let { remove ->
                    HiveMenuItem("Remove from playlist", Icons.Rounded.RemoveCircleOutline, destructive = true) { onDismiss(); remove(track) }
                }
                HiveMenuItem("Delete from phone", Icons.Rounded.Delete, destructive = true) { onDismiss(); actions.onDelete(listOf(track)) }
                HiveMenuDivider()
                HiveMenuItem("Settings", Icons.Rounded.Settings) { onDismiss(); openSettings() }
            } else {
                HiveSubmenuBack("More") { more = false }
                HiveMenuItem("Track details", Icons.Rounded.Info) { onDismiss(); actions.onInfo(track) }
                HiveMenuItem("Auto DJ from this song", Icons.Rounded.Radio) { onDismiss(); actions.onAutoDj(listOf(track)) }
                HiveMenuItem("Edit tags", Icons.Rounded.Edit) { onDismiss(); editor.editTags(listOf(track)) }
                HiveMenuItem("Edit cover", Icons.Rounded.Image) { onDismiss(); editor.changeCover(listOf(track)) }
                if (track.replaceableFromSoulseek(context)) HiveMenuItem("Replace with Soulseek copy", Icons.Rounded.Download) { onDismiss(); replaceFromSoulseek(context, track, toast) }
            }
        }
    }
}

/** A song menu's pages: the first, and [more] sliding in from the right (and back out to it). */
@Composable
fun SongMenuPages(more: Boolean, content: @Composable (Boolean) -> Unit) {
    androidx.compose.animation.AnimatedContent(
        more,
        transitionSpec = {
            val dir = if (targetState) 1 else -1
            // The box eases to its new size while the pages cross-fade inside it (clipped, so neither spills out).
            val ease = androidx.compose.animation.core.FastOutSlowInEasing
            (fadeIn(tween(170, delayMillis = 60)) + androidx.compose.animation.slideInHorizontally(tween(240, easing = ease)) { dir * it / 8 }) togetherWith
                (fadeOut(tween(90)) + androidx.compose.animation.slideOutHorizontally(tween(240, easing = ease)) { -dir * it / 8 }) using
                androidx.compose.animation.SizeTransform(clip = true) { _, _ -> tween(240, easing = ease) }
        },
        label = "songMenu",
    ) { page -> Column { content(page) } }
}

/** The song a menu is for: its cover, title and artist, so a long press never acts on the wrong song. */
@Composable
fun SongMenuHeader(art: Any?, title: String, subtitle: String) {
    val c = Hive.colors
    Row(Modifier.fillMaxWidth().widthIn(max = 280.dp).padding(start = 8.dp, end = 8.dp, top = 6.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Artwork(art, Modifier.size(44.dp), HiveShape.thumb, Icons.Rounded.MusicNote)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = HiveText.rowStrong, color = c.text, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
            if (subtitle.isNotBlank()) Text(subtitle, style = HiveText.small, color = c.textDim, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
        }
    }
}

/** A row of the menu's most used actions as icon buttons, under its header. */
@Composable
fun SongMenuQuickRow(content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit) {
    Row(Modifier.fillMaxWidth().padding(bottom = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), content = content)
}

@Composable
fun androidx.compose.foundation.layout.RowScope.SongMenuQuick(label: String, icon: ImageVector, active: Boolean = false, onClick: () -> Unit) {
    val c = Hive.colors
    Column(
        Modifier.weight(1f).height(58.dp).clip(RoundedCorner10).background(c.text.copy(alpha = 0.06f)).clickable(onClick = onClick).padding(vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        Icon(icon, null, tint = if (active) c.accent else c.text, modifier = Modifier.size(20.dp))
        Spacer(Modifier.height(4.dp))
        Text(label, style = HiveText.small.copy(fontSize = 11.sp), color = c.textDim, maxLines = 1)
    }
}

/** A menu item that opens another page of the menu (›). */
@Composable
fun HiveSubmenuItem(label: String, icon: ImageVector?, onClick: () -> Unit) {
    val c = Hive.colors
    Row(
        Modifier.fillMaxWidth().height(46.dp).clip(RoundedCorner10).clickable(onClick = onClick).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) { Icon(icon, null, tint = c.textDim, modifier = Modifier.size(18.dp)); Spacer(Modifier.width(12.dp)) }
        Text(label, style = HiveText.body, color = c.text, modifier = Modifier.weight(1f))
        Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, null, tint = c.textDimmer, modifier = Modifier.size(18.dp))
    }
}

/** The top of a menu's second page: back to the first. */
@Composable
fun HiveSubmenuBack(label: String, onClick: () -> Unit) {
    val c = Hive.colors
    Row(
        Modifier.fillMaxWidth().height(46.dp).clip(RoundedCorner10).clickable(onClick = onClick).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.AutoMirrored.Rounded.KeyboardArrowLeft, "Back", tint = c.textDim, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(8.dp))
        Text(label, style = HiveText.rowStrong, color = c.text)
    }
    HiveMenuDivider()
}

/** Opens a streamed song's album or artist page from anywhere (HiveRoot); no-ops outside it. */
class StreamNav(val album: (StreamTrack) -> Unit, val artist: (StreamTrack) -> Unit)
val LocalStreamNav = androidx.compose.runtime.staticCompositionLocalOf { StreamNav({}, {}) }

/** Opens Settings from anywhere, closing the player first (HiveRoot); a no-op outside it. */
val LocalOpenSettings = androidx.compose.runtime.staticCompositionLocalOf<() -> Unit> { {} }

/**
 * Hive's context menu: glass tinted 7% by the accent, a soft accent glow, and
 * the `inlineDropIn` entrance (fade, a 5 px rise, scale .985 → 1).
 * A ⋮/⋯ button's menu passes [settings], so Settings is always its last item.
 */
@Composable
fun HiveMenu(expanded: Boolean, onDismiss: () -> Unit, above: Dp? = null, settings: Boolean = false, content: @Composable () -> Unit) {
    val state = remember { MutableTransitionState(false) }
    state.targetState = expanded
    if (!state.currentState && !state.targetState) return
    val c = Hive.colors
    // Below its button, or ([above], the button's height) rising from it, for buttons at the screen's foot.
    val density = androidx.compose.ui.platform.LocalDensity.current
    val rise = above?.let { with(density) { (it + 8.dp).roundToPx() } }
    // The popup window is drawn larger than the menu by [room] on every side, so the shadow fades out
    // inside it instead of being cut off at the window's edge; the offsets keep the menu where it was.
    val room = 28.dp
    val roomPx = with(density) { room.roundToPx() }
    Popup(alignment = if (rise != null) Alignment.BottomEnd else Alignment.TopEnd, offset = IntOffset(roomPx, if (rise != null) -rise + roomPx else 8 - roomPx), onDismissRequest = onDismiss, properties = PopupProperties(focusable = true)) {
        Box(Modifier.pointerInput(Unit) { detectTapGestures { onDismiss() } }.padding(room)) {
        AnimatedVisibility(
            state,
            enter = fadeIn(tween(140)) + slideInVertically(tween(160)) { -it / 40 } + scaleIn(tween(160), initialScale = 0.985f),
            exit = fadeOut(tween(110)) + scaleOut(tween(110), targetScale = 0.985f),
        ) {
            Column(
                Modifier
                    .widthIn(min = 232.dp)
                    .width(IntrinsicSize.Max)
                    .shadow(22.dp, HiveShape.menu, ambientColor = c.accentGlow, spotColor = Color.Black)
                    .clip(HiveShape.menu)
                    .background(mix(c.accent, c.panelStrong.copy(alpha = 0.97f), 0.07f))
                    .border(1.dp, c.border, HiveShape.menu)
                    .padding(6.dp),
            ) {
                content()
                if (settings) {
                    val openSettings = LocalOpenSettings.current
                    HiveMenuDivider()
                    HiveMenuItem("Settings", Icons.Rounded.Settings) { onDismiss(); openSettings() }
                }
            }
        }
        }
    }
}

@Composable
fun HiveMenuItem(label: String, icon: ImageVector?, destructive: Boolean = false, onClick: () -> Unit) {
    val c = Hive.colors
    Row(
        Modifier.fillMaxWidth().height(46.dp).clip(RoundedCorner10).clickable(onClick = onClick).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) { Icon(icon, null, tint = if (destructive) Color(0xFFFF7A7A) else c.textDim, modifier = Modifier.size(18.dp)); Spacer(Modifier.width(12.dp)) }
        Text(label, style = HiveText.body, color = if (destructive) Color(0xFFFF7A7A) else c.text)
    }
}

private val RoundedCorner10 = RoundedCornerShape(10.dp)

@Composable
fun HiveMenuDivider() {
    Box(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp).height(1.dp).background(Hive.colors.border))
}
