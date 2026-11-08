(module
  (import "env" "memory" (memory 1 3 shared))
  (import "env" "observe" (func $observe))
  (func $start call $observe)
  (start $start))
