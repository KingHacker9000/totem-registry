# Registry package import surface

`@totem/registry` is intentionally private to the Totem repository family, but its runtime module boundary is explicit and consumer-checkable.

Supported package subpaths are:

- `@totem/registry/registry` — registry index, trust, artifact verification, install planning, and rollback primitives.
- `@totem/registry/node-protocol` — transport-neutral node descriptor and lifecycle protocol primitives.
- `@totem/registry/node-agent` — bounded HTTP node-agent server/client utilities.

No package-root export or unrestricted `src/*` deep import is supported. Consumers must use one of the declared subpaths so accidental internal files cannot become de facto API. The test suite exercises these package self-references and verifies undeclared deep paths fail with Node's package-export boundary.
