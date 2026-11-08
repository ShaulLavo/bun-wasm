(module
  (import "env" "memory" (memory 1 2 shared))
  (import "env" "observe" (func $observe))
  ;; Recursion burns the Wasm stack; the callback then runs in core frames at the bottom.
  (func $deep (export "deep") (param i32) (result i32)
    local.get 0
    i32.eqz
    if
      call $observe
      i32.const 0
      return
    end
    local.get 0
    i32.const 1
    i32.sub
    call $deep
    i32.const 1
    i32.add))
