# Next metadata continuation regression

Class **Host feature**. This regression fixture checks the host continuation contract. `web/tests/fixtures/next-metadata-source.ts` contains four unchanged function sources from Next.js 15.5.6, MIT licensed, copyright Vercel, Inc. They were extracted from the captured development Webpack emission of that release. No production source imports this fixture.

| Upstream path under `packages/next/src` | Function | Class | SHA-256 of captured function |
| --- | --- | --- | --- |
| `lib/metadata/resolve-metadata.ts` | `resolveMetadataItemsImpl` | Host feature | `88c4906f565522456ef120151a66f2a97dd40b1e3c51ac8b0382f9a25bfe34c8` |
| `lib/metadata/resolve-metadata.ts` | `collectMetadata` | Host feature | `6ed25c6323c9116128f800fa00e62bbe6424bfabe928d8242f41f971654e0c1e` |
| `server/lib/app-dir-module.ts` | `getLayoutOrPageModule` | Host feature | `666350fcb3ea0a4e92c8e50634960b6bb1023538ddff0bfab6730130b1256e7f` |
| `server/request/params.ts` | `createServerParamsForServerSegment` | Host feature | `b321ef39804c1c1844715a41e98e69536af4bfe9df030f3adf63cd5fea29713d` |

The upstream revision is tag `v15.5.6`. The captured vendor chunk has SHA-256 `3ff9d4b5a90c18df67fa235dcb3756e7ad971ff6a41ca3feedce629f2e52c16c`. The test asserts every function hash before evaluating these strings as raw JavaScript. It performs no await lowering or eval rewriting.

`native-async-context.ts` is an original test adapter. It supplies fulfilled layout and page loaders, static metadata results, the runtime's actual storage factory, and a request-only params helper. Its missing-store helper reproduces the E696 error name, message and code. It does not exercise prerender or cache paths, React rendering, or an HTTP request.

The two-segment tree requires a store in the recursive page call after the layout's raw await. The one-segment tree resolves even when that store is lost. Both cases also check the outside frame. This distinguishes the missing continuation from an unconditional reader failure.
