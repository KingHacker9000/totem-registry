# Totem Registry

Discovery metadata and validation rules for Totem extensions and themes.

The registry is deliberately separate from the core. Totem must continue to support direct/local installation even if this registry is unavailable.

## Initial scope

Phase 0/early implementation keeps the registry simple:

- extension index metadata
- theme index metadata
- package/version compatibility fields
- publisher/source references
- checksums/signature metadata when the signing model is introduced
- schema validation tooling

A future hosted service may provide search, categories, screenshots, update metadata, and publisher verification, but that is not required for the first working Totem release.

## Security direction

Registry presence does not imply trust. Totem's local permission model remains authoritative, and installing a package must not auto-grant privileged capabilities.

## Non-goals for now

- package hosting
- mandatory cloud accounts
- forcing all extensions/themes through one store
- replacing direct GitHub/local development installs
