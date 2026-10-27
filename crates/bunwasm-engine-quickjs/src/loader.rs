use crate::Core;
use crate::engine::{Engine, ModuleHost, Val};

impl<E: Engine> ModuleHost<E> for Core<E> {
    fn has_interrupt_handler(&self) -> bool {
        Core::has_interrupt_handler(self)
    }

    fn interrupt(&self) -> bool {
        // Never call guest JS here: QuickJS also polls during native operations,
        // and interpreter checkpoints may interrupt runtime JS bookkeeping.
        // Mode 4 leaves handled signals pending for the next event-loop turn,
        // matching Node. Fatal host outcomes unwind Wasm without catch/finally.
        Core::interrupt(self)
    }

    fn resolve(&self, e: &E, specifier: &str, referrer: &str) -> Result<String, E::Value> {
        self.resolve_module(specifier, referrer)
            .map_err(|err| e.error_value(&err))
    }

    fn load(&self, e: &E, name: &str) -> Result<String, E::Value> {
        let (format, source) = self
            .module_source(name)
            .map_err(|err| e.error_value(&err))?;
        if format == "builtin" {
            let exports = self.call_internal(e, "builtin", &[e.value_from(name.into())])?;
            let keys = e.keys(&exports);
            // A builtin marked `__esModule` (bun:sqlite) names its own default
            // export; for the rest the default is the exports object.
            let flagged = e
                .get(&exports, "__esModule")
                .map(|v| e.to_val(&v) == Val::Bool(true))
                .unwrap_or(false);
            let default = if flagged {
                e.get(&exports, "default")?
            } else {
                exports.clone()
            };
            self.handoffs
                .borrow_mut()
                .insert(name.to_owned(), (exports, default));
            return self.wrapper_source(keys).map_err(|err| e.error_value(&err));
        }
        if format == "esm" {
            return Ok(source);
        }
        // The JS side evaluates it (sharing require's cache) and returns
        // [namespaceObject, defaultExport].
        let args = [e.value_from(name.into()), e.value_from(format.into())];
        let pair = self.call_internal(e, "importNonEsm", &args)?;
        let (value, default) = (e.get(&pair, "0")?, e.get(&pair, "1")?);
        let keys = e.keys(&value);
        self.handoffs
            .borrow_mut()
            .insert(name.to_owned(), (value, default));
        self.wrapper_source(keys).map_err(|err| e.error_value(&err))
    }

    fn init_meta(&self, e: &E, name: &str, meta: &E::Value) -> Result<(), E::Value> {
        let handoff = self.handoffs.borrow_mut().remove(name);
        if let Some((value, default)) = handoff {
            let m = e.new_object();
            e.set(&m, "value", value)?;
            e.set(&m, "default", default)?;
            return e.set(meta, "m", m);
        }
        let is_main = self.is_main(name).map_err(|err| e.error_value(&err))?;
        let args = [
            meta.clone(),
            e.value_from(name.into()),
            e.value_from(is_main.into()),
        ];
        self.call_internal(e, "initImportMeta", &args).map(|_| ())
    }
}
