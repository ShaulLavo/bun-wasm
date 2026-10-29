import { writeFileSync } from "node:fs";

const PAGE = 65536;

function environment(base: number, stackHigh: number, tableSize: number, id: number) {
  return `(module $env
    (import "group" "memory" (memory 2 4096 shared))
    (memory $ledger 1)
    (export "memory" (memory 0))
    (table (export "__indirect_function_table") ${id * 4 + tableSize} funcref)
    (global (export "__memory_base") i32 (i32.const ${base}))
    (global (export "__table_base") i32 (i32.const ${id * 4}))
    (global (export "__stack_pointer") (mut i32) (i32.const ${stackHigh}))
    (global $count (mut i32) (i32.const 0))
    (global $deny (mut i32) (i32.const 0))
    (func (export "deny") (param i32) local.get 0 global.set $deny)
    (func (export "group_grow") (param $pages i32) (result i32) (local $old i32)
      global.get $deny if i32.const -48 return end
      local.get $pages i32.const 1 i32.add memory.grow 0 local.tee $old
      i32.const -1 i32.eq if i32.const -48 return end
      global.get $count i32.const 3 i32.shl
      local.get $old i32.const 16 i32.shl i32.store $ledger
      global.get $count i32.const 3 i32.shl i32.const 4 i32.add
      local.get $old local.get $pages i32.add i32.const 16 i32.shl i32.store $ledger
      global.get $count i32.const 1 i32.add global.set $count
      local.get $old)
    (func (export "block") (param $addr i32) (param $size i32) (local $i i32)
      loop $scan
        local.get $i global.get $count i32.ge_u if unreachable end
        local.get $addr local.get $i i32.const 3 i32.shl i32.load $ledger i32.ge_u
        local.get $addr local.get $size i32.add
        local.get $i i32.const 3 i32.shl i32.const 4 i32.add i32.load $ledger i32.le_u
        i32.and if return end
        local.get $i i32.const 1 i32.add local.set $i br $scan
      end)
    (func (export "barrier") (param $addr i32)
      local.get $addr i32.const 1 i32.atomic.rmw.add drop
      local.get $addr i32.const 2 memory.atomic.notify drop
      loop $again
        local.get $addr i32.atomic.load i32.const 2 i32.eq if return end
        local.get $addr i32.const 1 i64.const 1000000 memory.atomic.wait32 drop
        br $again
      end)
    (func (export "signal") (param $addr i32)
      local.get $addr i32.const 1 i32.atomic.store
      local.get $addr i32.const 1 memory.atomic.notify drop)
    (func (export "ready") (param $addr i32) (local $attempt i32)
      loop $again
        local.get $addr i32.atomic.load i32.const 1 i32.eq if return end
        local.get $attempt i32.const 1 i32.add local.tee $attempt
        i32.const 5000 i32.ge_u if unreachable end
        local.get $addr i32.const 0 i64.const 1000000 memory.atomic.wait32 drop
        br $again
      end)
    (func (export "wake_waiter") (result i32) (local $attempt i32)
      loop $again
        i32.const 64 i32.const 1 memory.atomic.notify
        if i32.const 1 return end
        local.get $attempt i32.const 1 i32.add local.tee $attempt
        i32.const 5000 i32.ge_u if unreachable end
        i32.const 132 i32.const 0 i64.const 1000000 memory.atomic.wait32 drop
        br $again
      end
      unreachable)
    (func (export "delay_before_wait") (result i32)
      i32.const 132 i32.const 0 i64.const 250000000 memory.atomic.wait32)
  )`;
}

function member(bytes: string, id: number, base: number, dataPages: number, tableSize: number) {
  const stackHigh = base + (dataPages + 3) * PAGE;
  const body = `${environment(base, stackHigh, tableSize, id)}
    (register "runtime_shm" $env) (register "j2_probe" $env)
    (module $member binary "${bytes}")
    (invoke $member "__wasm_apply_data_relocs")
    (invoke $member "__wasm_call_ctors")
    (assert_return (invoke $member "member_init" (i32.const ${id})) (i32.const ${7 + id}))
    (assert_return (invoke $member "member_greeting_ok") (i32.const 1))
    (assert_return (invoke $member "member_call_op" (i32.const 7)) (i32.const ${id === 1 ? 14 : 21}))
    (assert_return (invoke $member "member_stack" (i32.const ${id})) (i32.const ${id * 64}))
    (invoke $env "deny" (i32.const 1))
    (assert_return (invoke $member "member_growth_failure") (i32.const 1))
    (invoke $env "deny" (i32.const 0))
    (invoke $env "barrier" (i32.const 256))
    (assert_return (invoke $member "member_churn" (i32.const ${id}) (i32.const 8)) (i32.const 0))
    (assert_return (invoke $member "member_churn" (i32.const ${id}) (i32.const 1)) (i32.const 0))
    (assert_return (invoke $member "member_counter") (i32.const ${7 + id}))
    (assert_return (invoke $member "member_call_op" (i32.const 7)) (i32.const ${id === 1 ? 14 : 21}))`;
  const wait = id === 1
    ? `(invoke $env "signal" (i32.const 128))
       (assert_return (invoke $env "delay_before_wait") (i32.const 2))
       (assert_return (invoke $member "member_wait32" (i32.const 64) (i32.const 0) (i64.const 5000000000)) (i32.const 0))
       (assert_return (invoke $member "member_load" (i32.const 64)) (i32.const 0))
       (invoke $env "signal" (i32.const 136))
       (invoke $env "ready" (i32.const 140))
       (assert_return (invoke $member "member_load" (i32.const 68)) (i32.const 1))
       (assert_return (invoke $member "member_wait32" (i32.const 68) (i32.const 0) (i64.const 0)) (i32.const 1))
       (assert_return (invoke $member "member_wait32" (i32.const 68) (i32.const 1) (i64.const 1000000)) (i32.const 2))`
    : `(invoke $env "ready" (i32.const 128))
       (assert_return (invoke $env "wake_waiter") (i32.const 1))
       (invoke $env "ready" (i32.const 136))
       (assert_return (invoke $member "member_add" (i32.const 68) (i32.const 1)) (i32.const 0))
       (invoke $env "signal" (i32.const 140))`;
  return `(thread $t${id} (shared (module $group))
    ${body}
    (invoke $env "barrier" (i32.const 320))
    ${wait}
  )`;
}

export function writeNativeProof(path: string, bytes: Uint8Array, info: { size: number; tableSize: number }) {
  const dataPages = Math.ceil(info.size / PAGE);
  const slotPages = dataPages + 4;
  const binary = Array.from(bytes, byte => `\\${byte.toString(16).padStart(2, "0")}`).join("");
  const source = `(module $group (memory (export "memory") ${2 + 2 * slotPages} 4096 shared))
    ${member(binary, 1, 2 * PAGE, dataPages, info.tableSize)}
    ${member(binary, 2, (2 + slotPages) * PAGE, dataPages, info.tableSize)}
    (wait $t1) (wait $t2)`;
  writeFileSync(path, source);
}
