# Release process

1. Run `npm ci --ignore-scripts`, `npm test`, `npm run check`, and `git diff --check`.
2. Review `npm audit` individually; do not use forced remediation.
3. Build with `npm run build:linux` and test the generated AppImage and deb on a
   clean machine.
4. Perform the manual playback and metadata matrix in `docs/TESTING.md`.
5. Verify no user data, logs, caches, build output, or `node_modules` is committed.
6. Only then change an RC to a stable version and update the changelog.
