use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::fs::{self, ReadDir};
use std::path::PathBuf;
use std::rc::Rc;

use crate::engine::{NativeError, NativeResult, Val};
use crate::natives::{Table, io_error};

struct Cursor {
    current: Option<ReadDir>,
    absolute: PathBuf,
    path: String,
    pending: VecDeque<(PathBuf, String)>,
    recursive: bool,
}

impl Cursor {
    fn advance(&mut self) -> Result<bool, NativeError> {
        self.current = None;
        let Some((absolute, path)) = self.pending.pop_front() else {
            return Ok(false);
        };
        let entries =
            fs::read_dir(&absolute).map_err(|err| io_error(err, "opendir", Some(&path)))?;
        self.current = Some(entries);
        self.absolute = absolute;
        self.path = path;
        Ok(true)
    }

    fn next(&mut self) -> Result<Option<Val>, NativeError> {
        loop {
            let entry = self.current.as_mut().and_then(Iterator::next);
            if let Some(entry) = entry {
                return self
                    .entry(entry.map_err(|err| io_error(err, "readdir", Some(&self.path)))?)
                    .map(Some);
            }
            if !self.advance()? {
                return Ok(None);
            }
        }
    }

    fn read(&mut self, size: usize) -> NativeResult {
        let mut entries = Vec::new();
        for _ in 0..size {
            let Some(entry) = self.next()? else { break };
            entries.push(entry);
        }
        Ok(Val::Array(entries))
    }

    fn entry(&mut self, entry: fs::DirEntry) -> Result<Val, NativeError> {
        let name = entry.file_name();
        let file_type = entry
            .file_type()
            .map_err(|err| io_error(err, "readdir", Some(&self.path)))?;
        if self.recursive && file_type.is_dir() {
            let path = PathBuf::from(&self.path)
                .join(&name)
                .to_string_lossy()
                .into_owned();
            self.pending.push_back((self.absolute.join(&name), path));
        }
        let kind = if file_type.is_dir() {
            "dir"
        } else if file_type.is_symlink() {
            "symlink"
        } else if file_type.is_file() {
            "file"
        } else {
            "other"
        };
        Ok(Val::Array(vec![
            Val::Bytes(name.as_encoded_bytes().to_vec()),
            kind.into(),
            self.path.clone().into(),
        ]))
    }
}

#[derive(Default)]
struct Directories {
    next: i32,
    cursors: HashMap<i32, Cursor>,
}

impl Directories {
    fn close_all(&mut self) {
        self.cursors.clear();
    }
}

fn closed() -> NativeError {
    NativeError::error("Directory handle was closed").prop("code", "ERR_DIR_CLOSED")
}

pub(crate) fn install(table: &mut Table) {
    let directories = Rc::new(RefCell::new(Directories::default()));
    let state = directories.clone();
    table.add("opendir", move |args| {
        let absolute = args.str(0)?;
        let path = args.str(1)?;
        let current = fs::read_dir(absolute).map_err(|err| io_error(err, "opendir", Some(path)))?;
        let cursor = Cursor {
            current: Some(current),
            absolute: PathBuf::from(absolute),
            path: path.to_owned(),
            pending: VecDeque::new(),
            recursive: args.bool(2),
        };
        let mut state = state.borrow_mut();
        let id = state.next;
        state.next += 1;
        state.cursors.insert(id, cursor);
        Ok(id.into())
    });
    let state = directories.clone();
    table.add("readDir", move |args| {
        let mut state = state.borrow_mut();
        let cursor = state.cursors.get_mut(&args.i32(0)?).ok_or_else(closed)?;
        cursor.read(args.num(1)? as usize)
    });
    let state = directories.clone();
    table.add("closeDir", move |args| {
        state
            .borrow_mut()
            .cursors
            .remove(&args.i32(0)?)
            .ok_or_else(closed)?;
        Ok(Val::Undefined)
    });
    let state = directories.clone();
    table.add("closeAllDirs", move |_| {
        state.borrow_mut().close_all();
        Ok(Val::Undefined)
    });
    let state = directories;
    table.add("directoryCount", move |_| {
        Ok((state.borrow().cursors.len() as f64).into())
    });
}
