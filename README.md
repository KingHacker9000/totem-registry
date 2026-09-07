# Totem Registry

Discovery metadata, trust primitives, update/rollback planning, and remote-node protocol utilities for Totem.

The registry remains deliberately separate from core. Totem must continue to support direct/local installation when the registry is unavailable, and registry presence never implies that a package has permission to perform privileged actions.

## Implemented v0 surfaces

### Registry index

`src/registry.js` implements the `totem.registry/v0` index for extensions, themes, agent providers, and future node plugins. Every package version records an immutable HTTPS artifact source plus SHA-256 digest, compatibility metadata, and requested permissions.

The v0 registry boundary fails closed on ambiguous metadata rather than silently normalizing it:

- `generatedAt` is an RFC 3339 UTC timestamp using the canonical `Z` form;
- package sources are absolute HTTPS URLs without embedded credentials or fragments;
- package and compatibility objects contain only fields defined by the public v0 contract;
- requested and already-granted permission arrays contain unique, non-empty strings;
- validated package/index structures are copied and frozen before signing or install planning;
- rollback records are validated for package identity and version consistency before application.

The helper APIs deliberately separate **discovery** from **authorization**:

- `createRegistryIndex()` validates and deterministically orders metadata.
- `validateRegistryIndex()` applies the same semantic checks to externally supplied indexes.
- `signRegistryIndex()` revalidates metadata before signing the canonical index with Ed25519.
- `verifySignedRegistry()` accepts signatures only from explicitly configured trusted keys and rejects malformed signed index metadata.
- `verifyArtifact()` validates artifact bytes against a well-formed declared SHA-256 digest.
- `planInstall()` reports missing requested permissions and always returns `autoGrant: false`.
- `createRollbackRecord()` / `validateRollbackRecord()` / `applyRollback()` preserve and verify the package identity needed for deterministic rollback.

This repository does not host package bytes and does not grant Totem permissions. Core's local permission model remains authoritative.

### Remote nodes

`src/node-protocol.js` implements `totem.node/v0`, a transport-neutral protocol used to represent Windows, Linux, and macOS worker nodes without embedding any particular remote execution service into core.

A node descriptor contains platform/architecture, tags, online state, and an explicit capability set such as `shell`, `filesystem`, `browser`, or future device-specific capabilities. Utilities support:

- validated registration/update/heartbeat/offline envelopes;
- deterministic capability matching;
- deterministic workflow routing to an eligible online node;
- reducer semantics for durable node state.

The public node boundary fails closed on ambiguous state. `online` is strictly boolean, optional `lastSeenAt` and envelope `occurredAt` values must be UTC ISO-8601 timestamps, metadata/payload values must be plain JSON-safe structures without circular references or prototype-sensitive keys, and only the four documented lifecycle event types are accepted. Unsupported events cannot silently pass through reducer state.

The node-agent HTTP server applies explicit finite connection/request lifetime limits before capability dispatch: headers default to 5 seconds, full request receipt to 10 seconds, and idle keep-alive to 5 seconds. These values are configurable through validated positive `headersTimeoutMs`, `requestTimeoutMs`, and `keepAliveTimeoutMs` options; body ingestion and capability execution retain their separate deadlines. `closeNodeAgent()` also uses a validated positive shutdown deadline (5 seconds by default): normal in-flight work gets a graceful drain window, then any connections still preventing shutdown are force-closed so teardown cannot wait indefinitely. Repeated/concurrent close calls share the same shutdown operation.

The protocol is intentionally authorization-neutral: advertising `shell` does not itself authorize a workflow. Totem's caller policy and permission model must still approve use of that capability.

## Security model

Registry and node trust are separate concerns:

1. A registry signature proves only that configured publisher metadata has not changed.
2. An artifact checksum proves only that downloaded bytes match registry metadata.
3. Installation does not auto-grant package permissions.
4. A remote node's advertised capabilities do not authorize work by themselves.
5. Direct/local development installs remain supported and are not forced through a hosted service.

## Development

Requires Node 22.20+ and has no runtime dependencies.

```sh
npm install --ignore-scripts
npm run check
```

CI executes syntax checks and the Node test suite on Windows and Ubuntu under Node 22.20 and 24.18.

## Next integration work

The broader T711 lane will connect these primitives to Totem management APIs, build real Spotify/GitHub/system integration fixtures that pressure-test extension permissions, and add the transport/process layer for remote `totem-node` agents. Those pieces should consume these generic contracts rather than introducing service-specific behavior into core.
