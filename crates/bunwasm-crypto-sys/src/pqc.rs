//! The byte-level ML-KEM, ML-DSA and ChaCha20-Poly1305 entry points of `c/pqc.c`, and
//! the Netscape SPKAC entry point of `c/spkac.c`.
//! Kinds: 0 ML-KEM-768, 1 ML-KEM-1024, 2 ML-DSA-44, 3 ML-DSA-65, 4 ML-DSA-87.

unsafe extern "C" {
    /// `c/spkac.c`. mode 0 verifies (1 or 0); mode 1 writes the public key PEM and mode 2
    /// the challenge, returning the full length or 0 on failure.
    pub fn bunwasm_spkac(
        mode: i32,
        data: *const u8,
        len: usize,
        out: *mut u8,
        capacity: usize,
    ) -> usize;
    /// 1 when `public` parses as this parameter set's encoded public key.
    pub fn bunwasm_pqc_check_public(kind: i32, public: *const u8, public_len: usize) -> i32;
    /// `what`: 0 public key, 1 seed, 2 ciphertext (ML-KEM) or signature (ML-DSA).
    pub fn bunwasm_pqc_size(kind: i32, what: i32) -> usize;
    pub fn bunwasm_pqc_public(
        kind: i32,
        seed: *const u8,
        seed_len: usize,
        out: *mut u8,
        out_len: usize,
    ) -> i32;
    pub fn bunwasm_mlkem_encap(
        kind: i32,
        public: *const u8,
        public_len: usize,
        ct: *mut u8,
        ss: *mut u8,
    ) -> i32;
    pub fn bunwasm_mlkem_decap(
        kind: i32,
        seed: *const u8,
        seed_len: usize,
        ct: *const u8,
        ct_len: usize,
        ss: *mut u8,
    ) -> i32;
    pub fn bunwasm_mldsa_sign(
        kind: i32,
        seed: *const u8,
        seed_len: usize,
        msg: *const u8,
        msg_len: usize,
        ctx: *const u8,
        ctx_len: usize,
        sig: *mut u8,
    ) -> i32;
    pub fn bunwasm_mldsa_verify(
        kind: i32,
        public: *const u8,
        public_len: usize,
        sig: *const u8,
        sig_len: usize,
        msg: *const u8,
        msg_len: usize,
        ctx: *const u8,
        ctx_len: usize,
    ) -> i32;
    pub fn bunwasm_chacha20_poly1305(
        encrypt: i32,
        key: *const u8,
        key_len: usize,
        nonce: *const u8,
        nonce_len: usize,
        ad: *const u8,
        ad_len: usize,
        input: *const u8,
        in_len: usize,
        out: *mut u8,
        out_len: *mut usize,
    ) -> i32;
}
