# Delivery acceptance

| Requirement | Delivered | Evidence |
| --- | --- | --- |
| A dsh plugin | Cordis module, Config schema, dsh.bundle manifest and patch | real published Cordis/dsh pipeline tests |
| TVCache-style prefix caching on LayerFS | original qualified LayerCache service and Python client, immutable state refs and branching | core qualification and new dsh → HTTP → real Store/FUSE scenario |
| Session correctness | per-dsh-session labels, full histories, noncacheable continuation, failed/closed tombstones | ownership, incremental effects and dropped-response tests |
| Visible cache observations | canonical JSON output and persisted counts/ref metadata | dsh pipeline validates/renders values and metadata |
| Installation and publication | built tarball, source, fixed layerfs.json, bilingual quickstarts and community listing | profile install, artifact checks and upstream listing checker recorded in release delivery |

See [dsh-validation.md](dsh-validation.md) for the plugin receipts and
[validation.md](validation.md) for the inherited service qualification.
Community-directory appearance depends on the upstream maintainer merging the
listing PR. Publication does not claim GPU training, performance gains, macOS
support, LayerFS 2.0 support or power-loss durability.
