//! Session recording container.
//!
//! Layout of a `.hbr` file:
//!
//! ```text
//! magic   8 bytes  "HFTREC01"
//! hlen    u32 LE   length of the JSON header in bytes
//! header  JSON     { "meta": {...}, "arrays": [ {name, dtype, shape, offset, length}, ... ] }
//! pad     0..7     zero bytes so that the data block starts 8-byte aligned
//! data    raw little-endian arrays, each starting 8-byte aligned
//! ```
//!
//! `offset` is relative to the start of the data block. `dtype` is one of
//! `f64 f32 i32 u32 i8 u8`. Everything is little-endian.

use std::{fs::File, io::Write, path::Path};

use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
struct ArrayDesc {
    name: String,
    dtype: &'static str,
    shape: Vec<usize>,
    offset: usize,
    length: usize,
}

#[derive(Default)]
pub struct Recording {
    data: Vec<u8>,
    arrays: Vec<ArrayDesc>,
}

impl Recording {
    fn align(&mut self) {
        while self.data.len() % 8 != 0 {
            self.data.push(0);
        }
    }

    fn add_bytes(&mut self, name: &str, dtype: &'static str, shape: Vec<usize>, bytes: &[u8]) {
        self.align();
        self.arrays.push(ArrayDesc {
            name: name.to_string(),
            dtype,
            shape,
            offset: self.data.len(),
            length: bytes.len(),
        });
        self.data.extend_from_slice(bytes);
    }

    pub fn f64(&mut self, name: &str, v: &[f64], cols: usize) {
        let bytes: Vec<u8> = v.iter().flat_map(|x| x.to_le_bytes()).collect();
        self.add_bytes(name, "f64", shape(v.len(), cols), &bytes);
    }

    pub fn f32(&mut self, name: &str, v: &[f32], cols: usize) {
        let bytes: Vec<u8> = v.iter().flat_map(|x| x.to_le_bytes()).collect();
        self.add_bytes(name, "f32", shape(v.len(), cols), &bytes);
    }

    pub fn i32(&mut self, name: &str, v: &[i32], cols: usize) {
        let bytes: Vec<u8> = v.iter().flat_map(|x| x.to_le_bytes()).collect();
        self.add_bytes(name, "i32", shape(v.len(), cols), &bytes);
    }

    pub fn u32(&mut self, name: &str, v: &[u32], cols: usize) {
        let bytes: Vec<u8> = v.iter().flat_map(|x| x.to_le_bytes()).collect();
        self.add_bytes(name, "u32", shape(v.len(), cols), &bytes);
    }

    pub fn i8(&mut self, name: &str, v: &[i8], cols: usize) {
        let bytes: Vec<u8> = v.iter().map(|x| *x as u8).collect();
        self.add_bytes(name, "i8", shape(v.len(), cols), &bytes);
    }

    pub fn u8(&mut self, name: &str, v: &[u8], cols: usize) {
        self.add_bytes(name, "u8", shape(v.len(), cols), v);
    }

    pub fn write(&self, path: &Path, meta: Value) -> std::io::Result<()> {
        let header = serde_json::json!({ "meta": meta, "arrays": self.arrays });
        let header = serde_json::to_vec(&header)?;
        let mut f = File::create(path)?;
        f.write_all(b"HFTREC01")?;
        f.write_all(&(header.len() as u32).to_le_bytes())?;
        f.write_all(&header)?;
        let written = 8 + 4 + header.len();
        let pad = (8 - written % 8) % 8;
        f.write_all(&vec![0u8; pad])?;
        f.write_all(&self.data)?;
        Ok(())
    }
}

fn shape(len: usize, cols: usize) -> Vec<usize> {
    if cols <= 1 {
        vec![len]
    } else {
        vec![len / cols, cols]
    }
}
