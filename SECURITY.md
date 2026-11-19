# Security and operational boundaries

This service is a tool-execution endpoint for trusted agent training workers.
The built-in shell can execute arbitrary code with the runtime's privileges.
The local directory backend offers no isolation. LayerFS Workspaces and Docker
containers do not make arbitrary tool code safe for untrusted multi-tenant use.

Default binding is loopback. Configure `LAYERCACHE_TOKEN` before exposing the
service; use a trusted network and a TLS/authentication gateway where needed.
There is no per-user authorization or tenant boundary within one service. Tools,
results, cache context and seed files must be treated as experiment data that may
contain private information. `/v1/tree` returns stored tool arguments and values.

Use a dedicated project/volume and execution identity. A Docker socket grants
control over its engine. The real-runtime test script only cleans up resources
with its own random prefix and Store volume. Review it before granting that access.

An owner lock left by a crash is intentionally not stolen. Verify that the owner
process is gone and no other host writes the index before removing it. A timeout
or transport error does not prove an operation did not happen. Inspect history
before manually replaying any operation with external effects.

If you discover a vulnerability after this repository is published, use the
repository hosting platform's private security advisory mechanism where available.
Do not include secrets or sensitive cache data in public issues.
