# Development

Use `npm ci --ignore-scripts` for the lockfile-pinned dependency graph. Do not run
`npm audit fix --force`. Review individual advisories and make narrow changes.

Use `npm start` for desktop work. `./run.sh --startup-debug` enables diagnostic
milestones without changing playback behavior. Logs belong under the Hive log
directory, never in the repository or music folders.
