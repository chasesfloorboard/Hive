const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('native ID3 text frames stay native when edited through the tag helper', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-native-tags-'));
  const mp3 = path.join(tempDir, 'native-test.mp3');
  const script = String.raw`
import sys, json
from pathlib import Path
sys.path.insert(0, '..')
from mutagen.id3 import ID3
import tag_helper
p = Path(sys.argv[1])
ID3().save(p, v2_version=3, v1=0)
tag_helper.write_tags(str(p), {
  'TDRC': '2026',
  'TXXX:REPLAYGAIN_TRACK_GAIN': '-7.21 dB',
  'TXXX:CUSTOM_NATIVE': 'hello'
})
tag = ID3(p)
print(json.dumps({
  'frames': sorted(tag.keys()),
  'tdrc': [str(value) for value in tag['TDRC'].text],
  'txxx': sorted((frame.desc, [str(value) for value in frame.text]) for frame in tag.getall('TXXX'))
}))
`;
  try {
    const result = spawnSync('python3', ['-c', script, mp3], { cwd: path.resolve(__dirname, '..', 'resources', 'python'), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const out = JSON.parse(result.stdout.trim());
    assert.ok(out.frames.includes('TDRC'));
    assert.ok(out.frames.includes('TXXX:CUSTOM_NATIVE'));
    assert.ok(out.frames.includes('TXXX:REPLAYGAIN_TRACK_GAIN'));
    assert.deepEqual(out.tdrc, ['2026']);
    assert.ok(out.txxx.some(([desc, text]) => desc === 'REPLAYGAIN_TRACK_GAIN' && text[0] === '-7.21 dB'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
