# Hive AI Development Bootstrap

The detailed, persistent AI engineering instructions for Hive now live at:

`docs/ai/HIVE-ENDGAME-DEVELOPMENT-PROMPT.md`

Read that file before substantive development work.

The previous development notes are preserved unchanged at:

`docs/ai/AI-DEVELOPMENT-LEGACY.md`

The end-game prompt is the current source of AI development policy; the legacy file is retained as historical/reference context for regressions and old decisions.

### Build 160 notes
- Player Glass is Settings-only; individual surface controls map to actual bars/panels.
- The Electron frame is Hive-rendered so the title bar participates in theming.
- Audio Integrity scan checkpoints are durable and resumeable; closing Hive must not discard completed scan work.
