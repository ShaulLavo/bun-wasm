# Goals preparation from local builds

Class **Host feature**, **original test adapter** in
`scripts/goals-matrix/prepare.ts` and `preparation.ts`. No upstream source is
copied or adapted, so there is no upstream path or revision.

`bun scripts/goals-matrix/prepare.ts dist --local-source=FULL_COMMIT`
prepares the playground from locally built guest files in the given directory.
The commit labels those guest builds. It must exist in the checkout's Git
repository. Shared program directories still use `SHARED_QUICKJS_PROGRAM`,
`SHARED_JSC_PROGRAM` and `SHARED_SPIDERMONKEY_PROGRAM`.

This path needs no CI delivery manifest. It keeps shell validation, complete
engine pairs, shared program checks, embedded build fingerprints and the
prepared site inventory. The existing delivery-directory command continues
to read its manifest and `web` assets.

The preparation regression test exercises local asset staging without a
delivery manifest and rejects abbreviated source labels.
