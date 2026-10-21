package com.local.hive.mobile.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * Hive's own playback icons, drawn from the desktop player bar's set
 * (app/renderer/icons.js) so the phone's buttons are the PC's: shuffle that
 * shows straight arrows when off and crossed ones when on, repeat off / all
 * / one, Hive's previous, next, play and pause. 24-unit viewBox like the
 * SVGs; tinted by the Icon that draws them.
 */
object HiveIcons {
    private fun icon(name: String, block: ImageVector.Builder.() -> Unit) =
        ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply(block).build()

    private fun ImageVector.Builder.fill(d: String) = addPath(addPathNodes(d), fill = SolidColor(Color.Black))

    // Hive's line icons: 1.7 stroke, round caps and joins.
    private fun ImageVector.Builder.line(d: String) = addPath(
        addPathNodes(d), fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = 1.7f,
        strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round,
    )

    val Previous = icon("HivePrevious") { fill("M4 6h2v12H4z"); fill("M20 6l-8 6 8 6z"); fill("M13 6l-8 6 8 6z") }
    val Next = icon("HiveNext") { fill("M18 6h2v12h-2z"); fill("M4 6l8 6-8 6z"); fill("M11 6l8 6-8 6z") }
    val Play = icon("HivePlay") { fill("M8 5v14l11-7z") }
    val Pause = icon("HivePause") { fill("M6.5 5h4v14h-4zM13.5 5h4v14h-4z") }

    val ShuffleOff = icon("HiveShuffleOff") {
        line("M4 7h14"); line("M15.5 4.5L18 7L15.5 9.5")
        line("M4 17h14"); line("M15.5 14.5L18 17L15.5 19.5")
    }
    val Shuffle = icon("HiveShuffle") {
        line("M4 7h3c2 0 2.9.8 4 2.3")
        line("M4 17h3c2 0 2.9-.8 4-2.3l3.6-5.4c1.1-1.5 2-2.3 4-2.3H20")
        line("M17.2 4.3L20.2 7L17.2 9.7")
        line("M13.3 14.7l.7 1c1.1 1.5 2 2.3 4 2.3H20")
        line("M17.2 14.3L20.2 17L17.2 19.7")
    }

    private fun ImageVector.Builder.loop() {
        line("M3.5 10.5V9a4 4 0 0 1 4-4H19"); line("M16 2L19 5L16 8")
        line("M20.5 13.5V15a4 4 0 0 1-4 4H5"); line("M8 22L5 19L8 16")
    }
    val RepeatOff = icon("HiveRepeatOff") { loop(); line("M4 4L20 20") }
    val RepeatAll = icon("HiveRepeatAll") { loop() }
    val RepeatOne = icon("HiveRepeatOne") { loop(); line("M12 9v6"); line("M10.5 10.5L12 9l1.5 1.5") }
}
