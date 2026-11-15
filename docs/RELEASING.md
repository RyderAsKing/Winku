# Releasing

1. Set the new version in `app/src-tauri/tauri.conf.json`, `app/src-tauri/Cargo.toml`, `app/package.json` and `engine/package.json`.
2. Merge that to `main`, then tag it and push the tag: `git tag v0.1.0 && git push origin v0.1.0`.
3. The Release workflow builds the installer, signs the update, and publishes the GitHub Release with `latest.json`. Installed copies pick it up within six hours.

The update signing key's private half is the `TAURI_SIGNING_PRIVATE_KEY` secret, with `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Keep a backup somewhere safe. If it's lost, installed copies can't verify new updates and everyone has to reinstall by hand.
