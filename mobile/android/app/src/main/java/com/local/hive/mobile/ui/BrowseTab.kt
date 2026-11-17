package com.local.hive.mobile.ui

import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.border
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.zIndex
import androidx.compose.foundation.combinedClickable
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import com.local.hive.mobile.ui.theme.HiveIcons
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.QueueMusic
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.ArrowDropDown
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Category
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.CloudDownload
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material.icons.rounded.Devices
import androidx.compose.material.icons.rounded.Explore
import androidx.compose.material.icons.rounded.FileOpen
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.Folder
import androidx.compose.material.icons.rounded.GraphicEq
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.NewReleases
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Podcasts
import androidx.compose.material.icons.rounded.Radio
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Shuffle
import androidx.compose.material.icons.rounded.Star
import androidx.compose.material.icons.rounded.TrendingUp
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.animation.togetherWith
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.data.StreamTrack
import com.local.hive.mobile.data.PlaylistEntry
import com.local.hive.mobile.data.PlaylistRow
import com.local.hive.mobile.data.AlbumSummary
import com.local.hive.mobile.data.ArtistSummary
import com.local.hive.mobile.data.NamedCount
import com.local.hive.mobile.data.Track
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveShape
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.theme.Motion
import com.local.hive.mobile.ui.theme.hiveGlass
import com.local.hive.mobile.ui.theme.mix
import kotlinx.coroutines.launch
import androidx.compose.material.icons.rounded.LibraryMusic
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.lazy.grid.items as gridItems
import androidx.compose.ui.layout.layout

/** The Home screen's Browse tab (streaming services, radio, podcasts, Hive on the PC),
  * lifted out of HomeScreen.kt. HomeScreen calls [BrowseTab]. */

// ---- Browse ----

/** Everything beyond the phone's own files: the streaming services, radio, podcasts and Hive on the PC. */
@Composable
internal fun BrowseTab(vm: MainViewModel, nav: HomeNavigation, bottom: Dp) {
    val link by vm.link.collectAsStateWithLifecycle()
    val tiles = buildList {
        // Apple Music / Spotify / Google Drive — present only in Hive Mobile (see browseStreamingTiles).
        addAll(browseStreamingTiles())
        add(Triple("Radio", "Stations worldwide", Icons.Rounded.Radio) to "radio")
        add(Triple("Podcasts", "Shows and episodes", Icons.Rounded.Podcasts) to "podcasts")
        if (link.paired) {
            add(Triple("PC library", "Every song on your PC", Icons.Rounded.Computer) to "pc")
            add(Triple("Playing on your PC", "Control it from here", Icons.Rounded.Devices) to "remote")
        }
        add(Triple("Yearly Wrap", "Your year in music", Icons.Rounded.AutoAwesome) to "wrap")
    }
    var drive by remember { mutableStateOf(false) }
    if (drive) DriveImportDialog(onDismiss = { drive = false })
    // Popular Spotify/Apple playlists (Hive Mobile only); empty in Hive Clean.
    val popular = rememberBrowsePopular()
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 10.dp, bottom = bottom + 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (popular.isNotEmpty()) {
            item { Text("Popular playlists", style = HiveText.year, color = Hive.colors.text, modifier = Modifier.padding(start = 2.dp, top = 4.dp)) }
            item {
                LazyRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    items(popular, key = { it.first.url }) { (card, route) ->
                        CoverCard(card.artwork.ifBlank { null }, card.name, card.subtitle, Modifier.width(136.dp), Icons.AutoMirrored.Rounded.QueueMusic, minTitleLines = 2) { nav.open(route) }
                    }
                }
            }
            item { Text("Explore", style = HiveText.year, color = Hive.colors.text, modifier = Modifier.padding(start = 2.dp, top = 8.dp)) }
        }
        items(tiles.chunked(2)) { pair ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                pair.forEach { (t, route) -> BrowseTile(t.first, t.second, t.third, Modifier.weight(1f)) { if (route == "drive") drive = true else nav.open(route) } }
                if (pair.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun BrowseTile(title: String, detail: String, icon: ImageVector, modifier: Modifier, onClick: () -> Unit) {
    val c = Hive.colors
    // The icon beside the name, the line under both: every box the same shape, whatever its words.
    Column(modifier.height(96.dp).pressable(onClick).hiveGlass(HiveShape.panel, strength = 0.1f).padding(horizontal = 14.dp, vertical = 14.dp), verticalArrangement = Arrangement.SpaceBetween) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(38.dp).clip(CircleShape).background(mix(c.accent, c.panelStrong, 0.22f)), contentAlignment = Alignment.Center) {
                Icon(icon, null, tint = c.accent, modifier = Modifier.size(20.dp))
            }
            Text(title, style = HiveText.cardTitle, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 10.dp).weight(1f))
        }
        Text(detail, style = HiveText.cardSub, color = c.textDim, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

