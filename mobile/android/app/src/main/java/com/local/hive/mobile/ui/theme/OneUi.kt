package com.local.hive.mobile.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Samsung Music's dark One UI look, taken from its own resources
 * (colors basics_d*, basics_dt*, basics_primary_dark; dimens mu_list_*) and
 * matched against screenshots of the app on a Galaxy A55.
 */
object OneUi {
    // Surfaces
    val Window = Color(0xFF010102)          // basics_system_background (d1)
    val Panel = Color(0xFF17171A)           // basics_d3: the rounded content panel
    val Raised = Color(0xFF2D2D30)          // basics_d4: list buttons, chips, menus
    val Placeholder = Color(0xFF47474A)     // basics_d6: art-less thumbnails
    val Divider = Color(0xFF3A3A3D)         // basics_list_divider (d5)

    // Text
    val Text1 = Color(0xFFFAFAFF)           // basics_dt1: titles
    val Text2 = Color(0xFFEAEAEB)           // basics_dt2
    val Text4 = Color(0xFFB7B7BB)           // basics_dt4: unselected tabs
    val TextSub = Color(0xFF99999E)         // basics_dt6: subtitles, counts
    val Primary = Color(0xFF598FFF)         // basics_primary_dark (night): playing song, selection

    // Shapes
    val PanelShape = RoundedCornerShape(topStart = 26.dp, topEnd = 26.dp)   // mu_list_radius
    val Thumb = RoundedCornerShape(11.dp)                                  // mu_list_thumbnail_radius_small
    val Cover = RoundedCornerShape(18.dp)                                  // mu_list_thumbnail_radius_mid
    val Hero = RoundedCornerShape(22.dp)                                   // mu_list_thumbnail_radius_big
    val Menu = RoundedCornerShape(26.dp)
    val Pill = RoundedCornerShape(percent = 50)

    // List geometry (mu_list_item_*)
    val Gutter = 18.dp
    val ThumbSize = 48.dp
    val ThumbGap = 16.dp
    val RowHeight = 62.dp
    val DividerInset = 82.dp

    // Type (mu_list_item_text1/2, sesl tab, appbar)
    val AppTitle = TextStyle(fontSize = 21.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.sp)
    val TabSelected = TextStyle(fontSize = 24.sp, fontWeight = FontWeight.Normal)
    val TabOther = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Normal)
    val Title = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Normal, lineHeight = 21.sp)
    val Sub = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Normal, lineHeight = 16.sp)
    val SortLabel = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
    val GridTitle = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Normal, lineHeight = 19.sp)
    val Number = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.Normal)
    val Duration = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Normal, fontFeatureSettings = "tnum")
    val Index = TextStyle(fontSize = 10.sp, fontWeight = FontWeight.Normal)
    val PageTitle = TextStyle(fontSize = 21.sp, fontWeight = FontWeight.SemiBold)
    val HeroTitle = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.Normal, lineHeight = 25.sp)
    val PlayerTitle = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.Normal, lineHeight = 27.sp)
    val PlayerArtist = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Normal)
    val MiniTitle = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold)
    val MiniArtist = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Normal)
    val MenuItem = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Normal)
}
