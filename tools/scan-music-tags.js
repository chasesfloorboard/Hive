#!/usr/bin/env node
'use strict';

/**
 * Hive Music Tag Census
 *
 * Recursively scans a music folder and inventories every native metadata field
 * exposed by music-metadata. It intentionally does not write to music files.
 *
 * Usage:
 *   node tools/scan-music-tags.js [music-folder] [output-folder]
 *
 * Defaults:
 *   music-folder  = ~/Music
 *   output-folder = ./tag-scan-YYYYMMDD-HHMMSS
 *
 * The report measures several different notions of "how much" a tag exists:
 *   - files_with_tag       : number of files containing the field
 *   - occurrences          : number of native field instances
 *   - nonempty_values      : number of values after flattening arrays
 *   - unique_values        : distinct normalized values
 *   - value_frequency      : frequency of each distinct value
 *   - formats              : containers/extensions in which the field occurs
 *   - multi_value_files    : files where one native field contains multiple values
 *
 * It also marks likely custom/non-common fields by comparing native field names
 * against music-metadata's normalized common fields. This is a heuristic, not a
 * claim that every such field is truly custom.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.flac', '.m4a', '.m4b', '.mp4', '.aac', '.wav', '.aiff', '.aif',
  '.ogg', '.oga', '.opus', '.wma', '.asf', '.ape', '.wv', '.mp2', '.mpc',
  '.dsf', '.dff', '.mka', '.mkv', '.webm', '.spx'
]);

const DEFAULT_CONCURRENCY = Math.max(2, Math.min(12, Number(process.env.TAG_SCAN_WORKERS) || 8));

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function usage() {
  console.log(`Usage: node tools/scan-music-tags.js [music-folder] [output-folder]\n\n` +
    `Environment:\n` +
    `  TAG_SCAN_WORKERS=N   metadata parsing concurrency (default ${DEFAULT_CONCURRENCY})\n` +
    `  TAG_SCAN_MAX_FILES=N stop after N audio files (useful for testing)\n`);
}

function isAudio(file) {
  return AUDIO_EXTENSIONS.has(path.extname(file).toLowerCase());
}

async function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      console.warn(`WARN: cannot read ${dir}: ${err.message}`);
      continue;
    }
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && isAudio(full)) out.push(full);
    }
  }
  return out;
}

function flattenValues(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(flattenValues);
  return [value];
}

function normalizeValue(value) {
  if (value === undefined || value === null) return null;
  if (Buffer.isBuffer(value)) return `<Buffer ${value.length} bytes>`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (value.no !== undefined || value.of !== undefined) {
      return JSON.stringify({ no: value.no ?? null, of: value.of ?? null });
    }
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function normalizedKey(value) {
  return String(value)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function looksEmpty(value) {
  return value === '' || /^\s*$/.test(value);
}

function safeRelative(file, root) {
  return path.relative(root, file) || path.basename(file);
}

function addCount(map, key, amount = 1) {
  map[key] = (map[key] || 0) + amount;
}

function sortedEntries(obj, numeric = false) {
  return Object.entries(obj).sort((a, b) => numeric
    ? b[1] - a[1] || a[0].localeCompare(b[0])
    : a[0].localeCompare(b[0]));
}

async function main() {
  const arg = process.argv.slice(2);
  if (arg.includes('-h') || arg.includes('--help')) {
    usage();
    return;
  }

  const musicRoot = path.resolve(arg[0] || path.join(os.homedir(), 'Music'));
  const outputRoot = path.resolve(arg[1] || path.join(process.cwd(), `tag-scan-${timestamp()}`));
  const maxFiles = Number(process.env.TAG_SCAN_MAX_FILES || 0) || Infinity;

  if (!fs.existsSync(musicRoot)) {
    throw new Error(`Music folder does not exist: ${musicRoot}`);
  }

  const mm = await import('music-metadata');
  const files = (await walk(musicRoot)).slice(0, maxFiles);

  await fsp.mkdir(outputRoot, { recursive: true });

  const started = Date.now();
  const report = {
    generated_at: new Date().toISOString(),
    root: musicRoot,
    files_discovered: files.length,
    files_parsed: 0,
    files_failed: 0,
    tag_fields: {},
    common_field_presence: {},
    extension_counts: {},
    container_counts: {},
    failures: []
  };

  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= files.length) return;
      const file = files[index];
      try {
        const metadata = await mm.parseFile(file, { skipCovers: true });
        report.files_parsed++;

        const ext = path.extname(file).toLowerCase() || '<none>';
        addCount(report.extension_counts, ext);
        if (metadata.format?.container) addCount(report.container_counts, metadata.format.container);

        // Native is deliberately used here: the point of this tool is to expose
        // what is actually stored in files, not only normalized common tags.
        const native = metadata.native || {};
        const commonKeys = Object.keys(metadata.common || {});
        const commonNormalized = new Set(commonKeys.map(normalizedKey));

        for (const [tagType, nativeTags] of Object.entries(native)) {
          for (const item of nativeTags || []) {
            const key = item?.id ?? item?.key ?? item?.name ?? '<unknown>';
            const rawValue = item?.value;
            const values = flattenValues(rawValue);
            const field = String(key);
            const fieldKey = normalizedKey(field);

            if (!report.tag_fields[field]) {
              report.tag_fields[field] = {
                tag: field,
                tag_types: {},
                files_with_tag: 0,
                occurrences: 0,
                nonempty_values: 0,
                unique_values: 0,
                multi_value_files: 0,
                formats: {},
                extensions: {},
                values: {},
                sample_files: [],
                likely_custom: !commonNormalized.has(fieldKey)
              };
            }

            const stat = report.tag_fields[field];
            addCount(stat.tag_types, tagType);
            stat.occurrences++;
            addCount(stat.formats, metadata.format?.container || '<unknown>');
            addCount(stat.extensions, ext);
            if (!stat.sample_files.includes(safeRelative(file, musicRoot)) && stat.sample_files.length < 5) {
              stat.sample_files.push(safeRelative(file, musicRoot));
            }

            const nonempty = values
              .map(normalizeValue)
              .filter(v => v !== null && !looksEmpty(v));

            if (nonempty.length > 0) {
              stat.files_with_tag++;
              stat.nonempty_values += nonempty.length;
              if (nonempty.length > 1) stat.multi_value_files++;
              for (const value of nonempty) {
                addCount(stat.values, value);
              }
            }
          }
        }

        // Also inventory normalized common fields independently. This tells us
        // which concepts are broadly present even when native field spellings differ.
        for (const [key, value] of Object.entries(metadata.common || {})) {
          const values = flattenValues(value).map(normalizeValue).filter(v => v !== null && !looksEmpty(v));
          if (values.length) {
            if (!report.common_field_presence[key]) {
              report.common_field_presence[key] = { files: 0, values: 0, unique_values: 0, value_frequency: {} };
            }
            const stat = report.common_field_presence[key];
            stat.files++;
            stat.values += values.length;
            for (const v of values) addCount(stat.value_frequency, v);
          }
        }
      } catch (err) {
        report.files_failed++;
        if (report.failures.length < 500) {
          report.failures.push({ file: safeRelative(file, musicRoot), error: String(err?.message || err) });
        }
      }

      completed++;
      if (completed % 100 === 0 || completed === files.length) {
        process.stdout.write(`\rScanned ${completed}/${files.length} files...`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(DEFAULT_CONCURRENCY, Math.max(1, files.length)) }, worker));
  process.stdout.write('\n');

  // Finalize derived counts.
  for (const stat of Object.values(report.tag_fields)) {
    stat.unique_values = Object.keys(stat.values).length;
    stat.top_values = Object.entries(stat.values)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 50)
      .map(([value, count]) => ({ value, count }));
    delete stat.values;
  }
  for (const stat of Object.values(report.common_field_presence)) {
    stat.unique_values = Object.keys(stat.value_frequency).length;
    stat.top_values = Object.entries(stat.value_frequency)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 50)
      .map(([value, count]) => ({ value, count }));
    delete stat.value_frequency;
  }

  report.duration_seconds = Number(((Date.now() - started) / 1000).toFixed(2));
  report.tag_field_count = Object.keys(report.tag_fields).length;
  report.likely_custom_field_count = Object.values(report.tag_fields).filter(x => x.likely_custom).length;

  const jsonPath = path.join(outputRoot, 'tag-census.json');
  const csvPath = path.join(outputRoot, 'tag-census.tsv');
  const mdPath = path.join(outputRoot, 'tag-census.md');
  const failuresPath = path.join(outputRoot, 'failures.tsv');

  await fsp.writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n');

  const rows = [
    ['tag', 'likely_custom', 'files_with_tag', 'occurrences', 'nonempty_values', 'unique_values', 'multi_value_files', 'tag_types', 'formats', 'extensions']
  ];
  for (const stat of Object.values(report.tag_fields).sort((a, b) => b.files_with_tag - a.files_with_tag || a.tag.localeCompare(b.tag))) {
    rows.push([
      stat.tag,
      stat.likely_custom ? 'yes' : 'no',
      stat.files_with_tag,
      stat.occurrences,
      stat.nonempty_values,
      stat.unique_values,
      stat.multi_value_files,
      Object.keys(stat.tag_types).join(', '),
      Object.keys(stat.formats).join(', '),
      Object.keys(stat.extensions).join(', ')
    ]);
  }
  await fsp.writeFile(csvPath, rows.map(r => r.map(v => String(v).replace(/\t/g, ' ').replace(/\r?\n/g, ' ')).join('\t')).join('\n') + '\n');

  await fsp.writeFile(failuresPath,
    ['file', 'error'].concat(report.failures.map(x => `${x.file}\t${x.error.replace(/\r?\n/g, ' ')}`)).join('\n') + '\n'
  );

  const custom = Object.values(report.tag_fields)
    .filter(x => x.likely_custom)
    .sort((a, b) => b.files_with_tag - a.files_with_tag || a.tag.localeCompare(b.tag));

  const common = Object.entries(report.common_field_presence)
    .sort((a, b) => b[1].files - a[1].files || a[0].localeCompare(b[0]));

  const lines = [];
  lines.push('# Hive Music Tag Census');
  lines.push('');
  lines.push(`- Root: \`${musicRoot}\``);
  lines.push(`- Generated: ${report.generated_at}`);
  lines.push(`- Audio files discovered: **${report.files_discovered}**`);
  lines.push(`- Files parsed successfully: **${report.files_parsed}**`);
  lines.push(`- Files that failed to parse: **${report.files_failed}**`);
  lines.push(`- Native tag fields found: **${report.tag_field_count}**`);
  lines.push(`- Likely custom/non-common native fields: **${report.likely_custom_field_count}**`);
  lines.push(`- Scan time: **${report.duration_seconds}s**`);
  lines.push('');
  lines.push('## What can be counted?');
  lines.push('');
  lines.push('For every native tag field, this report keeps several different counts:');
  lines.push('');
  lines.push('1. **Files with tag** — how many files contain a non-empty instance of the field.');
  lines.push('2. **Occurrences** — how many native tag records expose that field.');
  lines.push('3. **Non-empty values** — values after flattening multi-value fields.');
  lines.push('4. **Unique values** — distinct normalized values found across the library.');
  lines.push('5. **Value frequency** — how often each individual value occurs.');
  lines.push('6. **Multi-value files** — files where one field contains more than one value.');
  lines.push('7. **Format spread** — which containers expose the field (MP3, FLAC, MP4, etc.).');
  lines.push('8. **Extension spread** — which file extensions contain it.');
  lines.push('9. **Common vs likely custom** — whether the native field name resembles a normalized common field.');
  lines.push('');
  lines.push('> "Likely custom" is intentionally a heuristic. Format-specific native names can be perfectly legitimate standard metadata.');
  lines.push('');
  lines.push('## Likely custom / unusual fields');
  lines.push('');
  lines.push('| Tag | Files | Unique values | Multi-value files | Formats |');
  lines.push('|---|---:|---:|---:|---|');
  for (const s of custom) {
    lines.push(`| ${s.tag.replace(/\|/g, '\\|')} | ${s.files_with_tag} | ${s.unique_values} | ${s.multi_value_files} | ${Object.keys(s.formats).join(', ')} |`);
  }
  if (!custom.length) lines.push('| None detected | | | | |');
  lines.push('');
  lines.push('## All native fields');
  lines.push('');
  lines.push('| Tag | Custom? | Files | Occurrences | Values | Unique | Multi-value |');
  lines.push('|---|:---:|---:|---:|---:|---:|---:|');
  for (const s of Object.values(report.tag_fields).sort((a, b) => b.files_with_tag - a.files_with_tag || a.tag.localeCompare(b.tag))) {
    lines.push(`| ${s.tag.replace(/\|/g, '\\|')} | ${s.likely_custom ? 'yes' : 'no'} | ${s.files_with_tag} | ${s.occurrences} | ${s.nonempty_values} | ${s.unique_values} | ${s.multi_value_files} |`);
  }
  lines.push('');
  lines.push('## Normalized common fields');
  lines.push('');
  lines.push('| Field | Files | Values | Unique values |');
  lines.push('|---|---:|---:|---:|');
  for (const [key, s] of common) {
    lines.push(`| ${key} | ${s.files} | ${s.values} | ${s.unique_values} |`);
  }
  lines.push('');
  lines.push('## Most common values by field');
  lines.push('');
  for (const [key, s] of common.slice(0, 40)) {
    lines.push(`### ${key}`);
    for (const v of s.top_values.slice(0, 20)) {
      lines.push(`- ${v.count} × ${JSON.stringify(v.value)}`);
    }
    lines.push('');
  }
  if (report.files_failed) {
    lines.push('## Parse failures');
    lines.push('');
    lines.push('See `failures.tsv` for the first ' + report.failures.length + ' failures.');
  }

  await fsp.writeFile(mdPath, lines.join('\n') + '\n');

  console.log(`Report written to: ${outputRoot}`);
  console.log(`  ${path.basename(mdPath)}`);
  console.log(`  ${path.basename(jsonPath)}`);
  console.log(`  ${path.basename(csvPath)}`);
  console.log(`  ${path.basename(failuresPath)}`);
}

main().catch(err => {
  console.error(`ERROR: ${err.message || err}`);
  process.exitCode = 1;
});
