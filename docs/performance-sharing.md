# Compiled-plan sharing experiment

This diagnostic compares the default split profile using Waffle 0.0.122 with the same source and guest bytes prepared separately in each worker. It changes no shipping source. Run `scripts/performance/prepare-sharing.ts EMPTY_SCRATCH CANONICAL_DELIVERY SM_PAIR SM_RECEIPT` after the normal frozen root, web, and sandbox installs and `source env.sh`. Preparation uses the lifecycle adapter and goals producer. The generated control patch and guest fingerprints are retained in scratch.

The control keeps the original core and side link source in page metadata and clones it with each worker request. Workers prepare that source instead of adopting the shared compiled plan. Direct worker preparation intervals include validation, transformations and compilation. Source retention and cloning add allocation and transfer work. The experiment measures this complete strategy. Browser internal caching of identical bytes can still occur. Shared-group memory is a different feature and is rejected by this control.

Use fresh lifecycle output directories for each site and observation condition. Timing, external observations and profiles remain separate. Headless nonquiet PC results are experimental.
