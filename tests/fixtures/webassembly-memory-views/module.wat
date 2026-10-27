;; Memory views shared between JavaScript and wasm, including growth during an import call.
(module
  (import "env" "observe" (func $observe (param i32) (result i32)))
  (memory (export "memory") 1 1100)
  (func (export "load") (param $at i32) (result i32) (i32.load8_u (local.get $at)))
  (func (export "store") (param $at i32) (param $value i32) (i32.store8 (local.get $at) (local.get $value)))
  (func (export "grow") (param $pages i32) (result i32) (memory.grow (local.get $pages)))
  ;; Store 5 at 0, ask JS (which writes 9 at 1), then return byte 1 plus JS's result.
  (func (export "roundTrip") (result i32)
    (i32.store8 (i32.const 0) (i32.const 5))
    (i32.add (call $observe (i32.const 0)) (i32.load8_u (i32.const 1))))
  ;; Grow by one page, then let JS observe the grown memory before returning.
  (func (export "growThenObserve") (result i32)
    (drop (memory.grow (i32.const 1)))
    (call $observe (i32.const 1)))
  ;; Many crossings: for each i, store i and ask JS to check it.
  (func (export "crossings") (param $count i32) (result i32)
    (local $i i32) (local $sum i32)
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
        (i32.store (i32.const 64) (local.get $i))
        (local.set $sum (i32.add (local.get $sum) (call $observe (i32.const 2))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $next)))
    (local.get $sum)))
