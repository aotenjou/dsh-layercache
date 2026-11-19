# Contributing

Use Node 24.9+ and Python 3.10+. Run `npm ci --ignore-scripts` for the pinned
Cordis/dsh packages. The core service/client additionally uses the optional
LayerFS runtime. Keep the
directory reference backend separate from real LayerFS qualification.

Before proposing a change:

```sh
npm test
python -m unittest discover -s test -p test_python.py -v
npm run check
npm run demo
```

For changes to the LayerFS adapter or stored graph format, run real Store
qualification and the Docker/FUSE script from [the setup guide](docs/layerfs-setup.md).
Report unavailable prerequisites and skipped tests explicitly. Never call a
fake SDK a real filesystem qualification. Record source commits and image IDs.

Preserve these invariants: immutable snapshot references, task/context isolation,
read-only declarations, no publication of partial/failed results, one index owner,
and no automatic replay after uncertainty. Version schema changes explicitly.
Do not silently add dependency on an upstream internal API.

Use focused tests that demonstrate observable state and results, especially
diverging rollouts, reopen, concurrent misses and backend errors. Bump a tool's
version whenever implementation semantics change. Describe the problem, final
behavior and actual validation in pull requests. Contributions are provided under
the Apache-2.0 license in this repository.
