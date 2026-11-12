(module
  (import "env" "memory" (memory 1 2 shared))
  (table (export "table") 1 externref))
