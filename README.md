# Totem Registry

Discovery metadata, trust primitives, update/rollback planning, and remote-node protocol utilities for Totem.

The registry remains deliberately separate from core. Totem must continue to support direct/local installation when the registry is unavailable, and registry presence never implies that a package has permission to perform privileged actions.

## Implemented v0 surfaces

### Registry index

`src/registry.js` implements the `totem.registry/v0` index for extensions, themes, agent providers, and future node plugins. Every package version records an immutable artifact source plus SHA-256 digest, compatibility metadata, and requested permissions.

The helper APIs deliberately separate **discovery** from **authorization**:

- `createRegistryIndex()` validates and deterministically orders metadata.
- `signRegistryIndex()` signs the canonical index with Ed25519.
- `verifySignedRegistry()` accepts signatures only from explicitly configured trusted keys.
- `verifyArtifact()` validates artifact bytes against their declared SHA-256 digest.
- `planInstall()` reports missing requested permissions and always returns `autoGrant: false`.
- `createRollbackRecord()` / `applyRollback()` preserve the exact previous package metadata needed for deterministic rollback.

This repository does not host package bytes and does not grant Totem permissions. Core's local permission model remains authoritative.

### Remote nodes

`src/node-protocol.js` implements `totem.node/v0`, a transport-neutral protocol used to represent Windows, Linux, and macOS worker nodes without embedding any particular remote execution service into core.

A node descriptor contains platform/architecture, tags, online state, and an explicit capability set such as `shell`, `filesystem`, `browser`, or future device-specific capabilities. Utilities support:

- validated registration/update/heartbeat/offline envelopes;
- deterministic capability matching;
- deterministic workflow routing to an eligible online node;
- reducer semantics for durable node state.

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
