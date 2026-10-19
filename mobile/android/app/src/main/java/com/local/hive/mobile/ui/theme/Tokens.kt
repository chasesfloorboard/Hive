package com.local.hive.mobile.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/**
 * Hive Mobile's type scale. Few sizes, clear steps: a light display title,
 * tight headings, medium row titles, quiet secondary text and small spaced
 * capitals for section labels (Hive's "PLAYING TRACKS").
 */
object HiveType {
    val display = TextStyle(fontSize = 44.sp, fontWeight = FontWeight.ExtraLight, letterSpacing = (-0.03).em, lineHeight = 48.sp)
    val title = TextStyle(fontSize = 26.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.02).em, lineHeight = 31.sp)
    val headline = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.01).em, lineHeight = 25.sp)
    val bar = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.01).em)
    val body = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.em, lineHeight = 19.sp)
    val secondary = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Normal, lineHeight = 17.sp)
    val caption = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Normal, lineHeight = 15.sp)
    val label = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.12.em)
    val tab = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.01.em)
    /** Times and counts: figures that don't shift as they change. */
    val numbers = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Medium, fontFeatureSettings = "tnum")
}

/** An 8-point grid with two half steps. */
object Space {
    val xxs = 4.dp
    val xs = 8.dp
    val sm = 12.dp
    val md = 16.dp
    val lg = 20.dp
    val xl = 24.dp
    val xxl = 32.dp
    /** Side margin for every screen's content. */
    val gutter = 20.dp
}

/** One radius scale, so every curve belongs to the same family. */
object Radius {
    val art = RoundedCornerShape(10.dp)
    val card = RoundedCornerShape(18.dp)
    val cover = RoundedCornerShape(16.dp)
    val hero = RoundedCornerShape(24.dp)
    val sheet = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)
    val pill = RoundedCornerShape(percent = 50)
}
