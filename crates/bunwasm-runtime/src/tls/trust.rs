use super::owned::{self, Kind, Meter, Owned};
use super::{Failure, Result};
use bunwasm_crypto_sys::tls as ffi;
#[cfg(any(target_os = "wasi", test))]
use std::fs::File;
#[cfg(any(target_os = "wasi", test))]
use std::io::{Read, Result as IoResult};
use std::rc::Rc;

pub const BUNDLE: &[u8] = include_bytes!("../../data/tls-roots.der");
pub const ROOT_COUNT: usize = 121;
pub const MAX_MATERIAL: usize = 1024 * 1024;
pub const MAX_CERTIFICATES: usize = 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum StartupExtras {
    Absent,
    #[cfg(any(target_os = "wasi", test))]
    Bytes(Vec<u8>),
    #[cfg(any(target_os = "wasi", test))]
    Unavailable,
}

enum Extras {
    Pending(StartupExtras),
    Parsed(Vec<Owned<ffi::Certificate>>),
}

pub struct Trust {
    bundled: Option<Owned<ffi::X509LazyCertSet>>,
    extras: Extras,
    warning: bool,
    meter: Rc<Meter>,
}

pub fn snapshot_startup_extras() -> StartupExtras {
    #[cfg(not(target_os = "wasi"))]
    {
        StartupExtras::Absent
    }
    #[cfg(target_os = "wasi")]
    {
        let Some(path) = std::env::var_os("NODE_EXTRA_CA_CERTS") else {
            return StartupExtras::Absent;
        };
        let Some(path) = path.to_str() else {
            return StartupExtras::Unavailable;
        };
        snapshot_file(std::path::Path::new(path))
    }
}

#[cfg(any(target_os = "wasi", test))]
pub(super) fn snapshot_file(path: &std::path::Path) -> StartupExtras {
    let Ok(file) = File::open(path) else {
        return StartupExtras::Unavailable;
    };
    match read_bounded(file) {
        Ok(bytes) => StartupExtras::Bytes(bytes),
        Err(_) => StartupExtras::Unavailable,
    }
}

#[cfg(any(target_os = "wasi", test))]
fn read_bounded(mut file: File) -> IoResult<Vec<u8>> {
    let mut bytes = Vec::new();
    file.by_ref()
        .take(MAX_MATERIAL as u64)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

impl Trust {
    // The embedding process supplies startup-snapshotted guest bytes, never a path.
    pub fn new(extras: StartupExtras, meter: &Rc<Meter>) -> Self {
        let extras = match extras {
            #[cfg(any(target_os = "wasi", test))]
            StartupExtras::Bytes(bytes) if bytes.len() > MAX_MATERIAL => StartupExtras::Unavailable,
            other => other,
        };
        Self {
            bundled: None,
            extras: Extras::Pending(extras),
            warning: false,
            meter: meter.clone(),
        }
    }

    pub fn dispose(&mut self) {
        self.bundled = None;
        self.extras = Extras::Parsed(Vec::new());
        self.warning = false;
    }

    pub fn take_warning(&mut self) -> Option<&'static str> {
        if !std::mem::take(&mut self.warning) {
            return None;
        }
        Some("Ignoring unavailable or invalid guest NODE_EXTRA_CA_CERTS snapshot")
    }

    pub fn defaults(&mut self, store: *mut ffi::X509Store) -> Result<()> {
        self.initialize_bundle()?;
        self.initialize_extras();
        let set = self.bundled.as_ref().expect("initialized bundle");
        owned::checked(
            || unsafe { ffi::X509_STORE_add_lazy_cert_set(store, set.pointer()) },
            "ERR_TLS_TRUST",
            "Unable to install bundled TLS roots",
        )?;
        let Extras::Parsed(certificates) = &self.extras else {
            unreachable!()
        };
        add_certificates(store, certificates)
    }

    fn initialize_bundle(&mut self) -> Result<()> {
        if self.bundled.is_some() {
            return Ok(());
        }
        let slices = bundle_slices(BUNDLE)?;
        let pointers: Vec<_> = slices.iter().map(|der| der.as_ptr()).collect();
        let lengths: Vec<_> = slices.iter().map(|der| der.len()).collect();
        let set = owned::allocated(
            || unsafe {
                ffi::X509_LAZY_CERT_SET_new_static(
                    pointers.as_ptr(),
                    lengths.as_ptr(),
                    slices.len(),
                )
            },
            ffi::X509_LAZY_CERT_SET_free,
            Kind::RootSet,
            &self.meter,
        )?;
        self.bundled = Some(set);
        Ok(())
    }

    fn initialize_extras(&mut self) {
        if matches!(self.extras, Extras::Parsed(_)) {
            return;
        }
        let Extras::Pending(snapshot) =
            std::mem::replace(&mut self.extras, Extras::Parsed(Vec::new()))
        else {
            unreachable!()
        };
        let result = match snapshot {
            StartupExtras::Absent => Ok(Vec::new()),
            #[cfg(any(target_os = "wasi", test))]
            StartupExtras::Bytes(bytes) => certificates(&bytes, &self.meter),
            #[cfg(any(target_os = "wasi", test))]
            StartupExtras::Unavailable => Err(invalid_material()),
        };
        match result {
            Ok(certificates) => self.extras = Extras::Parsed(certificates),
            Err(_) => self.warning = true,
        }
    }
}

pub fn invalid_material() -> Failure {
    Failure::new("ERR_TLS_CERTIFICATE", "Invalid TLS certificate material")
}

fn u32_at(bytes: &[u8], offset: usize) -> Result<usize> {
    let word: [u8; 4] = bytes
        .get(offset..offset + 4)
        .ok_or_else(invalid_material)?
        .try_into()
        .map_err(|_| invalid_material())?;
    Ok(u32::from_le_bytes(word) as usize)
}

pub fn bundle_slices(bytes: &[u8]) -> Result<Vec<&[u8]>> {
    let count = u32_at(bytes, 0)?;
    if count != ROOT_COUNT {
        return Err(invalid_material());
    }
    let header = 4 + 4 * (count + 1);
    let payload = bytes.get(header..).ok_or_else(invalid_material)?;
    if u32_at(bytes, 4)? != 0 || u32_at(bytes, 4 * (count + 1))? != payload.len() {
        return Err(invalid_material());
    }
    let mut output = Vec::with_capacity(count);
    for index in 0..count {
        let start = u32_at(bytes, 4 * (index + 1))?;
        let end = u32_at(bytes, 4 * (index + 2))?;
        if start >= end {
            return Err(invalid_material());
        }
        let der = payload.get(start..end).ok_or_else(invalid_material)?;
        if der.first() != Some(&0x30) {
            return Err(invalid_material());
        }
        output.push(der);
    }
    Ok(output)
}

pub fn certificates(input: &[u8], meter: &Rc<Meter>) -> Result<Vec<Owned<ffi::Certificate>>> {
    if input.is_empty() || input.len() > MAX_MATERIAL {
        return Err(invalid_material());
    }
    if !input.starts_with(b"-----") && input.first() == Some(&0x30) {
        return Ok(vec![der_certificate(input, meter)?]);
    }
    let blocks = pem_certificates(input)?;
    blocks
        .into_iter()
        .map(|block| pem_certificate(block, meter))
        .collect()
}

fn pem_certificates(input: &[u8]) -> Result<Vec<&[u8]>> {
    let text = std::str::from_utf8(input).map_err(|_| invalid_material())?;
    let mut rest = text.trim();
    let mut blocks = Vec::new();
    while !rest.is_empty() {
        if blocks.len() == MAX_CERTIFICATES {
            return Err(invalid_material());
        }
        let (block, tail) = certificate_block(rest)?;
        blocks.push(block.as_bytes());
        rest = tail.trim_start();
    }
    if blocks.is_empty() {
        return Err(invalid_material());
    }
    Ok(blocks)
}

fn certificate_block(text: &str) -> Result<(&str, &str)> {
    let label = if text.starts_with("-----BEGIN CERTIFICATE-----") {
        "CERTIFICATE"
    } else if text.starts_with("-----BEGIN X509 CERTIFICATE-----") {
        "X509 CERTIFICATE"
    } else {
        return Err(invalid_material());
    };
    let end = format!("-----END {label}-----");
    let offset = text.find(&end).ok_or_else(invalid_material)? + end.len();
    Ok(text.split_at(offset))
}

pub fn memory_bio(input: &[u8], meter: &Rc<Meter>) -> Result<Owned<ffi::Bio>> {
    let length = input.len().try_into().map_err(|_| invalid_material())?;
    owned::clear();
    let raw = unsafe { ffi::BIO_new_mem_buf(input.as_ptr().cast(), length) };
    let errors = owned::capture();
    owned::bio(raw, meter).map_err(|failure| failure.errors(errors))
}

fn pem_certificate(input: &[u8], meter: &Rc<Meter>) -> Result<Owned<ffi::Certificate>> {
    let der = pem_der(input, meter)?;
    der_certificate(der.bytes(), meter)
}

pub struct PemDer {
    name: *mut std::ffi::c_char,
    header: *mut std::ffi::c_char,
    data: *mut u8,
    length: usize,
}

impl PemDer {
    pub fn bytes(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.data, self.length) }
    }
}

impl Drop for PemDer {
    fn drop(&mut self) {
        unsafe {
            if !self.data.is_null() {
                ffi::OPENSSL_cleanse(self.data.cast(), self.length);
            }
            ffi::OPENSSL_free(self.data.cast());
            ffi::OPENSSL_free(self.name.cast());
            ffi::OPENSSL_free(self.header.cast());
        }
    }
}

pub fn pem_der(input: &[u8], meter: &Rc<Meter>) -> Result<PemDer> {
    let bio = memory_bio(input, meter)?;
    let mut decoded = PemDer {
        name: std::ptr::null_mut(),
        header: std::ptr::null_mut(),
        data: std::ptr::null_mut(),
        length: 0,
    };
    let mut length = 0;
    owned::checked(
        || unsafe {
            ffi::PEM_read_bio(
                bio.pointer(),
                &mut decoded.name,
                &mut decoded.header,
                &mut decoded.data,
                &mut length,
            )
        },
        "ERR_TLS_CERTIFICATE",
        "Invalid TLS PEM material",
    )?;
    decoded.length = usize::try_from(length).map_err(|_| invalid_material())?;
    if decoded.data.is_null()
        || decoded.name.is_null()
        || decoded.header.is_null()
        || decoded.length == 0
        || decoded.length > MAX_MATERIAL
    {
        return Err(invalid_material());
    }
    if unsafe { *decoded.header } != 0 {
        return Err(invalid_material());
    }
    Ok(decoded)
}

pub fn der_certificate(input: &[u8], meter: &Rc<Meter>) -> Result<Owned<ffi::Certificate>> {
    let length = input.len().try_into().map_err(|_| invalid_material())?;
    let mut cursor = input.as_ptr();
    let certificate = owned::allocated(
        || unsafe { ffi::d2i_X509(std::ptr::null_mut(), &mut cursor, length) },
        ffi::X509_free,
        Kind::Certificate,
        meter,
    )?;
    if cursor != input.as_ptr().wrapping_add(input.len()) {
        return Err(invalid_material());
    }
    Ok(certificate)
}

pub fn add_certificates(
    store: *mut ffi::X509Store,
    certificates: &[Owned<ffi::Certificate>],
) -> Result<()> {
    for certificate in certificates {
        owned::checked(
            || unsafe { ffi::X509_STORE_add_cert(store, certificate.pointer()) },
            "ERR_TLS_TRUST",
            "Unable to install TLS trust certificate",
        )?;
    }
    Ok(())
}
