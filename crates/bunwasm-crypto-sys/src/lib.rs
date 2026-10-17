//! RSA FFI and the native crypto archive shared by Bun tools and the JS runtime.

unsafe extern "C" {
    pub fn bunwasm_rsa_generate(
        bits: i32,
        exponent: *const u8,
        len: usize,
    ) -> *mut std::ffi::c_void;
    pub fn bunwasm_rsa_free(key: *mut std::ffi::c_void);
    pub fn bunwasm_rsa_from_jwk(
        fields: *const *const u8,
        lengths: *const usize,
        private: i32,
    ) -> *mut std::ffi::c_void;
    pub fn bunwasm_rsa_parse(der: *const u8, len: usize, private: i32) -> *mut std::ffi::c_void;
    pub fn bunwasm_rsa_field(
        key: *const std::ffi::c_void,
        index: i32,
        out: *mut u8,
        capacity: usize,
    ) -> usize;
    pub fn bunwasm_rsa_der(
        key: *const std::ffi::c_void,
        private: i32,
        out: *mut u8,
        capacity: usize,
    ) -> usize;
}

unsafe extern "C" {
    pub fn bunwasm_rsa(
        op: i32,
        der: *const u8,
        der_len: usize,
        hash: i32,
        pss: i32,
        salt: i32,
        label: *const u8,
        label_len: usize,
        input: *const u8,
        input_len: usize,
        output: *mut u8,
        output_len: *mut usize,
    ) -> i32;
}

unsafe extern "C" {
    pub fn bunwasm_key_encoding(
        op: i32,
        input: *const u8,
        input_len: usize,
        password: *const u8,
        password_len: usize,
        cipher: *const std::ffi::c_char,
        out: *mut u8,
        capacity: usize,
    ) -> usize;
}
