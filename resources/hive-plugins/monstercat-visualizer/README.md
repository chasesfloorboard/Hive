# Monstercat Visualizer

Adds a **Visualizer** page to Hive's left sidebar: Monstercat-style spectrum
bars, the playing track's cover art, the artist name and the track title, drawn
in Hive's current theme.

- The bars come from Hive's own GStreamer playback (64 log-spaced bands,
  20 Hz – 16 kHz), shown in time with what you hear.
- Settings: number of bars, sensitivity, fall time, Monstercat smoothing,
  bars in Hive's accent color or its text color.

## Credits

The look and default values (63 bars, 20 Hz – 16 kHz, 35 dB sensitivity, the
18:7 bar-to-gap ratio, bold artist over light title) follow
[marcopixel/monstercat-visualizer](https://github.com/marcopixel/monstercat-visualizer),
a Rainmeter skin. This plugin is a new implementation for Hive and contains no
code from it. That project's license:

```
MIT License

Copyright (c) 2017 Marco Vockner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
