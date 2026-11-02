"""A small library that exercises what a real one does to Hive: several formats,
Favorites, ratings and play counts in the tags, names in other scripts and with
emoji, a song named with a leading dot, nested folders, files that aren't music,
and a playlist. Usage: make-sample-library.py <pc library> <phone songs>
(the second: a couple of songs only the phone has, as a new phone might)."""
import os, subprocess, sys, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'resources'))
from mutagen.id3 import ID3, TIT2, TPE1, TALB, TRCK, TXXX, POPM
from mutagen.flac import FLAC
from mutagen.mp4 import MP4, MP4FreeForm


def tone(path, seconds, hz):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    codec = {'.mp3': ['-q:a', '6'], '.flac': [], '.m4a': ['-c:a', 'aac', '-b:a', '96k'], '.ogg': ['-c:a', 'libvorbis', '-q:a', '2']}[os.path.splitext(path)[1]]
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', f'sine=frequency={hz}:duration={seconds}', '-ac', '2', *codec, path], check=True)


def mp3(path, title, artist, album='', track=0, loved=False, stars=0, plays=0, seconds=35, hz=440):
    tone(path, seconds, hz)
    t = ID3()
    t.add(TIT2(encoding=3, text=title)); t.add(TPE1(encoding=3, text=artist))
    if album: t.add(TALB(encoding=3, text=album))
    if track: t.add(TRCK(encoding=3, text=str(track)))
    if loved: t.add(TXXX(encoding=3, desc='LOVE RATING', text='L'))
    if plays: t.add(TXXX(encoding=3, desc='P_COUNT', text=str(plays)))
    if stars: t.add(POPM(email='MusicBee', rating={1: 1, 2: 64, 3: 128, 4: 196, 5: 255}[stars], count=0))
    t.save(path, v2_version=3)


def flac(path, title, artist, album='', loved=False, plays=0, seconds=35, hz=550):
    tone(path, seconds, hz)
    f = FLAC(path)
    f['title'] = title; f['artist'] = artist
    if album: f['album'] = album
    if loved: f['LOVE RATING'] = 'L'
    if plays: f['P_COUNT'] = str(plays)
    f.save()


def m4a(path, title, artist, plays=0, loved=False, seconds=35, hz=660):
    tone(path, seconds, hz)
    m = MP4(path)
    m['\xa9nam'] = [title]; m['\xa9ART'] = [artist]
    if plays: m['----:com.apple.iTunes:P_COUNT'] = [MP4FreeForm(str(plays).encode())]
    if loved: m['----:com.apple.iTunes:LOVE RATING'] = [MP4FreeForm(b'L')]
    m.save()


def main(pc, phone):
    for d in (pc, phone):
        if os.path.isdir(d): shutil.rmtree(d)
    mp3(f'{pc}/Artist A/First Album/01 Opening.mp3', 'Opening', 'Artist A', 'First Album', 1, loved=True, stars=4, plays=7)
    mp3(f'{pc}/Artist A/First Album/02 Second.mp3', 'Second', 'Artist A', 'First Album', 2, stars=2, hz=470)
    flac(f'{pc}/Artist B/Lossless/01 Clear.flac', 'Clear', 'Artist B', 'Lossless', loved=True, plays=3)
    m4a(f'{pc}/Artist C/Apple Song.m4a', 'Apple Song', 'Artist C', plays=12, loved=True)
    mp3(f'{pc}/Молчат Дома - Волны.mp3', 'Волны', 'Молчат Дома', plays=2, hz=500)
    mp3(f'{pc}/Björk - Jóga ✨.mp3', 'Jóga ✨', 'Björk', loved=True, hz=520)
    flac(f'{pc}/.Dot Song.flac', '.Dot Song', 'Artist D', hz=580)
    tone(f'{pc}/Loose/untagged.ogg', 35, 600)
    os.makedirs(f'{pc}/Artist A/First Album', exist_ok=True)
    with open(f'{pc}/Artist A/First Album/cover notes.txt', 'w') as fh: fh.write('notes kept with the album\n')
    with open(f'{pc}/Mix.m3u', 'w') as fh: fh.write('#EXTM3U\nArtist A/First Album/01 Opening.mp3\nArtist B/Lossless/01 Clear.flac\n')
    # Songs only the phone has (downloaded there).
    mp3(f'{phone}/Phone Artist - Phone Song.mp3', 'Phone Song', 'Phone Artist', loved=True, plays=1, hz=700)
    flac(f'{phone}/Phone Artist - Second Phone Song.flac', 'Second Phone Song', 'Phone Artist', hz=720)
    mp3(f'{phone}/Phone Artist - Third.mp3', 'Third', 'Phone Artist', hz=740)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
