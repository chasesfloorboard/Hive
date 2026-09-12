# Security policy

Report suspected vulnerabilities privately to the maintainer rather than placing
exploit details in public issues. Include the Hive version, Linux distribution,
reproduction steps, and whether an untrusted media file or artwork URL is involved.

Hive's security boundaries include a sandboxed/context-isolated renderer, denied
unexpected navigation/windows, constrained `mbfile` access to configured library
folders, HTTPS-only temporary artwork loading, and a preload-only privileged API.

Known dependency limitation: `dbus-next` has an unresolved advisory chain
(`usocket`/`xml2js` and legacy transitive packages) with no npm-provided fix as of
the RC. MPRIS is optional, isolated from playback, and should be disabled if a
distribution security policy cannot accept that dependency.
