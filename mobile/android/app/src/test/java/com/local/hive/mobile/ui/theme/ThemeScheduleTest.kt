package com.local.hive.mobile.ui.theme

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import java.time.LocalDateTime
import java.time.LocalTime
import kotlin.random.Random

class ThemeScheduleTest {
    private val s = ThemeSchedule(enabled = true, dayStart = "06:00", nightStart = "17:30", dayTheme = "Light", nightTheme = ThemeSchedule.RANDOM)
    private val packs = listOf("Light", "Dark", "Midnight", "Forest").map { ThemePack(it, "--bg: #000;") }

    @Test fun dayAndNightFollowTheTimesIncludingPastMidnight() {
        assertEquals(ThemeSchedule.Period.Day, s.periodAt(LocalTime.of(12, 0)))
        assertEquals(ThemeSchedule.Period.Night, s.periodAt(LocalTime.of(2, 0)))
        val late = s.copy(dayStart = "20:00", nightStart = "04:00")
        assertEquals(ThemeSchedule.Period.Day, late.periodAt(LocalTime.of(1, 0)))
        assertEquals(ThemeSchedule.Period.Night, late.periodAt(LocalTime.of(12, 0)))
    }

    @Test fun eachSwitchIsItsOwnPeriod() {
        assertEquals(LocalDateTime.of(2026, 10, 24, 17, 30), s.lastSwitch(LocalDateTime.of(2026, 10, 25, 2, 0)))
        assertEquals(LocalDateTime.of(2026, 10, 25, 17, 30), s.lastSwitch(LocalDateTime.of(2026, 10, 25, 23, 0)))
        assertEquals(LocalDateTime.of(2026, 10, 25, 6, 0), s.lastSwitch(LocalDateTime.of(2026, 10, 25, 6, 0)))
    }

    @Test fun aNamedThemeOrARandomOneOtherThanTheCurrent() {
        assertEquals("Light", s.themeFor(ThemeSchedule.Period.Day, packs, "Dark")?.name)
        repeat(20) { seed -> assertNotEquals("Dark", s.themeFor(ThemeSchedule.Period.Night, packs, "Dark", Random(seed))?.name) }
    }
}
