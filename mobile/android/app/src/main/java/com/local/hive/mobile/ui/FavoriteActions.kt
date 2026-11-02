package com.local.hive.mobile.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.FavoriteBorder
import androidx.compose.material.icons.rounded.Image
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.local.hive.mobile.data.FavoriteItem
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.hiveGlass

/**
 * A liked artist or playlist, for the heart on its page: [key] names it in Favorites, [route] opens it.
 * Playlists' keys are "playlist:" plus where they come from (user:12, smart:3, pc:…, apple:<url>, …).
 */
fun favoriteArtist(name: String) = FavoriteItem(FavoriteItem.artistKey(name), "artist", name, route = "artist/" + android.net.Uri.encode(name), addedAt = 0)
fun favoritePlaylist(source: String, title: String, route: String, artwork: String? = null, subtitle: String = "") =
    FavoriteItem("playlist:$source", "playlist", title, subtitle, artwork, route, addedAt = 0)

/**
 * The top bar's buttons for a playlist or artist page: a heart that likes it (it then shows on the
 * Favorites page). A playlist's own picture ([imageKey]) is what it's shown with there; choosing that
 * picture lives in the page's ⋯ menu ([PlaylistImageItems]), except with [imageButton] on a page that
 * has no ⋯ menu.
 */
@Composable
fun FavoriteBarActions(vm: MainViewModel, like: FavoriteItem?, imageKey: String? = null, imageButton: Boolean = false) {
    val c = Hive.colors
    val liked by vm.favoriteItemKeys.collectAsStateWithLifecycle()
    val images by vm.playlistImages.collectAsStateWithLifecycle()
    var menu by remember { mutableStateOf(false) }
    val pick = rememberPlaylistImagePicker(vm, imageKey)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        if (imageButton && imageKey != null) Box {
            Box(Modifier.size(42.dp).hiveGlass(CircleShape).clickable { menu = true }, contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.Image, "Playlist image", tint = c.text, modifier = Modifier.size(19.dp))
            }
            HiveMenu(menu, { menu = false }) { PlaylistImageItems(vm, imageKey, pick) { menu = false } }
        }
        if (like != null) {
            val on = like.key in liked
            // The picture it's shown with on the Favorites page: the user's image if there is one.
            val item = like.copy(artwork = imageKey?.let { images[it] } ?: like.artwork)
            Box(Modifier.size(42.dp).hiveGlass(CircleShape).clickable { vm.toggleFavorite(item) }, contentAlignment = Alignment.Center) {
                Icon(if (on) Icons.Rounded.Favorite else Icons.Rounded.FavoriteBorder, if (on) "Remove from Favorites" else "Add to Favorites", tint = if (on) c.accent else c.text, modifier = Modifier.size(20.dp))
            }
        }
    }
}

/** Opens the photo picker for a playlist's own picture; kept by the page, so it outlives the menu. */
@Composable
fun rememberPlaylistImagePicker(vm: MainViewModel, imageKey: String?): () -> Unit {
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri -> if (uri != null && imageKey != null) vm.setPlaylistImage(imageKey, uri) }
    return { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
}

/** A playlist's picture in its ⋯ menu: choose one, or change or remove the one it has. */
@Composable
fun PlaylistImageItems(vm: MainViewModel, imageKey: String, pick: () -> Unit, close: () -> Unit) {
    val images by vm.playlistImages.collectAsStateWithLifecycle()
    HiveMenuItem(if (imageKey in images) "Change image" else "Choose an image", Icons.Rounded.Image) { close(); pick() }
    if (imageKey in images) HiveMenuItem("Remove image", Icons.Rounded.Delete) { close(); vm.removePlaylistImage(imageKey) }
}
