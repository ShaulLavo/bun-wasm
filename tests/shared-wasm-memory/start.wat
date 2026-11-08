(module
  (import "env" "memory" (memory 1 2 shared))
  (import "env" "observe" (func $observe))
  (func $start call $observe)
  (start $start))
