package com.local.hive.mobile.link

import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/**
 * Thousands of random phone/PC/ledger states through the planner, checking what must always hold:
 * nothing is deleted that's still on the other side, nothing is copied from a side that lacks it,
 * no file goes both ways, and paths the PC couldn't read are never touched.
 */
class MirrorPlannerPropertyTest {
    private val names = listOf("A/one.mp3", "A/two.flac", "B/three.m4a", "B/Four.mp3", "C/.Dot.mp3", "C/_Under.mp3", "D/x.ogg", "D/y.mp3", "E/z.wav", "Locked/q.mp3")

    @Test fun invariantsHoldForRandomStates() {
        val rnd = Random(20261106)
        repeat(5_000) { round ->
            val phone = HashMap<String, FileStat>(); val pc = HashMap<String, FileStat>(); val ledger = HashMap<String, Agreed>()
            for (n in names) {
                val size = 100L + rnd.nextInt(5) * 10
                val time = 1_000_000L + rnd.nextInt(4) * 10_000
                val onPc = rnd.nextInt(3) > 0; val onPhone = rnd.nextInt(3) > 0
                if (onPc) pc[n] = FileStat(size + if (rnd.nextBoolean()) 0 else 10, time + rnd.nextInt(2) * 50_000)
                if (onPhone) phone[MirrorPlanner.phonePath(n)] = FileStat(size, time)
                if (rnd.nextBoolean()) ledger[n] = Agreed(FileStat(size, time), FileStat(size, time))
            }
            val unreadable = if (rnd.nextInt(4) == 0) listOf("Locked") else emptyList()
            val p = MirrorPlanner.plan(phone, pc, ledger, emptySet(), unreadable)
            val pcKeys = pc.keys.map { it.lowercase() }.toSet()
            val phoneKeys = phone.keys.map { MirrorPlanner.pcPath(it, pcKeys).lowercase() }.toSet()
            val ctx = "round $round: phone=$phone pc=$pc ledger=$ledger plan=$p"
            for (x in p.toPhone) assertTrue("toPhone not on PC: $x $ctx", x.lowercase() in pcKeys)
            for (x in p.toPc) assertTrue("toPc not on phone: $x $ctx", x.lowercase() in phoneKeys || p.moves.values.any { it.equals(x, true) })
            for (x in p.goneFromPc) assertTrue("deleting on phone a file still on the PC: $x $ctx", x.lowercase() !in pcKeys)
            for (x in p.goneFromPhone) assertTrue("deleting on PC a file still on the phone: $x $ctx", x.lowercase() !in phoneKeys)
            for (x in p.goneFromPc + p.goneFromPhone) assertTrue("a deletion of something never agreed: $x $ctx", ledger.keys.any { it.equals(x, true) })
            assertTrue("both ways: $ctx", p.toPhone.map { it.lowercase() }.intersect(p.toPc.map { it.lowercase() }.toSet()).isEmpty())
            for (x in p.toPhone + p.toPc + p.goneFromPc + p.goneFromPhone + p.renames.keys + p.renames.values)
                assertTrue("touched an unreadable folder: $x $ctx", unreadable.none { u -> x.lowercase().startsWith(u.lowercase() + "/") })
            for ((old, new) in p.renames) {
                assertTrue("rename source not gone from PC: $old $ctx", old.lowercase() !in pcKeys)
                assertTrue("rename target not on PC: $new $ctx", new.lowercase() in pcKeys)
            }
        }
    }
}
