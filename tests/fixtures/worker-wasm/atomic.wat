(module
  (import "env" "memory" (memory 1 2 shared))
  (export "memory" (memory 0))
  (func (export "wait") (param $expected i32) (param $timeout i64) (result i32)
    i32.const 0
    local.get $expected
    local.get $timeout
    memory.atomic.wait32)
  (func (export "notify") (result i32)
    i32.const 0
    i32.const 1
    memory.atomic.notify)
  (func (export "wasi_thread_start") (param $tid i32) (param $arg i32)
    i32.const 12
    local.get $tid
    i32.atomic.store
    i32.const 16
    local.get $arg
    i32.atomic.store)
  (table (export "__indirect_function_table") 1 funcref)
  (global $heap (mut i32) (i32.const 1024))
  (func (export "malloc") (param $size i32) (result i32) (local $old i32)
    global.get $heap
    local.tee $old
    local.get $size
    i32.add
    i32.const 7
    i32.add
    i32.const -8
    i32.and
    global.set $heap
    local.get $old)
  (func (export "free") (param i32))
  (func (export "_initialize"))
  (func (export "napi_register_wasm_v1") (param i32 i32) (result i32) local.get 1))
