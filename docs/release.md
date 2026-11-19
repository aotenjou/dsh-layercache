# Release procedure

The canonical plugin repository is
[https://github.com/aotenjou/dsh-layercache](https://github.com/aotenjou/dsh-layercache).
Distribute the plugin through pinned GitHub releases and submit its separate
four-file listing to the LayerFS community directory. npm/PyPI publication is
optional and requires package-name ownership; no npm registry release is implied.

1. Review [dsh-validation.md](dsh-validation.md) and the core validation record.
   Pin the tested LayerFS commit in `layerfs.json`. Update versions and changelog.
2. Run `npm ci --ignore-scripts`, `npm test`, `npm run check`, and the Python
   integration suite. For adapter changes qualify the real Store/FUSE path; for
   dsh changes run `test-layerfs-docker.py --dsh` with the fixed SDK/daemon/image.
3. Commit the final source and tag `v0.1.0`. Build a source archive with `git archive`
   and `npm pack --pack-destination ..`. The npm tarball contains ready-to-load
   JavaScript, the Cordis patch, docs, verification scripts and notices, not
   node_modules, Stores, credentials or native LayerFS binaries. No build hook
   runs on users' machines. The Python wheel remains the independent service client.
4. Install the exact tarball using `dsh plugin --profile web add /path/to/package.tgz`
   in a dedicated `DSH_HOME`, then check `dsh --profile web --dump-config`. Exercise
   the installed plugin through the actual tools pipeline against a service.
5. Push source/tag and create a GitHub release with the source archive, plugin
   tarball, Python wheel and SHA-256 checksums. Do not rewrite existing tags.
6. Generate the listing under `plugins/dsh-layercache/` in a fork of LayerFS:
   `plugin.json`, display `README.md`, `install.md`, and this project's own square
   `logo.svg`. Pin the pushed plugin SHA and tested LayerFS SHA. Run the upstream
   `plugin_check.py --online` and fix every reported problem. Submit a PR titled
   `Add plugin: DSH LayerCache`. The public site updates only after maintainers
   merge that PR and rebuild it; submitting the PR does not imply listing approval.

GitHub workflows report portable and manually dispatched real integration checks.
Local receipts identify executed tests separately from hosted workflow outcomes.
