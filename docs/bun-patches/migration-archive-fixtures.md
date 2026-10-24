## Migration archive fixtures

Class **Host feature**. `tests/install/archives/abbrev-{1.0.4,1.1.0,1.1.1}.tgz`
are unchanged npm release archives from
`https://registry.npmjs.org/abbrev/-/abbrev-<version>.tgz`. Each is pinned by the
integrity recorded in Bun's
`test/cli/install/migration/npm-arborist/workspaces-conflicting-versions-virtual/package-lock.json`
at `5e0baa66516f3af00b008cdf1521c681317741e8`. The archives retain their upstream
license files. There are no local changes. Keeping these 6,434 bytes lets the
workspace conflict regression extract and import all three recorded packages
without contacting a public registry.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Migration archive fixtures](#migration-archive-fixtures) | Host feature | Unchanged abbrev archives verify the real npm workspace fixture and extraction against its recorded checksums. |
