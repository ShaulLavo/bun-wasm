//! The signed 2 GiB endpoint of a Bun group through the production adapters
//! (docs/memory-ceiling.md, stage 2): the Bun group policy, the member carve, core
//! instantiation, the preview1 view, `GuestMemory::Shared` and the `runtime_shm` imports.
//!
//! The group is filled exactly: page zero, stock Rolldown's reservation
//! (`{ initial: 16384, maximum: 65536, shared: true }`), and a member whose stack is the last
//! chunk. The last valid byte is `0x7fffffff`. The stack top is the one-past-end address
//! `0x80000000`, which is `i32::MIN` in the globals a member reads.
use super::*;
use crate::guest::GuestMemory;
use crate::shm::nested::NestedMemory;
use wasm_encoder::{
    CodeSection, CustomSection, EntityType, ExportKind, ExportSection, Function, FunctionSection,
    GlobalType as EncodedGlobal, ImportSection, Instruction, MemArg, MemoryType,
    TableType as EncodedTable, TypeSection, ValType as EncodedValue,
};
use wasmtime::{Config, Engine, TypedFunc};
use wasmtime_wasi::WasiCtxBuilder;
use wasmtime_wasi::p1::{self, WasiP1Ctx};
use wasmtime_wasi::p2::pipe::{MemoryInputPipe, MemoryOutputPipe};

const END: u32 = 0x8000_0000;
const LAST_PAGE: u32 = END - PAGE;
const NOMEM: i32 = -48;
const INVAL: i32 = -28;
const WASI: &str = "wasi_snapshot_preview1";

fn word(offset: u64) -> MemArg {
    MemArg {
        offset,
        align: 2,
        memory_index: 0,
    }
}

fn byte() -> MemArg {
    MemArg {
        offset: 0,
        align: 0,
        memory_index: 0,
    }
}

/// A PIE core with the admitted shape. Its exports take addresses, so the test places every
/// string, iovec and result cell itself: `sp`, `push`, `load`, `store`, `load8`, `store8`,
/// and `write`/`read` forwarding to preview1 `fd_write`/`fd_read`.
fn boundary_core() -> Vec<u8> {
    let i32s = |count: usize| vec![EncodedValue::I32; count];
    let mut types = TypeSection::new();
    types.ty().function([], []);
    types.ty().function([], i32s(1));
    types.ty().function(i32s(1), i32s(1));
    types.ty().function(i32s(2), []);
    types.ty().function(i32s(4), i32s(1));
    let global = |mutable| {
        EntityType::Global(EncodedGlobal {
            val_type: EncodedValue::I32,
            mutable,
            shared: false,
        })
    };
    let mut imports = ImportSection::new();
    imports.import(
        "env",
        "memory",
        MemoryType {
            minimum: 1,
            maximum: Some(MAX_PAGES),
            memory64: false,
            shared: true,
            page_size_log2: None,
        },
    );
    imports.import("env", "__stack_pointer", global(true));
    imports.import("env", "__memory_base", global(false));
    imports.import("env", "__table_base", global(false));
    imports.import(
        "env",
        "__indirect_function_table",
        EncodedTable {
            element_type: wasm_encoder::RefType::FUNCREF,
            table64: false,
            minimum: 1,
            maximum: None,
            shared: false,
        },
    );
    imports.import(WASI, "fd_write", EntityType::Function(4));
    imports.import(WASI, "fd_read", EntityType::Function(4));
    let forward = |import: u32| {
        let mut body: Vec<Instruction<'static>> = (0..4).map(Instruction::LocalGet).collect();
        body.push(Instruction::Call(import));
        body
    };
    let push = vec![
        Instruction::GlobalGet(0),
        Instruction::I32Const(4),
        Instruction::I32Sub,
        Instruction::GlobalSet(0),
        Instruction::GlobalGet(0),
        Instruction::LocalGet(0),
        Instruction::I32Store(word(0)),
        Instruction::GlobalGet(0),
    ];
    let load = |instruction| vec![Instruction::LocalGet(0), instruction];
    let store = |instruction| {
        vec![
            Instruction::LocalGet(0),
            Instruction::LocalGet(1),
            instruction,
        ]
    };
    // Function indices follow the two imported functions.
    let bodies: Vec<(&str, u32, Vec<Instruction<'static>>)> = vec![
        ("core_initialize_memory", 0, Vec::new()),
        ("__wasm_apply_data_relocs", 0, Vec::new()),
        ("__wasm_call_ctors", 0, Vec::new()),
        ("_start", 0, Vec::new()),
        ("sp", 1, vec![Instruction::GlobalGet(0)]),
        ("push", 2, push),
        ("load", 2, load(Instruction::I32Load(word(0)))),
        ("load8", 2, load(Instruction::I32Load8U(byte()))),
        ("store", 3, store(Instruction::I32Store(word(0)))),
        ("store8", 3, store(Instruction::I32Store8(byte()))),
        ("write", 4, forward(0)),
        ("read", 4, forward(1)),
    ];
    let mut functions = FunctionSection::new();
    let mut exports = ExportSection::new();
    let mut code = CodeSection::new();
    for (index, (name, ty, body)) in bodies.iter().enumerate() {
        functions.function(*ty);
        exports.export(name, ExportKind::Func, 2 + index as u32);
        let mut function = Function::new([]);
        for instruction in body {
            function.instruction(instruction);
        }
        function.instruction(&Instruction::End);
        code.function(&function);
    }
    let mut module = wasm_encoder::Module::new();
    // memory-info: size 8, alignment 2^2, table size 0, alignment 0.
    module.section(&CustomSection {
        name: "dylink.0".into(),
        data: [1, 4, 8, 2, 0, 0].as_slice().into(),
    });
    module
        .section(&types)
        .section(&imports)
        .section(&functions)
        .section(&exports)
        .section(&code);
    module.finish()
}

fn layout() -> MemInfo {
    MemInfo {
        memory_size: 8,
        memory_alignment: 2,
        table_size: 0,
        table_alignment: 0,
    }
}

fn engine() -> Engine {
    let mut config = Config::new();
    config.wasm_threads(true);
    Engine::new(&config).unwrap()
}

/// One member at the top of a full Bun group, as `Programs::instantiate` builds it.
struct Top {
    store: Store<WasiP1Ctx>,
    instance: Instance,
    memory: GuestMemory,
    stdout: MemoryOutputPipe,
}

impl Top {
    fn function<P, R>(&mut self, name: &str) -> TypedFunc<P, R>
    where
        P: wasmtime::WasmParams,
        R: wasmtime::WasmResults,
    {
        self.instance
            .get_typed_func(&mut self.store, name)
            .unwrap()
    }

    fn store(&mut self, at: u32, value: u32) {
        self.function::<(i32, i32), ()>("store")
            .call(&mut self.store, (at as i32, value as i32))
            .unwrap();
    }

    fn load(&mut self, at: u32) -> u32 {
        self.function::<i32, i32>("load")
            .call(&mut self.store, at as i32)
            .unwrap() as u32
    }

    fn bytes(&self, at: u32, length: u32) -> Vec<u8> {
        let range = at as usize..at as usize + length as usize;
        self.memory.read(&self.store, range).unwrap()
    }

    /// Place one iovec at `iovec`, then call preview1 with its result cell at `result`. The
    /// errno is `Ok`; Wasmtime's preview1 traps on a pointer it cannot dereference.
    fn io(&mut self, name: &str, iovec: u32, span: (u32, u32), result: u32) -> Result<i32> {
        self.store(iovec, span.0);
        self.store(iovec + 4, span.1);
        self.io_at(name, iovec, result)
    }

    fn io_at(&mut self, name: &str, iovec: u32, result: u32) -> Result<i32> {
        let fd = i32::from(name == "write");
        self.function::<(i32, i32, i32, i32), i32>(name)
            .call(&mut self.store, (fd, iovec as i32, 1, result as i32))
    }
}

/// What a refusal at the full group must leave untouched.
fn accounting(group: &MemoryGroup, budget: &GroupBackingBudget) -> (shm::GroupSnapshot, u64) {
    (group.snapshot(), budget.committed_bytes())
}

/// Fill the Bun group exactly, with the member's stack as its last chunk, and instantiate the
/// boundary core there through the production carve, preview1 view and core instantiation.
///
/// # Safety
///
/// `backing` outlives the returned Store: the caller declares it first.
unsafe fn top_member(
    engine: &Engine,
    lease: &MemberLease,
    backing: &SharedMemoryLease,
    stdin: &'static str,
) -> (Top, Placement) {
    let bytes = boundary_core();
    assert_eq!(admit(&bytes, true).unwrap(), Profile::SharedGroup);
    let module = Module::new(engine, &bytes).unwrap();
    let stdout = MemoryOutputPipe::new(4096);
    let wasi = WasiCtxBuilder::new()
        .stdin(MemoryInputPipe::new(stdin))
        .stdout(stdout.clone())
        .build_p1();
    let mut store: Store<WasiP1Ctx> = Store::new(engine, wasi);
    let mut linker = Linker::new(engine);
    p1::add_to_linker_sync(&mut linker, |cx| cx).unwrap();
    let core = CoreLayout::read(engine, &bytes, &module, &module).unwrap();
    let placement = carve(lease, &core.layout).unwrap();
    // SAFETY: forwarded to the caller's contract above.
    unsafe { core.preview1.bind(&mut store, &mut linker, backing) }.unwrap();
    // SAFETY: as above.
    let (instance, _image) = unsafe {
        instantiate_core(
            &mut store,
            &linker,
            &module,
            &core.layout,
            backing,
            &placement,
        )
    }
    .unwrap();
    let top = Top {
        store,
        instance,
        memory: GuestMemory::Shared(backing.clone()),
        stdout,
    };
    (top, placement)
}

/// Any guest access that reaches `0x80000000` traps. This uses a Store that imports the group
/// memory once: Wasmtime 39 asserts while reporting a memory fault when one Store holds the
/// same shared memory through more than one import, as a member with its preview1 view does.
fn traps_past_the_end(engine: &Engine, backing: &SharedMemoryLease, placement: &Placement) {
    let module = Module::new(engine, boundary_core()).unwrap();
    let wasi = WasiCtxBuilder::new().build_p1();
    let mut store: Store<WasiP1Ctx> = Store::new(engine, wasi);
    let mut linker = Linker::new(engine);
    p1::add_to_linker_sync(&mut linker, |cx| cx).unwrap();
    // SAFETY: the caller's `backing` outlives this Store, which is dropped on return.
    let (instance, _image) =
        unsafe { instantiate_core(&mut store, &linker, &module, &layout(), backing, placement) }
            .unwrap();
    let load = instance
        .get_typed_func::<i32, i32>(&mut store, "load")
        .unwrap();
    let load8 = instance
        .get_typed_func::<i32, i32>(&mut store, "load8")
        .unwrap();
    let store8 = instance
        .get_typed_func::<(i32, i32), ()>(&mut store, "store8")
        .unwrap();
    assert_eq!(load8.call(&mut store, (END - 1) as i32).unwrap(), 0xa5);
    assert!(load.call(&mut store, (END - 4) as i32).is_ok());
    assert!(load8.call(&mut store, END as i32).is_err());
    assert!(load.call(&mut store, (END - 3) as i32).is_err());
    assert!(load.call(&mut store, -4).is_err());
    assert!(store8.call(&mut store, (END as i32, 1)).is_err());
    assert_eq!(load8.call(&mut store, (END - 1) as i32).unwrap(), 0xa5);
}

#[test]
fn the_final_group_page_and_the_signed_endpoint_work_through_the_production_adapters() {
    assert_eq!(MAX_PAGES * u64::from(PAGE), u64::from(END));
    let engine = engine();
    let budget = GroupBackingBudget::default();
    let lease = member(&engine, &budget, true, 1, None).unwrap().unwrap();
    let group = lease.group();
    let backing = group.memory_lease();
    // A member always holds pages before its program can ask for a memory.
    assert_eq!(grow(&lease, 1).unwrap(), 1);
    // Stock Rolldown's descriptor: its declared maximum cannot fit beside a member, so it
    // takes its initial pages plus the preferred optional room, and stays where it was placed.
    let rolldown = NestedMemory::new(&lease, 16384, 65536).unwrap();
    assert_eq!(rolldown.base(), 2 * PAGE);
    assert_eq!(rolldown.reserved_bytes(), 17408 * u64::from(PAGE));
    assert_eq!(rolldown.maximum(), 65536);
    let rest = MAX_PAGES as u32 - 1 - 17408;
    let image_pages = 1 + STACK_PAGES;
    // The member's heap continues above 1 GiB and ends where its image begins.
    let heap = grow(&lease, rest - 1 - image_pages).unwrap();
    assert_eq!(heap, 17410);
    assert!(u64::from(heap) * u64::from(PAGE) > 1 << 30);
    // SAFETY: `backing` is declared before the Store inside `top` and dropped after it.
    // Enough stdin that every refused read below still has bytes to deliver.
    let stdin = "stdin and enough further bytes that each refused read has data to store";
    let (mut top, placement) = unsafe { top_member(&engine, &lease, &backing, stdin) };
    assert_eq!(placement.stack + STACK_PAGES, MAX_PAGES as u32);
    assert_eq!(page_address(placement.stack + STACK_PAGES).unwrap(), END);
    assert!(page_address(MAX_PAGES as u32 + 1).is_err());
    assert_eq!(top.memory.len(&top.store), END as usize);
    let full = accounting(&group, &budget);
    assert_eq!(full.0.member_pages, rest);
    assert_eq!(full.0.committed_bytes, u64::from(END));
    assert_eq!(full.0.free_bytes, 0);
    assert_eq!(full.1, u64::from(END));

    // The stack top is one past the end: `i32::MIN` in the global, 0x80000000 as an address.
    let sp = top.function::<(), i32>("sp");
    assert_eq!(sp.call(&mut top.store, ()).unwrap(), i32::MIN);
    let pushed = top
        .function::<i32, i32>("push")
        .call(&mut top.store, 0x5eed_beefu32 as i32)
        .unwrap();
    assert_eq!(pushed as u32, END - 4);
    assert_eq!(top.bytes(END - 4, 4), 0x5eed_beefu32.to_le_bytes());
    assert_eq!(top.load(END - 4), 0x5eed_beef);

    // The final byte is addressable from the guest.
    let store8 = top.function::<(i32, i32), ()>("store8");
    let load8 = top.function::<i32, i32>("load8");
    store8.call(&mut top.store, ((END - 1) as i32, 0xa5)).unwrap();
    assert_eq!(load8.call(&mut top.store, (END - 1) as i32).unwrap(), 0xa5);
    traps_past_the_end(&engine, &backing, &placement);

    // Host accessors: the last byte is in bounds, one past it is not, and nothing is stored
    // by a refused write.
    let end = END as usize;
    assert_eq!(top.memory.read(&top.store, end - 1..end).unwrap(), [0xa5]);
    assert!(top.memory.read(&top.store, end - 1..end + 1).is_none());
    assert!(top.memory.read(&top.store, end..end + 1).is_none());
    assert!(top.memory.write(&mut top.store, end - 2, b"abc").is_none());
    assert!(top.memory.write(&mut top.store, end, b"a").is_none());
    assert!(top.memory.write(&mut top.store, usize::MAX, b"ab").is_none());
    assert_eq!(top.bytes(END - 2, 2), [0xed, 0xa5]);
    top.memory.write(&mut top.store, end - 3, b"xyz").unwrap();
    assert_eq!(top.bytes(END - 3, 3), b"xyz");
    let filled = top.memory.fill(&mut top.store, end - 4..end, |buffer, _| {
        buffer.copy_from_slice(b"fill");
        4
    });
    assert_eq!(filled, Some(4));
    assert!(
        top.memory
            .fill(&mut top.store, end - 4..end + 1, |_, _| 5)
            .is_none()
    );
    assert_eq!(top.bytes(END - 4, 4), b"fill");

    // Preview1 through the member's view: bytes ending at the final byte.
    let (iovec, cell) = (LAST_PAGE + 0x100, LAST_PAGE + 0x200);
    top.memory.write(&mut top.store, end - 4, b"top!").unwrap();
    assert_eq!(top.io("write", iovec, (END - 4, 4), cell).unwrap(), 0);
    assert_eq!(top.load(cell), 4);
    // The iovec itself in the final eight bytes, then the result cell in the final word.
    top.memory.write(&mut top.store, end - 16, b"edge").unwrap();
    assert_eq!(top.io("write", END - 8, (END - 16, 4), cell).unwrap(), 0);
    assert_eq!(top.io("write", iovec, (END - 16, 4), END - 4).unwrap(), 0);
    assert_eq!(top.load(END - 4), 4);
    assert_eq!(&top.stdout.contents()[..], b"top!edgeedge");
    // A read whose buffer ends at the final byte.
    assert_eq!(top.io("read", iovec, (END - 5, 5), cell).unwrap(), 0);
    assert_eq!(top.load(cell), 5);
    assert_eq!(top.bytes(END - 5, 5), b"stdin");

    // Spans that reach or wrap past the end are refused, and the guest sees no partial result.
    top.store(cell, 0x1234_5678);
    let written = top.stdout.contents().len();
    for span in [(END - 4, 5), (END - 1, 2), (END, 1), (0xffff_fff0, 0x20)] {
        assert!(top.io("write", iovec, span, cell).is_err(), "{span:x?}");
        assert!(top.io("read", iovec, span, cell).is_err(), "{span:x?}");
    }
    // An iovec array that crosses the end.
    top.store(END - 4, END - 16);
    assert!(top.io_at("write", END - 4, cell).is_err());
    assert_eq!(top.load(cell), 0x1234_5678);
    assert_eq!(top.bytes(END - 5, 1), b"s");
    assert_eq!(top.stdout.contents().len(), written);
    // A result cell at the one-past-end address traps as well. Wasmtime's preview1 validates
    // that cell only after the write, so the bytes are out before the guest traps.
    assert!(top.io("write", iovec, (END - 16, 4), END).is_err());
    assert_eq!(top.load(cell), 0x1234_5678);

    // `runtime_shm` spans at the endpoint.
    assert_eq!(shm::futex_wake(&lease, END - 4, 1), 0);
    assert_eq!(shm::futex_wake(&lease, END, 1), INVAL);
    assert_eq!(shm::futex_watch(&lease, END - 8, 0, END - 4), 0);
    assert_eq!(shm::futex_unwatch(&lease, top.load(END - 4)), 0);
    assert_eq!(shm::futex_watch(&lease, END - 4, 0, END), INVAL);

    // One page over: neither a member page nor a region is admitted, and nothing changes.
    let before = accounting(&group, &budget);
    assert_eq!(shm::group_grow(&lease, 1), NOMEM);
    assert_eq!(shm::shm_create(&lease, PAGE, 16, LAST_PAGE), NOMEM);
    assert_eq!(shm::shm_create(&lease, 1, 16, END - 4), INVAL);
    assert_eq!(NestedMemory::new(&lease, 1, 1).err(), Some(shm::Errno::NoMem));
    // Rolldown's own growth stops at its reservation, below its declared maximum.
    assert_eq!(rolldown.grow(1024), Ok(16384));
    assert_eq!(rolldown.grow(1), Err(shm::Errno::NoMem));
    assert_eq!(accounting(&group, &budget), before);
    assert_eq!(before.0.regions, 1);
    assert_eq!(before.0.watches, 0);

    // The owner returns everything: the region with its last hold, the member pages with the
    // member, and the backing charge with the last lease.
    drop(rolldown);
    assert_eq!(group.snapshot().regions, 0);
    assert_eq!(group.snapshot().member_pages, rest);
    lease.physical_stopped();
    let stopped = group.snapshot();
    assert_eq!((stopped.members, stopped.holds, stopped.member_pages), (0, 0, 0));
    assert_eq!(stopped.free_bytes, u64::from(END) - u64::from(PAGE));
    assert_eq!(budget.committed_bytes(), u64::from(END));
    drop(top);
    drop(group);
    drop(backing);
    assert_eq!(budget.committed_bytes(), 0);
}

#[test]
fn a_partial_admission_at_the_member_cap_returns_its_image_pages() {
    let engine = engine();
    let budget = GroupBackingBudget::default();
    let root = member(&engine, &budget, true, 1, None).unwrap().unwrap();
    let group = root.group();
    // Members hold all but a stack's worth of the cap; the address space has plenty left.
    let held = MEMBER_PAGES - STACK_PAGES;
    grow(&root, held).unwrap();
    let admission = worker_admission(Some(&group), true, true, 2).unwrap();
    let worker = member(&engine, &budget, true, 2, admission)
        .unwrap()
        .unwrap();
    // The worker's data page fits; its stack would pass the cap.
    let error = carve(&worker, &layout()).err().expect("stack past the cap");
    assert!(format!("{error:#}").contains("errno 48"), "{error:#}");
    assert_eq!(group.snapshot().member_pages, held + 1);
    worker.physical_stopped();
    let after = group.snapshot();
    assert_eq!((after.members, after.member_pages), (1, held));
    // The cap, not the address space, refused it: a region of the same size is admitted.
    assert!(NestedMemory::new(&root, STACK_PAGES, STACK_PAGES).is_ok());
    assert!(shm::group_grow(&root, STACK_PAGES) > 0);
    assert_eq!(group.snapshot().member_pages, MEMBER_PAGES);
    assert_eq!(shm::group_grow(&root, 1), NOMEM);
    root.physical_stopped();
}
