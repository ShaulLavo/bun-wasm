use super::{Failure, Result};

const SLOT_BITS: u32 = 20;
const SLOT_MASK: u64 = (1 << SLOT_BITS) - 1;
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContextId(u64);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConnectionId(u64);

pub trait ObjectId: Copy {
    const TAG: u64;
    fn raw(self) -> u64;
    fn from_raw(raw: u64) -> Self;
}

macro_rules! object_id {
    ($name:ident, $tag:literal) => {
        impl ObjectId for $name {
            const TAG: u64 = $tag;
            fn raw(self) -> u64 {
                self.0
            }
            fn from_raw(raw: u64) -> Self {
                Self(raw)
            }
        }
        impl $name {
            pub fn number(self) -> f64 {
                self.0 as f64
            }
            pub fn parse(number: f64) -> Result<Self> {
                if !number.is_finite()
                    || number.fract() != 0.0
                    || number < 0.0
                    || number > MAX_SAFE_INTEGER as f64
                {
                    return Err(Failure::invalid_id());
                }
                let id = Self(number as u64);
                decode(id)?;
                Ok(id)
            }
        }
    };
}
object_id!(ContextId, 0);
object_id!(ConnectionId, 1);

fn decode<I: ObjectId>(id: I) -> Result<(usize, u32)> {
    let raw = id.raw();
    let generation = (raw >> (SLOT_BITS + 1)) as u32;
    if raw > MAX_SAFE_INTEGER || raw & 1 != I::TAG || generation == 0 {
        return Err(Failure::invalid_id());
    }
    Ok((((raw >> 1) & SLOT_MASK) as usize, generation))
}

struct Slot<T> {
    generation: u32,
    value: Option<T>,
}

pub struct Slots<T, I> {
    slots: Vec<Slot<T>>,
    limit: usize,
    marker: std::marker::PhantomData<I>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Release {
    Released,
    AlreadyReleased,
}

impl<T, I: ObjectId> Slots<T, I> {
    pub fn new(limit: usize) -> Self {
        assert!(limit <= (1 << SLOT_BITS));
        Self {
            slots: Vec::new(),
            limit,
            marker: std::marker::PhantomData,
        }
    }

    pub fn insert(&mut self, value: T) -> Result<I> {
        let vacant = self
            .slots
            .iter()
            .position(|slot| slot.value.is_none() && slot.generation < u32::MAX);
        let index = match vacant {
            Some(index) => index,
            None if self.slots.len() < self.limit => {
                self.slots.push(Slot {
                    generation: 0,
                    value: None,
                });
                self.slots.len() - 1
            }
            None => {
                return Err(Failure::new(
                    "ERR_TLS_CAPACITY",
                    "TLS object slots exhausted",
                ));
            }
        };
        let slot = &mut self.slots[index];
        slot.generation = slot
            .generation
            .checked_add(1)
            .ok_or_else(|| Failure::new("ERR_TLS_CAPACITY", "TLS generation exhausted"))?;
        slot.value = Some(value);
        Ok(I::from_raw(
            (u64::from(slot.generation) << (SLOT_BITS + 1)) | ((index as u64) << 1) | I::TAG,
        ))
    }

    pub fn get(&self, id: I) -> Result<&T> {
        let (index, generation) = decode(id)?;
        self.slots
            .get(index)
            .filter(|slot| slot.generation == generation)
            .and_then(|slot| slot.value.as_ref())
            .ok_or_else(Failure::invalid_id)
    }

    pub fn get_mut(&mut self, id: I) -> Result<&mut T> {
        let (index, generation) = decode(id)?;
        self.slots
            .get_mut(index)
            .filter(|slot| slot.generation == generation)
            .and_then(|slot| slot.value.as_mut())
            .ok_or_else(Failure::invalid_id)
    }

    pub fn release(&mut self, id: I) -> Result<Release> {
        let (index, generation) = decode(id)?;
        let slot = self.slots.get_mut(index).ok_or_else(Failure::invalid_id)?;
        if generation > slot.generation {
            return Err(Failure::invalid_id());
        }
        if generation < slot.generation || slot.value.is_none() {
            return Ok(Release::AlreadyReleased);
        }
        drop(slot.value.take());
        Ok(Release::Released)
    }

    pub fn clear(&mut self) {
        for slot in &mut self.slots {
            slot.value.take();
        }
    }

    pub fn len(&self) -> usize {
        self.slots
            .iter()
            .filter(|slot| slot.value.is_some())
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;

    struct Counted(Rc<Cell<usize>>);
    impl Drop for Counted {
        fn drop(&mut self) {
            self.0.set(self.0.get() + 1);
        }
    }

    #[test]
    fn retired_release_never_closes_reused_slot() {
        let drops = Rc::new(Cell::new(0));
        let mut slots = Slots::<_, ConnectionId>::new(1);
        let first = slots.insert(Counted(drops.clone())).unwrap();
        assert_eq!(slots.release(first).unwrap(), Release::Released);
        let second = slots.insert(Counted(drops.clone())).unwrap();
        assert_ne!(first, second);
        assert_eq!(slots.release(first).unwrap(), Release::AlreadyReleased);
        assert!(slots.get(first).is_err());
        assert!(slots.get(second).is_ok());
        assert_eq!(drops.get(), 1);
        drop(slots);
        assert_eq!(drops.get(), 2);
    }

    #[test]
    fn generation_exhaustion_does_not_wrap() {
        let mut slots = Slots::<_, ContextId>::new(1);
        let first = slots.insert(()).unwrap();
        slots.slots[0].generation = u32::MAX;
        slots.slots[0].value = None;
        assert!(slots.insert(()).is_err());
        assert_eq!(slots.slots[0].generation, u32::MAX);
        assert_eq!(slots.release(first).unwrap(), Release::AlreadyReleased);
    }

    #[test]
    fn ids_are_safe_tagged_integers() {
        let mut contexts = Slots::<_, ContextId>::new(1);
        let id = contexts.insert(()).unwrap();
        assert_eq!(ContextId::parse(id.number()).unwrap(), id);
        assert!(ConnectionId::parse(id.number()).is_err());
        for invalid in [f64::NAN, f64::INFINITY, -1.0, 0.5, 0.0, (1u64 << 53) as f64] {
            assert!(ContextId::parse(invalid).is_err());
        }
    }
}
