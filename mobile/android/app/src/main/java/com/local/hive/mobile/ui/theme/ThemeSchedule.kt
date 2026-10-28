package com.local.hive.mobile.ui.theme

import java.time.LocalDateTime
import java.time.LocalTime
import kotlin.random.Random

/**
 * Scheduled theme (Settings › Appearance), as on the PC: one theme by day and
 * another by night, switching at two times of day. Either may be "Random",
 * a different theme picked at each switch. Pure time and choice logic;
 * [ThemeStore] applies the result.
 */
data class ThemeSchedule(
    val enabled: Boolean = false,
    val dayStart: String = "06:00",
    val nightStart: String = "17:30",
    val dayTheme: String = ThemeStore.YOUR_THEME,
    val nightTheme: String = RANDOM,
) {
    enum class Period { Day, Night }

    /** Day or night at [now]. Day runs from dayStart up to nightStart, past midnight when dayStart is the later time. */
    fun periodAt(now: LocalTime): Period {
        val m = now.hour * 60 + now.minute
        val day = minutesOf(dayStart) ?: DEFAULT_DAY
        val night = minutesOf(nightStart) ?: DEFAULT_NIGHT
        if (day == night) return Period.Day
        val isDay = if (day < night) m in day until night else m >= day || m < night
        return if (isDay) Period.Day else Period.Night
    }

    /** When the period [now] is in began: each switch is its own (a Random theme is drawn once per switch). */
    fun lastSwitch(now: LocalDateTime): LocalDateTime {
        val day = minutesOf(dayStart) ?: DEFAULT_DAY
        val night = minutesOf(nightStart) ?: DEFAULT_NIGHT
        val start = if (periodAt(now.toLocalTime()) == Period.Day) day else night
        val at = now.toLocalDate().atTime(start / 60, start % 60)
        return if (at.isAfter(now)) at.minusDays(1) else at
    }

    /** The theme for [period]: by name, or a random one other than [current]. */
    fun themeFor(period: Period, packs: List<ThemePack>, current: String, random: Random = Random.Default): ThemePack? {
        val wanted = if (period == Period.Day) dayTheme else nightTheme
        if (wanted != RANDOM) return packs.firstOrNull { it.name == wanted }
        val others = packs.filter { it.name != current }.ifEmpty { packs }
        return if (others.isEmpty()) null else others[random.nextInt(others.size)]
    }

    companion object {
        /** A different theme at each switch. */
        const val RANDOM = "Random"
        private const val DEFAULT_DAY = 6 * 60
        private const val DEFAULT_NIGHT = 17 * 60 + 30

        /** "HH:MM" as minutes since midnight, or null. */
        fun minutesOf(hhmm: String): Int? {
            val m = Regex("""^(\d{1,2}):(\d{2})$""").matchEntire(hhmm.trim()) ?: return null
            val h = m.groupValues[1].toInt(); val min = m.groupValues[2].toInt()
            return if (h > 23 || min > 59) null else h * 60 + min
        }
    }
}
