package com.local.hive.mobile.data

import org.jaudiotagger.audio.AudioFileIO
import org.jaudiotagger.tag.Tag
import org.jaudiotagger.tag.TagField
import org.jaudiotagger.tag.aiff.AiffTag
import org.jaudiotagger.tag.flac.FlacTag
import org.jaudiotagger.tag.id3.AbstractID3v2Frame
import org.jaudiotagger.tag.id3.AbstractID3v2Tag
import org.jaudiotagger.tag.id3.ID3v22Tag
import org.jaudiotagger.tag.id3.ID3v23Tag
import org.jaudiotagger.tag.id3.framebody.FrameBodyTXXX
import org.jaudiotagger.tag.mp4.Mp4Tag
import org.jaudiotagger.tag.mp4.field.Mp4TagReverseDnsField
import org.jaudiotagger.tag.vorbiscomment.VorbisCommentTag
import org.jaudiotagger.tag.vorbiscomment.VorbisCommentTagField
import org.jaudiotagger.tag.wav.WavTag
import java.io.File

/**
 * Love kept in the song file itself, as Hive on the PC (and MusicBee) keeps it:
 * a "LOVE RATING" tag of "L" (an ID3 TXXX frame, a Vorbis comment, or an MP4
 * freeform atom). A Love in the file outlives the app: a fresh install reads it
 * back. The same names are read as the PC's tag_helper.py reads them.
 */
object LoveTag {
    const val NAME = "LOVE RATING"
    private const val LOVED = "L"
    private const val MP4_ISSUER = "com.apple.iTunes"
    private val ALIASES = setOf("LOVE RATING", "LOVE", "LOVERATING", "MUSICBEE/LOVE RATING", "MUSICBEE/LOVERATING", "MUSICBEE LOVE RATING")

    private fun isAlias(name: String?) = name?.trim()?.uppercase() in ALIASES
    private fun isLoved(value: String?) = value?.trim()?.uppercase() == LOVED

    /** Whether [file]'s tags say it is Loved; null when the file can't be read. */
    fun readFile(file: File): Boolean? = runCatching { read(AudioFileIO.read(file).tag) }.getOrNull()

    fun read(tag: Tag?): Boolean = when (tag) {
        null -> false
        is WavTag -> tag.getID3Tag()?.let(::read) ?: false
        is AiffTag -> tag.getID3Tag()?.let(::read) ?: false
        is AbstractID3v2Tag -> txxx(tag).any { (desc, text) -> isAlias(desc) && isLoved(text) }
        is FlacTag -> vorbis(tag.vorbisCommentTag)
        is VorbisCommentTag -> vorbis(tag)
        is Mp4Tag -> tag.fields.asSequence().filterIsInstance<Mp4TagReverseDnsField>().any { isAlias(it.descriptor) && isLoved(it.content) }
        else -> false
    }

    /** Makes [tag] say Loved or not: Hive's own tag is set (or taken off) and any other spelling of it goes. */
    fun set(tag: Tag, loved: Boolean) {
        when (tag) {
            is WavTag -> set(tag.getID3Tag() ?: ID3v23Tag().also { tag.setID3Tag(it) }, loved)
            is AiffTag -> set(tag.getID3Tag() ?: ID3v23Tag().also { tag.setID3Tag(it) }, loved)
            is AbstractID3v2Tag -> {
                val id = if (tag is ID3v22Tag) "TXX" else "TXXX"
                val frames = runCatching { tag.getFields(id).orEmpty().toList() }.getOrDefault(emptyList())
                val keep = frames.filter { f -> !isAlias(((f as? AbstractID3v2Frame)?.body as? FrameBodyTXXX)?.description) }
                if (keep.size != frames.size) {
                    tag.deleteField(id)
                    keep.forEach { tag.addField(it) }
                }
                if (loved) tag.addField(tag.createFrame(id).apply { body = FrameBodyTXXX(0.toByte(), NAME, LOVED) })
            }
            is FlacTag -> setVorbis(tag.vorbisCommentTag, loved)
            is VorbisCommentTag -> setVorbis(tag, loved)
            is Mp4Tag -> {
                tag.fields.asSequence().filterIsInstance<Mp4TagReverseDnsField>().filter { isAlias(it.descriptor) }.map { it.id }.toSet().forEach { tag.deleteField(it) }
                if (loved) tag.addField(Mp4TagReverseDnsField("----:$MP4_ISSUER:$NAME", MP4_ISSUER, NAME, LOVED))
            }
            else -> throw java.io.IOException("Hive can't keep Love in this kind of file")
        }
    }

    private fun txxx(tag: AbstractID3v2Tag): List<Pair<String?, String?>> =
        listOf("TXXX", "TXX").flatMap { id -> runCatching { tag.getFields(id).orEmpty() }.getOrDefault(emptyList()) }.mapNotNull { f ->
            ((f as? AbstractID3v2Frame)?.body as? FrameBodyTXXX)?.let { it.description to it.firstTextValue }
        }

    private fun vorbis(tag: VorbisCommentTag?): Boolean =
        tag != null && tag.fields.asSequence().any { f: TagField -> isAlias(f.id) && isLoved((f as? VorbisCommentTagField)?.content) }

    private fun setVorbis(tag: VorbisCommentTag?, loved: Boolean) {
        tag ?: throw java.io.IOException("This file has no Vorbis comment")
        tag.fields.asSequence().map { it.id }.filter(::isAlias).toSet().forEach { tag.deleteField(it) }
        if (loved) tag.addField(VorbisCommentTagField(NAME, LOVED))
    }
}
