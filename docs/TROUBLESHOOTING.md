# Troubleshooting

If GStreamer is unavailable, install the GStreamer 1.0 development packages and a C
compiler, then restart Hive. If a scan stalls, use startup diagnostics and provide
the self-contained Hive log directory; do not delete music files or force a cache
reset before preserving diagnostics. Metadata failures should leave the prior cache
record eligible for retry.

On Linux, a GPU-process crash is recorded and Hive automatically enables software
rendering for the next launch. This is a per-installation recovery setting; systems
whose GPU path remains healthy continue using hardware acceleration. The GPU setting
in Hive can be used to re-enable acceleration after updating the graphics stack.

## In-app diagnostic reports

If Hive behaves unexpectedly and you do not have a terminal available, use **Settings → Logs → Start diagnostic session**. Reproduce the problem, then choose **Finish & save report**. The report is stored locally under Hive's `reports/diagnostics` directory and can be opened with **Open report folder**. Hive does not upload the report automatically; when support or development asks for it, attach the generated TXT report.

The session is useful for startup, library/scanning, Favorites, playback/scrubber, queue, volume, artwork, MPRIS, and performance problems.
