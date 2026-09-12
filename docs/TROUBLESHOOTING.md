# Troubleshooting

If GStreamer is unavailable, install the GStreamer 1.0 development packages and a C
compiler, then restart Hive. If a scan stalls, use startup diagnostics and provide
the self-contained Hive log directory; do not delete music files or force a cache
reset before preserving diagnostics. Metadata failures should leave the prior cache
record eligible for retry.
