use wasm_encoder::{
    BlockType, Function, Instruction as I, Module, ValType as V,
    reencode::{Error, Reencode},
};
use wasmparser::{FunctionBody, MemArg, Operator as O, Parser};

use crate::{
    CompileError, CompileErrorKind,
    admission::{ActiveData, Info, Offset},
    operators::{Shape, shape},
};

pub(crate) type RewriteError = Error<CompileError>;
pub(crate) const NEW_FUNCS: u32 = 6;
pub(crate) const NEW_GLOBALS: u32 = 2;
const SCRATCH: [V; 11] = [
    V::I32,
    V::I64,
    V::I32,
    V::I32,
    V::I64,
    V::I64,
    V::F32,
    V::F64,
    V::V128,
    V::I32,
    V::I32,
];

pub(crate) struct Scratch {
    indices: [Option<u32>; 11],
}

impl Scratch {
    fn new(first: u32, needed: [bool; 11], locals: &mut Vec<(u32, V)>) -> Self {
        let mut indices = [None; 11];
        let mut next = first;
        for (slot, used) in needed.into_iter().enumerate() {
            if !used {
                continue;
            }
            indices[slot] = Some(next);
            next += 1;
            locals.push((1, SCRATCH[slot]));
        }
        Self { indices }
    }

    fn get(&self, slot: usize) -> u32 {
        self.indices[slot].expect("scratch analysis and emission use the same access shapes")
    }
}

pub(crate) struct Regionizer {
    pub info: Info,
    pub next_body: usize,
    pub types: u32,
}

impl Regionizer {
    pub fn new(info: Info) -> Self {
        Self {
            types: info.params.len() as u32,
            info,
            next_body: 0,
        }
    }

    pub fn encode(&mut self, bytes: &[u8]) -> Result<Vec<u8>, CompileError> {
        let mut module = Module::new();
        self.parse_core_module(&mut module, Parser::new(0), bytes)
            .map_err(|error| match error {
                Error::UserError(error) => error,
                other => CompileError {
                    kind: CompileErrorKind::InvalidOutput,
                    offset: None,
                    message: other.to_string(),
                },
            })?;
        Ok(module.finish())
    }

    pub fn f_length(&self) -> u32 {
        self.info.imported_funcs
    }
    pub fn f_grow(&self) -> u32 {
        self.f_length() + 1
    }
    pub fn f_pages(&self) -> u32 {
        self.f_length() + 2
    }
    pub fn f_wait32(&self) -> u32 {
        self.f_length() + 3
    }
    pub fn f_wait64(&self) -> u32 {
        self.f_length() + 4
    }
    pub fn f_notify(&self) -> u32 {
        self.f_length() + 5
    }
    pub fn f_oob(&self) -> u32 {
        self.f_length() + NEW_FUNCS + self.info.defined.len() as u32
    }
    pub fn f_init(&self) -> u32 {
        self.f_oob() + 1
    }
    pub fn g_base(&self) -> u32 {
        self.info.imported_globals
    }
    pub fn g_bound0(&self) -> u32 {
        self.g_base() + 1
    }
    pub fn g_bound(&self) -> u32 {
        self.g_base() + NEW_GLOBALS + self.info.defined_globals
    }

    /// Widen before addition. Validated wasm32 memarg offsets fit u32, so end fits i64.
    fn check(&self, f: &mut Function, scratch: &Scratch, extra: Option<u64>) {
        f.instruction(&I::LocalTee(scratch.get(0)))
            .instruction(&I::I64ExtendI32U);
        match extra {
            Some(n) => f.instruction(&I::I64Const(n as i64)),
            None => f
                .instruction(&I::LocalGet(scratch.get(9)))
                .instruction(&I::I64ExtendI32U),
        };
        f.instruction(&I::I64Add)
            .instruction(&I::LocalTee(scratch.get(1)));
        f.instruction(&I::GlobalGet(self.g_bound()))
            .instruction(&I::I64GtU);
        f.instruction(&I::If(BlockType::Empty));
        f.instruction(&I::LocalGet(scratch.get(1)))
            .instruction(&I::Call(self.f_oob()));
        f.instruction(&I::End);
        f.instruction(&I::LocalGet(scratch.get(0)))
            .instruction(&I::GlobalGet(self.g_base()))
            .instruction(&I::I32Add);
    }

    fn access(
        &mut self,
        f: &mut Function,
        op: O<'_>,
        m: MemArg,
        shape: Shape,
        scratch: &Scratch,
    ) -> Result<(), RewriteError> {
        save_operands(f, shape, scratch);
        self.check(f, scratch, Some(m.offset + (1u64 << m.max_align)));
        let imported = self.wait_import(&op);
        if imported.is_some() {
            self.align_wait_address(f, scratch, &m);
        }
        restore_operands(f, shape, scratch);
        if let Some(index) = imported {
            f.instruction(&I::Call(index));
            return Ok(());
        }
        f.instruction(&self.instruction(op)?);
        Ok(())
    }

    fn wait_import(&self, op: &O<'_>) -> Option<u32> {
        match op {
            O::MemoryAtomicWait32 { .. } => Some(self.f_wait32()),
            O::MemoryAtomicWait64 { .. } => Some(self.f_wait64()),
            O::MemoryAtomicNotify { .. } => Some(self.f_notify()),
            _ => None,
        }
    }

    fn align_wait_address(&self, f: &mut Function, scratch: &Scratch, m: &MemArg) {
        f.instruction(&I::I32Const(m.offset as i32))
            .instruction(&I::I32Add);
        f.instruction(&I::LocalTee(scratch.get(0)));
        f.instruction(&I::I32Const((1i32 << m.max_align) - 1))
            .instruction(&I::I32And);
        f.instruction(&I::If(BlockType::Empty))
            .instruction(&I::Unreachable)
            .instruction(&I::End);
        f.instruction(&I::LocalGet(scratch.get(0)));
    }

    fn bulk(&mut self, f: &mut Function, op: O<'_>, scratch: &Scratch) -> Result<(), RewriteError> {
        f.instruction(&I::LocalSet(scratch.get(9)))
            .instruction(&I::LocalSet(scratch.get(10)));
        self.check(f, scratch, None);
        f.instruction(&I::LocalGet(scratch.get(10)));
        if matches!(op, O::MemoryCopy { .. }) {
            self.check(f, scratch, None);
        }
        f.instruction(&I::LocalGet(scratch.get(9)))
            .instruction(&self.instruction(op)?);
        Ok(())
    }

    fn rewrite(
        &mut self,
        f: &mut Function,
        op: O<'_>,
        scratch: &Scratch,
    ) -> Result<(), RewriteError> {
        if let Some((m, shape)) = shape(&op) {
            return self.access(f, op, m, shape, scratch);
        }
        match op {
            O::MemoryCopy { .. } | O::MemoryFill { .. } | O::MemoryInit { .. } => {
                self.bulk(f, op, scratch)?
            }
            O::MemorySize { .. } => {
                f.instruction(&I::Call(self.f_pages()));
            }
            O::MemoryGrow { .. } => {
                f.instruction(&I::Call(self.f_grow()));
            }
            op => {
                f.instruction(&self.instruction(op)?);
            }
        }
        Ok(())
    }

    pub fn body(&mut self, body: FunctionBody<'_>) -> Result<Function, RewriteError> {
        let ty = self.info.defined[self.next_body];
        self.next_body += 1;
        let mut first = self.info.params[ty as usize];
        let mut locals = Vec::new();
        for local in body.get_locals_reader()? {
            let (count, ty) = local?;
            first += count;
            locals.push((count, self.val_type(ty)?));
        }
        let scratch = Scratch::new(first, needed_scratch(&body)?, &mut locals);
        let mut function = Function::new(locals);
        let mut reader = body.get_operators_reader()?;
        while !reader.eof() {
            self.rewrite(&mut function, reader.read()?, &scratch)?;
        }
        Ok(function)
    }

    pub fn oob(&self) -> Function {
        let mut f = Function::new([]);
        f.instruction(&I::Call(self.f_length()))
            .instruction(&I::GlobalSet(self.g_bound()));
        f.instruction(&I::LocalGet(0))
            .instruction(&I::GlobalGet(self.g_bound()))
            .instruction(&I::I64GtU);
        f.instruction(&I::If(BlockType::Empty))
            .instruction(&I::Unreachable)
            .instruction(&I::End)
            .instruction(&I::End);
        f
    }

    pub fn init_data(&mut self) -> Result<Function, RewriteError> {
        let mut locals = Vec::new();
        let needed = [
            true, true, false, false, false, false, false, false, false, true, true,
        ];
        let scratch = Scratch::new(0, needed, &mut locals);
        let mut f = Function::new(locals);
        // Instantiation preflights every active segment before mutating the imported memory.
        for data in &self.info.active {
            self.data_address(&mut f, *data);
            self.check(&mut f, &scratch, Some(u64::from(data.length)));
            f.instruction(&I::Drop);
        }
        for data in self.info.active.clone() {
            self.data_address(&mut f, data);
            f.instruction(&I::I32Const(0))
                .instruction(&I::I32Const(data.length as i32));
            self.bulk(
                &mut f,
                O::MemoryInit {
                    data_index: data.segment,
                    mem: 0,
                },
                &scratch,
            )?;
            f.instruction(&I::DataDrop(data.segment));
        }
        if let Some(start) = self.info.start {
            f.instruction(&I::Call(self.function_index(start)));
        }
        f.instruction(&I::End);
        Ok(f)
    }

    fn data_address(&self, f: &mut Function, data: ActiveData) {
        match data.offset {
            Offset::Const(value) => f.instruction(&I::I32Const(value)),
            Offset::Global(global) => {
                f.instruction(&I::GlobalGet(if global < self.info.imported_globals {
                    global
                } else {
                    global + NEW_GLOBALS
                }))
            }
        };
    }
}

fn needed_scratch(body: &FunctionBody<'_>) -> Result<[bool; 11], RewriteError> {
    let mut needed = [false; 11];
    let mut reader = body.get_operators_reader()?;
    while !reader.eof() {
        mark_scratch(&mut needed, &reader.read()?);
    }
    Ok(needed)
}

fn mark_scratch(needed: &mut [bool; 11], op: &O<'_>) {
    if let Some((_, shape)) = shape(op) {
        needed[0] = true;
        needed[1] = true;
        mark_operands(needed, shape);
    }
    if matches!(
        op,
        O::MemoryCopy { .. } | O::MemoryFill { .. } | O::MemoryInit { .. }
    ) {
        for slot in [0, 1, 9, 10] {
            needed[slot] = true;
        }
    }
}

fn mark_operands(needed: &mut [bool; 11], shape: Shape) {
    match shape {
        Shape::Load => (),
        Shape::Value(a) => needed[a as usize] = true,
        Shape::Two(a, b) => {
            needed[a as usize] = true;
            needed[b as usize] = true;
        }
    }
}

fn save_operands(f: &mut Function, shape: Shape, scratch: &Scratch) {
    match shape {
        Shape::Load => (),
        Shape::Value(a) => {
            f.instruction(&I::LocalSet(scratch.get(a as usize)));
        }
        Shape::Two(a, b) => {
            f.instruction(&I::LocalSet(scratch.get(b as usize)))
                .instruction(&I::LocalSet(scratch.get(a as usize)));
        }
    }
}

fn restore_operands(f: &mut Function, shape: Shape, scratch: &Scratch) {
    match shape {
        Shape::Load => (),
        Shape::Value(a) => {
            f.instruction(&I::LocalGet(scratch.get(a as usize)));
        }
        Shape::Two(a, b) => {
            f.instruction(&I::LocalGet(scratch.get(a as usize)))
                .instruction(&I::LocalGet(scratch.get(b as usize)));
        }
    }
}
