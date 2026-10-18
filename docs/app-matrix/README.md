# Application compatibility matrix

The matrix measures real applications against the guest engines with offline dependency replay.

From the repository root:

```sh
source env.sh
scripts/app-matrix.sh --apps=express --engines=quickjs,jsc,browser --hosts=native
```

[Guide and reference](results.md).
