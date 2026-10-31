use wasm_encoder::{
    CodeSection, ConstExpr, DataCountSection, EntityType, FunctionSection, GlobalSection,
    GlobalType, ImportSection, MemorySection, MemoryType, Module, SectionId, StartSection,
    TypeSection, ValType as V,
    reencode::{Reencode, utils},
};

use crate::{
    CompileError, IMPORT_MODULE,
    rewrite::{NEW_FUNCS, NEW_GLOBALS, Regionizer, RewriteError},
};

impl Regionizer {
    fn add_types(&self, types: &mut TypeSection) {
        types.ty().function([], [V::I64]);
        types.ty().function([V::I32], [V::I32]);
        types.ty().function([], [V::I32]);
        types.ty().function([V::I32, V::I32, V::I64], [V::I32]);
        types.ty().function([V::I32, V::I64, V::I64], [V::I32]);
        types.ty().function([V::I32, V::I32], [V::I32]);
        types.ty().function([V::I64], []);
        types.ty().function([], []);
    }

    fn add_imports(&self, imports: &mut ImportSection) {
        let global = |val_type| {
            EntityType::Global(GlobalType {
                val_type,
                mutable: false,
                shared: false,
            })
        };
        imports.import(IMPORT_MODULE, "base", global(V::I32));
        imports.import(IMPORT_MODULE, "bound0", global(V::I64));
        for (offset, name) in ["length", "grow", "pages", "wait32", "wait64", "notify"]
            .into_iter()
            .enumerate()
        {
            imports.import(
                IMPORT_MODULE,
                name,
                EntityType::Function(self.types + offset as u32),
            );
        }
        if let Some(memory) = &self.info.memory {
            imports.import(
                IMPORT_MODULE,
                "memory",
                EntityType::Memory(MemoryType {
                    minimum: 0,
                    maximum: Some(65536),
                    memory64: false,
                    shared: memory.shared,
                    page_size_log2: None,
                }),
            );
        }
    }

    fn add_functions(&self, functions: &mut FunctionSection) {
        functions.function(self.types + NEW_FUNCS);
        if !self.info.active.is_empty() {
            functions.function(self.types + NEW_FUNCS + 1);
        }
    }

    fn add_globals(&self, globals: &mut GlobalSection) {
        let ty = GlobalType {
            val_type: V::I64,
            mutable: true,
            shared: false,
        };
        globals.global(ty, &ConstExpr::global_get(self.g_bound0()));
    }

    fn add_code(&mut self, code: &mut CodeSection) -> Result<(), RewriteError> {
        code.function(&self.oob());
        if !self.info.active.is_empty() {
            code.function(&self.init_data()?);
        }
        Ok(())
    }

    fn insert_section(&mut self, module: &mut Module, id: SectionId) -> Result<(), RewriteError> {
        match id {
            SectionId::Type => {
                let mut s = TypeSection::new();
                self.add_types(&mut s);
                module.section(&s);
            }
            SectionId::Import => {
                let mut s = ImportSection::new();
                self.add_imports(&mut s);
                module.section(&s);
            }
            SectionId::Function => {
                let mut s = FunctionSection::new();
                self.add_functions(&mut s);
                module.section(&s);
            }
            SectionId::Global => {
                let mut s = GlobalSection::new();
                self.add_globals(&mut s);
                module.section(&s);
            }
            SectionId::Start => {
                module.section(&StartSection {
                    function_index: self.f_init(),
                });
            }
            SectionId::DataCount => {
                module.section(&DataCountSection {
                    count: self.info.segments,
                });
            }
            SectionId::Code => {
                let mut s = CodeSection::new();
                self.add_code(&mut s)?;
                module.section(&s);
            }
            _ => unreachable!("only synthesized sections are requested"),
        }
        Ok(())
    }
}

impl Reencode for Regionizer {
    type Error = CompileError;

    fn function_index(&mut self, func: u32) -> u32 {
        if func < self.info.imported_funcs {
            func
        } else {
            func + NEW_FUNCS
        }
    }

    fn global_index(&mut self, global: u32) -> u32 {
        if global < self.info.imported_globals {
            global
        } else {
            global + NEW_GLOBALS
        }
    }

    fn parse_type_section(
        &mut self,
        types: &mut TypeSection,
        section: wasmparser::TypeSectionReader<'_>,
    ) -> Result<(), RewriteError> {
        utils::parse_type_section(self, types, section)?;
        self.add_types(types);
        Ok(())
    }

    fn parse_import_section(
        &mut self,
        imports: &mut ImportSection,
        section: wasmparser::ImportSectionReader<'_>,
    ) -> Result<(), RewriteError> {
        for import in section {
            let import = import?;
            if matches!(import.ty, wasmparser::TypeRef::Memory(_)) {
                continue;
            }
            self.parse_import(imports, import)?;
        }
        self.add_imports(imports);
        Ok(())
    }

    fn parse_memory_section(
        &mut self,
        _memories: &mut MemorySection,
        _section: wasmparser::MemorySectionReader<'_>,
    ) -> Result<(), RewriteError> {
        Ok(())
    }

    fn parse_function_section(
        &mut self,
        functions: &mut FunctionSection,
        section: wasmparser::FunctionSectionReader<'_>,
    ) -> Result<(), RewriteError> {
        utils::parse_function_section(self, functions, section)?;
        self.add_functions(functions);
        Ok(())
    }

    fn parse_global_section(
        &mut self,
        globals: &mut GlobalSection,
        section: wasmparser::GlobalSectionReader<'_>,
    ) -> Result<(), RewriteError> {
        utils::parse_global_section(self, globals, section)?;
        self.add_globals(globals);
        Ok(())
    }

    fn parse_code_section(
        &mut self,
        code: &mut CodeSection,
        section: wasmparser::CodeSectionReader<'_>,
    ) -> Result<(), RewriteError> {
        utils::parse_code_section(self, code, section)?;
        self.add_code(code)
    }

    fn parse_function_body(
        &mut self,
        code: &mut CodeSection,
        body: wasmparser::FunctionBody<'_>,
    ) -> Result<(), RewriteError> {
        code.function(&self.body(body)?);
        Ok(())
    }

    fn parse_data_section(
        &mut self,
        data: &mut wasm_encoder::DataSection,
        section: wasmparser::DataSectionReader<'_>,
    ) -> Result<(), RewriteError> {
        for datum in section {
            let datum = datum?;
            data.passive(datum.data.iter().copied());
        }
        Ok(())
    }

    fn start_section(&mut self, start: u32) -> u32 {
        if self.info.active.is_empty() {
            self.function_index(start)
        } else {
            self.f_init()
        }
    }

    fn intersperse_section_hook(
        &mut self,
        module: &mut Module,
        after: Option<SectionId>,
        before: Option<SectionId>,
    ) -> Result<(), RewriteError> {
        let first = after.map_or(0, rank);
        let last = before.map_or(u8::MAX, rank);
        for id in [
            SectionId::Type,
            SectionId::Import,
            SectionId::Function,
            SectionId::Global,
            SectionId::Start,
            SectionId::DataCount,
            SectionId::Code,
        ] {
            self.insert_missing(module, id, first, last)?;
        }
        Ok(())
    }
}

impl Regionizer {
    fn insert_missing(
        &mut self,
        module: &mut Module,
        id: SectionId,
        first: u8,
        last: u8,
    ) -> Result<(), RewriteError> {
        if rank(id) <= first || rank(id) >= last || self.info.sections.contains(&id) {
            return Ok(());
        }
        if matches!(id, SectionId::Start | SectionId::DataCount) && self.info.active.is_empty() {
            return Ok(());
        }
        self.insert_section(module, id)
    }
}

fn rank(id: SectionId) -> u8 {
    match id {
        SectionId::DataCount => 10,
        SectionId::Code => 11,
        SectionId::Data => 12,
        other => other as u8,
    }
}
