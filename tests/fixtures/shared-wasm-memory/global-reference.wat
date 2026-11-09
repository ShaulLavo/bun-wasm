(module
  (import "env" "memory" (memory 1 2 shared))
  (global (export "global") funcref (ref.null func)))
