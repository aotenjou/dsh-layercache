# Upstream provenance

| Project | Source identity | License | Use |
| --- | --- | --- | --- |
| [TVCache](https://github.com/TVCache/TVCache) | `3a4f95a6582eea1e4b7e84a9f3a0c74eaa8fde02` | Apache-2.0 in `tvcache/LICENSE` | tool-call graph, stateful-chain elision and fork-on-divergence design reference |
| [LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs) | `7d42d0b506eac64801864923149f796f5c7c8d7e`, version 1.1.0 | MIT | public SDK/runtime dependency |

Upstream references were inspected on 2026-11-18. Core implementation in this
repository is new code; neither upstream source tree, binary, model, dataset nor
logo is bundled in the release. No endorsement or affiliation is implied.

The Apache-2.0 license text is preserved from TVCache's `tvcache/LICENSE` (the
canonical Apache license). TVCache's training examples and third-party video
agent subtrees have separate dependencies/attributions and are not redistributed.

When distributing a LayerFS runtime alongside LayerCache, retain its
[MIT license and copyright notice](https://github.com/Ephemeral-AI-Lab/layerfs/blob/7d42d0b506eac64801864923149f796f5c7c8d7e/LICENSE)
and all relevant transitive dependency notices. LayerCache's npm optional peer
declaration does not bundle that runtime.

## DSH plugin

The Cordis plugin uses published `@deepseek-ai/cordis` 4.1.0, Schemastery
3.19.0 and dsh 0.2.2-rc.5 public APIs (MIT). The source reference inspected was
`deepseek-ai/deepseek-harness` at `2e39e70496aa02986ca6a820c5d497e816b69d7e`.
They are npm dependencies/peers, not copied source. The included LayerCache core
comes from the previously qualified independent LayerCache delivery at
`852e67a8586476a49ca8ceb8201bb0429d2a76c1`; its original notices are preserved.
The square DSH LayerCache logo is original geometric artwork, not an upstream logo.
