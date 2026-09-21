# Installer Spotify Permission Audit — Build 39

## Goal
Allow the installer to fix a root-owned `/opt/spotify` installation before Hive launches, but only after explicit user consent and without making Spotify world-writable.

## Behavior
1. Detects the actual Spotify installation and `Apps` directory.
2. If the current user cannot write there, checks for `sudo` and `setfacl`.
3. Shows the exact scope of the permission change and asks `[y/N]`.
4. On approval, runs:
   - `sudo setfacl -m u:$USER:rwx <spotify>`
   - `sudo setfacl -R -m u:$USER:rwX <spotify>/Apps`
5. Verifies normal-user write access before Spicetify apply.
6. On refusal/failure, skips Spicetify and continues installing/launching Hive.
7. Hive itself is never executed as root.

## Security rationale
`chmod a+wr` was intentionally not automated because it grants write access to all local users/processes. A per-user ACL is narrower and preserves the existing ownership model.

## Validation
- `bash -n install.sh`: required to pass before Build 39 distribution.
