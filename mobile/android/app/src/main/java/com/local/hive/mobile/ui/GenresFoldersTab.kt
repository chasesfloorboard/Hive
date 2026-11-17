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

/** The Home screen's Genres and Folders tabs (and their shared panel header),
  * lifted out of HomeScreen.kt. */

// ---- Genres and Folders ----

@Composable
internal fun NamedTab(source: kotlinx.coroutines.flow.StateFlow<List<NamedCount>>, icon: ImageVector, empty: String, bottom: Dp, open: (String) -> Unit) {
    val items by source.collectAsStateWithLifecycle()
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = bottom + 12.dp)) {
        item { ListHeader(emptyList<Unit>(), null, { "" }, {}, countOf(items.size, if (icon == Icons.Rounded.Folder) "folder" else "genre")) }
        if (items.isEmpty()) item { EmptyState(empty, "") }
        items(items, key = { it.name }) { g ->
            val name = g.name.trimEnd('/').substringAfterLast('/').ifBlank { g.name.ifBlank { "Music" } }
            LibraryRow(null, icon, name, if (g.name.contains('/')) "${countOf(g.trackCount, "track")} · /${g.name}" else countOf(g.trackCount, "track")) { open(g.name) }
        }
    }
}

/** Genres as squares of their own album covers: four of the genre's most played albums, or its one cover. */
@Composable
internal fun GenresTab(vm: MainViewModel, bottom: Dp, open: (String) -> Unit) {
    val c = Hive.colors
    val genres by vm.genres.collectAsStateWithLifecycle()
    val covers by vm.genreCovers.collectAsStateWithLifecycle()
    androidx.compose.foundation.lazy.grid.LazyVerticalGrid(
        androidx.compose.foundation.lazy.grid.GridCells.Fixed(2),
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 6.dp, bottom = bottom + 12.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item(span = { androidx.compose.foundation.lazy.grid.GridItemSpan(2) }) {
            Text(countOf(genres.size, "genre"), style = HiveText.small, color = c.textDim, modifier = Modifier.padding(start = 4.dp, top = 6.dp))
        }
        if (genres.isEmpty()) item(span = { androidx.compose.foundation.lazy.grid.GridItemSpan(2) }) { EmptyState("No genres yet", "") }
        gridItems(genres, key = { it.name.lowercase() }) { g ->
            val pictures = covers[g.name.lowercase()].orEmpty()
            // A mosaic needs four; with fewer albums, the genre's top album fills the square.
            FavoriteSquare(g.name, if (pictures.size >= 4) pictures else pictures.take(1), round = false, icon = Icons.Rounded.Category, subtitle = countOf(g.trackCount, "track")) { open(g.name) }
        }
    }
}

/** The view header used by pages that keep a title in the list. */
@Composable
internal fun PanelHeader(title: String, controls: @Composable () -> Unit = {}) {
    Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 12.dp, top = 16.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = HiveText.viewTitle, color = Hive.colors.text, modifier = Modifier.weight(1f))
        controls()
    }
}
