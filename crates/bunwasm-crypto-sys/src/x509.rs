use std::ffi::{c_char, c_int, c_long, c_uint, c_ulong, c_void};

pub enum Certificate {}
pub enum Name {}
pub enum NameEntry {}
pub enum Asn1String {}
pub enum Asn1Object {}
pub enum BigNum {}
pub enum Bio {}
pub enum BioMethod {}
pub enum Algorithm {}
pub enum Key {}
pub enum Stack {}
pub enum GeneralName {}

#[repr(C)]
pub struct AccessDescription {
    pub method: *mut Asn1Object,
    pub location: *mut GeneralName,
}

#[repr(C)]
pub struct BasicConstraints {
    pub ca: c_int,
    pub pathlen: *mut Asn1String,
}

unsafe extern "C" {
    pub fn d2i_X509(
        out: *mut *mut Certificate,
        input: *mut *const u8,
        len: c_long,
    ) -> *mut Certificate;
    pub fn i2d_X509(cert: *const Certificate, output: *mut *mut u8) -> c_int;
    pub fn X509_free(cert: *mut Certificate);
    pub fn X509_get_subject_name(cert: *const Certificate) -> *mut Name;
    pub fn X509_get_issuer_name(cert: *const Certificate) -> *mut Name;
    pub fn X509_get0_serialNumber(cert: *const Certificate) -> *const Asn1String;
    pub fn X509_get0_notBefore(cert: *const Certificate) -> *const Asn1String;
    pub fn X509_get0_notAfter(cert: *const Certificate) -> *const Asn1String;
    pub fn X509_get0_pubkey(cert: *const Certificate) -> *mut Key;
    pub fn X509_get_ext_by_NID(cert: *const Certificate, nid: c_int, last: c_int) -> c_int;
    pub fn X509_get_ext_d2i(
        cert: *const Certificate,
        nid: c_int,
        critical: *mut c_int,
        index: *mut c_int,
    ) -> *mut c_void;
    pub fn X509_get0_signature(
        signature: *mut *const Asn1String,
        algorithm: *mut *const Algorithm,
        cert: *const Certificate,
    );
    pub fn X509_ALGOR_get0(
        object: *mut *const Asn1Object,
        kind: *mut c_int,
        value: *mut *const c_void,
        algorithm: *const Algorithm,
    );
    pub fn X509_NAME_print_ex(
        bio: *mut Bio,
        name: *const Name,
        indent: c_int,
        flags: c_ulong,
    ) -> c_int;
    pub fn X509_NAME_entry_count(name: *const Name) -> c_int;
    pub fn X509_NAME_get_entry(name: *const Name, index: c_int) -> *mut NameEntry;
    pub fn X509_NAME_ENTRY_get_object(entry: *const NameEntry) -> *mut Asn1Object;
    pub fn X509_NAME_ENTRY_get_data(entry: *const NameEntry) -> *mut Asn1String;
    pub fn X509V3_EXT_free(nid: c_int, value: *mut c_void) -> c_int;
    pub fn GENERAL_NAME_get0_value(name: *const GeneralName, kind: *mut c_int) -> *mut c_void;
    pub fn ASN1_STRING_get0_data(value: *const Asn1String) -> *const u8;
    pub fn ASN1_STRING_length(value: *const Asn1String) -> c_int;
    pub fn BASIC_CONSTRAINTS_free(constraints: *mut BasicConstraints);
    pub fn EXTENDED_KEY_USAGE_free(usage: *mut Stack);
    pub fn OPENSSL_sk_num(stack: *const Stack) -> usize;
    pub fn OPENSSL_sk_value(stack: *const Stack, index: usize) -> *mut c_void;
    pub fn ASN1_TIME_print(bio: *mut Bio, time: *const Asn1String) -> c_int;
    pub fn ASN1_INTEGER_to_BN(value: *const Asn1String, bn: *mut BigNum) -> *mut BigNum;
    pub fn ASN1_STRING_to_UTF8(out: *mut *mut u8, value: *const Asn1String) -> c_int;
    pub fn BN_bn2hex(value: *const BigNum) -> *mut c_char;
    pub fn BN_free(value: *mut BigNum);
    pub fn OBJ_obj2nid(object: *const Asn1Object) -> c_int;
    pub fn OBJ_nid2sn(nid: c_int) -> *const c_char;
    pub fn OBJ_nid2ln(nid: c_int) -> *const c_char;
    pub fn OBJ_obj2txt(
        out: *mut c_char,
        length: c_int,
        object: *const Asn1Object,
        numeric: c_int,
    ) -> c_int;
    pub fn BIO_new(method: *const BioMethod) -> *mut Bio;
    pub fn BIO_s_mem() -> *const BioMethod;
    pub fn BIO_mem_contents(bio: *const Bio, data: *mut *const u8, len: *mut usize) -> c_int;
    pub fn BIO_free(bio: *mut Bio) -> c_int;
    pub fn i2d_PUBKEY(key: *const Key, output: *mut *mut u8) -> c_int;
    pub fn d2i_PUBKEY(out: *mut *mut Key, input: *mut *const u8, len: c_long) -> *mut Key;
    pub fn EVP_PKEY_free(key: *mut Key);
    pub fn X509_check_issued(issuer: *const Certificate, subject: *const Certificate) -> c_int;
    pub fn X509_verify(cert: *const Certificate, key: *mut Key) -> c_int;
    pub fn X509_check_host(
        cert: *const Certificate,
        name: *const c_char,
        len: usize,
        flags: c_uint,
        peer: *mut *mut c_char,
    ) -> c_int;
    pub fn X509_check_email(
        cert: *const Certificate,
        name: *const c_char,
        len: usize,
        flags: c_uint,
    ) -> c_int;
    pub fn X509_check_ip(
        cert: *const Certificate,
        ip: *const u8,
        len: usize,
        flags: c_uint,
    ) -> c_int;
    pub fn OPENSSL_free(ptr: *mut c_void);
    pub fn ERR_clear_error();
}
