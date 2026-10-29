use crate::Core;
use crate::engine::{Engine, ModuleHost, ModuleSource, Val};

impl<E: Engine> Core<E> {
    fn synthetic(&self, e: &E, name: &str, format: &str) -> Result<(E::Value, E::Value), E::Value> {
        if format != "builtin" {
            let args = [e.value_from(name.into()), e.value_from(format.into())];
            let pair = self.call_internal(e, "importNonEsm", &args)?;
            return Ok((e.get(&pair, "0")?, e.get(&pair, "1")?));
        }
        let exports = self.call_internal(e, "builtin", &[e.value_from(name.into())])?;
        // Builtins marked __esModule name their own default export.
        let flagged = e
            .get(&exports, "__esModule")
            .map(|v| e.to_val(&v) == Val::Bool(true))
            .unwrap_or(false);
        let default = if flagged {
            e.get(&exports, "default")?
        } else {
            exports.clone()
        };
        Ok((exports, default))
    }
}

impl<E: Engine> ModuleHost<E> for Core<E> {
    fn uncaught(&self, engine: &E, error: &E::Value) {
        Core::uncaught(self, engine, error.clone());
    }

    fn has_interrupt_handler(&self) -> bool {
        Core::has_interrupt_handler(self)
    }

    fn interrupt(&self) -> bool {
        // Never call guest JS here. Interpreter checkpoints may interrupt
        // runtime JS bookkeeping, and native operations also poll this hook.
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
        if format == "esm" {
            return Ok(source);
        }
        let (value, default) = self.synthetic(e, name, &format)?;
        let keys = e.keys(&value);
        self.handoffs
            .borrow_mut()
            .insert(name.to_owned(), (value, default));
        self.wrapper_source(keys).map_err(|err| e.error_value(&err))
    }

    fn record_loader_source(&self, e: &E) -> Result<String, E::Value> {
        self.polyfill("esm_loader")
            .map_err(|err| e.error_value(&err))
    }

    fn load_record(&self, e: &E, name: &str) -> Result<ModuleSource<E>, E::Value> {
        let (format, source) = self
            .client
            .module_record(name)
            .map_err(|err| e.error_value(&err))?;
        if format == "esm" {
            return Ok(ModuleSource::Record(source));
        }
        let (namespace, default) = self.synthetic(e, name, &format)?;
        Ok(ModuleSource::Synthetic { namespace, default })
    }

    fn lower_script(&self, e: &E, source: &str, filename: &str) -> Result<String, E::Value> {
        self.client
            .lower_script(source, filename)
            .map_err(|err| e.error_value(&err))
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
