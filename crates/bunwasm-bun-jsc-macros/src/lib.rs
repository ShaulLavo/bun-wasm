use proc_macro::TokenStream;
use quote::{format_ident, quote};

#[proc_macro_attribute]
pub fn host_fn(attributes: TokenStream, item: TokenStream) -> TokenStream {
    if !attributes.is_empty() {
        return syn::Error::new(
            proc_macro::Span::call_site().into(),
            "only free host functions are supported",
        )
        .to_compile_error()
        .into();
    }
    let function = syn::parse_macro_input!(item as syn::ItemFn);
    let name = &function.sig.ident;
    let host_name = format_ident!("__jsc_host_{name}");
    quote! {
        #function
        #[allow(non_upper_case_globals)]
        pub const #host_name: ::bun_jsc::HostFn = #name;
    }
    .into()
}
