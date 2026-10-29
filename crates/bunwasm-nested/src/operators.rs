use crate::CompileError;
use wasmparser::Operator as O;

/// Stack shape of a memory access below its address operand.
#[derive(Clone, Copy)]
pub(crate) enum Shape {
    /// `[addr]`
    Load,
    /// `[addr, v]`, v saved in the given scratch local
    Value(u32),
    /// `[addr, a, b]`, saved in the two scratch locals
    Two(u32, u32),
}

pub(crate) fn shape(op: &O) -> Option<(wasmparser::MemArg, Shape)> {
    use Shape::*;
    let (m, s) = match *op {
        O::I32Load { memarg }
        | O::I64Load { memarg }
        | O::F32Load { memarg }
        | O::F64Load { memarg }
        | O::I32Load8S { memarg }
        | O::I32Load8U { memarg }
        | O::I32Load16S { memarg }
        | O::I32Load16U { memarg }
        | O::I64Load8S { memarg }
        | O::I64Load8U { memarg }
        | O::I64Load16S { memarg }
        | O::I64Load16U { memarg }
        | O::I64Load32S { memarg }
        | O::I64Load32U { memarg }
        | O::V128Load { memarg }
        | O::V128Load8x8S { memarg }
        | O::V128Load8x8U { memarg }
        | O::V128Load16x4S { memarg }
        | O::V128Load16x4U { memarg }
        | O::V128Load32x2S { memarg }
        | O::V128Load32x2U { memarg }
        | O::V128Load8Splat { memarg }
        | O::V128Load16Splat { memarg }
        | O::V128Load32Splat { memarg }
        | O::V128Load64Splat { memarg }
        | O::V128Load32Zero { memarg }
        | O::V128Load64Zero { memarg }
        | O::I32AtomicLoad { memarg }
        | O::I64AtomicLoad { memarg }
        | O::I32AtomicLoad8U { memarg }
        | O::I32AtomicLoad16U { memarg }
        | O::I64AtomicLoad8U { memarg }
        | O::I64AtomicLoad16U { memarg }
        | O::I64AtomicLoad32U { memarg } => (memarg, Load),
        O::I32Store { memarg }
        | O::I32Store8 { memarg }
        | O::I32Store16 { memarg }
        | O::I32AtomicStore { memarg }
        | O::I32AtomicStore8 { memarg }
        | O::I32AtomicStore16 { memarg }
        | O::MemoryAtomicNotify { memarg } => (memarg, Value(2)),
        O::I64Store { memarg }
        | O::I64Store8 { memarg }
        | O::I64Store16 { memarg }
        | O::I64Store32 { memarg }
        | O::I64AtomicStore { memarg }
        | O::I64AtomicStore8 { memarg }
        | O::I64AtomicStore16 { memarg }
        | O::I64AtomicStore32 { memarg } => (memarg, Value(4)),
        O::F32Store { memarg } => (memarg, Value(6)),
        O::F64Store { memarg } => (memarg, Value(7)),
        O::V128Store { memarg } => (memarg, Value(8)),
        O::V128Load8Lane { memarg, .. }
        | O::V128Load16Lane { memarg, .. }
        | O::V128Load32Lane { memarg, .. }
        | O::V128Load64Lane { memarg, .. }
        | O::V128Store8Lane { memarg, .. }
        | O::V128Store16Lane { memarg, .. }
        | O::V128Store32Lane { memarg, .. }
        | O::V128Store64Lane { memarg, .. } => (memarg, Value(8)),
        O::MemoryAtomicWait32 { memarg } => (memarg, Two(2, 4)),
        O::MemoryAtomicWait64 { memarg } => (memarg, Two(4, 5)),
        _ => return rmw(op),
    };
    Some((m, s))
}

fn rmw(op: &O) -> Option<(wasmparser::MemArg, Shape)> {
    use Shape::*;
    let (m, s) = match *op {
        O::I32AtomicRmwAdd { memarg }
        | O::I32AtomicRmw8AddU { memarg }
        | O::I32AtomicRmw16AddU { memarg }
        | O::I32AtomicRmwSub { memarg }
        | O::I32AtomicRmw8SubU { memarg }
        | O::I32AtomicRmw16SubU { memarg }
        | O::I32AtomicRmwAnd { memarg }
        | O::I32AtomicRmw8AndU { memarg }
        | O::I32AtomicRmw16AndU { memarg }
        | O::I32AtomicRmwOr { memarg }
        | O::I32AtomicRmw8OrU { memarg }
        | O::I32AtomicRmw16OrU { memarg }
        | O::I32AtomicRmwXor { memarg }
        | O::I32AtomicRmw8XorU { memarg }
        | O::I32AtomicRmw16XorU { memarg }
        | O::I32AtomicRmwXchg { memarg }
        | O::I32AtomicRmw8XchgU { memarg }
        | O::I32AtomicRmw16XchgU { memarg } => (memarg, Value(2)),
        O::I64AtomicRmwAdd { memarg }
        | O::I64AtomicRmw8AddU { memarg }
        | O::I64AtomicRmw16AddU { memarg }
        | O::I64AtomicRmw32AddU { memarg }
        | O::I64AtomicRmwSub { memarg }
        | O::I64AtomicRmw8SubU { memarg }
        | O::I64AtomicRmw16SubU { memarg }
        | O::I64AtomicRmw32SubU { memarg }
        | O::I64AtomicRmwAnd { memarg }
        | O::I64AtomicRmw8AndU { memarg }
        | O::I64AtomicRmw16AndU { memarg }
        | O::I64AtomicRmw32AndU { memarg }
        | O::I64AtomicRmwOr { memarg }
        | O::I64AtomicRmw8OrU { memarg }
        | O::I64AtomicRmw16OrU { memarg }
        | O::I64AtomicRmw32OrU { memarg }
        | O::I64AtomicRmwXor { memarg }
        | O::I64AtomicRmw8XorU { memarg }
        | O::I64AtomicRmw16XorU { memarg }
        | O::I64AtomicRmw32XorU { memarg }
        | O::I64AtomicRmwXchg { memarg }
        | O::I64AtomicRmw8XchgU { memarg }
        | O::I64AtomicRmw16XchgU { memarg }
        | O::I64AtomicRmw32XchgU { memarg } => (memarg, Value(4)),
        O::I32AtomicRmwCmpxchg { memarg }
        | O::I32AtomicRmw8CmpxchgU { memarg }
        | O::I32AtomicRmw16CmpxchgU { memarg } => (memarg, Two(2, 3)),
        O::I64AtomicRmwCmpxchg { memarg }
        | O::I64AtomicRmw8CmpxchgU { memarg }
        | O::I64AtomicRmw16CmpxchgU { memarg }
        | O::I64AtomicRmw32CmpxchgU { memarg } => (memarg, Two(4, 5)),
        _ => return None,
    };
    Some((m, s))
}

pub(crate) fn admit(op: &O<'_>) -> Result<(), CompileError> {
    if shape(op).is_some()
        || matches!(
            op,
            O::MemorySize { mem: 0 }
                | O::MemoryGrow { mem: 0 }
                | O::MemoryFill { mem: 0 }
                | O::MemoryCopy {
                    dst_mem: 0,
                    src_mem: 0
                }
                | O::MemoryInit { mem: 0, .. }
        )
    {
        return Ok(());
    }
    if plain(op) {
        return Ok(());
    }
    Err(CompileError::unsupported(format!("operator {op:?}")))
}

fn plain(op: &O<'_>) -> bool {
    matches!(
        op,
        O::Unreachable { .. }
            | O::Nop { .. }
            | O::Block { .. }
            | O::Loop { .. }
            | O::If { .. }
            | O::Else { .. }
            | O::End { .. }
            | O::Br { .. }
            | O::BrIf { .. }
            | O::BrTable { .. }
            | O::Return { .. }
            | O::Call { .. }
            | O::CallIndirect { .. }
            | O::Drop { .. }
            | O::Select { .. }
            | O::LocalGet { .. }
            | O::LocalSet { .. }
            | O::LocalTee { .. }
            | O::GlobalGet { .. }
            | O::GlobalSet { .. }
            | O::I32Const { .. }
            | O::I64Const { .. }
            | O::F32Const { .. }
            | O::F64Const { .. }
            | O::I32Eqz { .. }
            | O::I32Eq { .. }
            | O::I32Ne { .. }
            | O::I32LtS { .. }
            | O::I32LtU { .. }
            | O::I32GtS { .. }
            | O::I32GtU { .. }
            | O::I32LeS { .. }
            | O::I32LeU { .. }
            | O::I32GeS { .. }
            | O::I32GeU { .. }
            | O::I64Eqz { .. }
            | O::I64Eq { .. }
            | O::I64Ne { .. }
            | O::I64LtS { .. }
            | O::I64LtU { .. }
            | O::I64GtS { .. }
            | O::I64GtU { .. }
            | O::I64LeS { .. }
            | O::I64LeU { .. }
            | O::I64GeS { .. }
            | O::I64GeU { .. }
            | O::F32Eq { .. }
            | O::F32Ne { .. }
            | O::F32Lt { .. }
            | O::F32Gt { .. }
            | O::F32Le { .. }
            | O::F32Ge { .. }
            | O::F64Eq { .. }
            | O::F64Ne { .. }
            | O::F64Lt { .. }
            | O::F64Gt { .. }
            | O::F64Le { .. }
            | O::F64Ge { .. }
            | O::I32Clz { .. }
            | O::I32Ctz { .. }
            | O::I32Popcnt { .. }
            | O::I32Add { .. }
            | O::I32Sub { .. }
            | O::I32Mul { .. }
            | O::I32DivS { .. }
            | O::I32DivU { .. }
            | O::I32RemS { .. }
            | O::I32RemU { .. }
            | O::I32And { .. }
            | O::I32Or { .. }
            | O::I32Xor { .. }
            | O::I32Shl { .. }
            | O::I32ShrS { .. }
            | O::I32ShrU { .. }
            | O::I32Rotl { .. }
            | O::I32Rotr { .. }
            | O::I64Clz { .. }
            | O::I64Ctz { .. }
            | O::I64Popcnt { .. }
            | O::I64Add { .. }
            | O::I64Sub { .. }
            | O::I64Mul { .. }
            | O::I64DivS { .. }
            | O::I64DivU { .. }
            | O::I64RemS { .. }
            | O::I64RemU { .. }
            | O::I64And { .. }
            | O::I64Or { .. }
            | O::I64Xor { .. }
            | O::I64Shl { .. }
            | O::I64ShrS { .. }
            | O::I64ShrU { .. }
            | O::I64Rotl { .. }
            | O::I64Rotr { .. }
            | O::F32Abs { .. }
            | O::F32Neg { .. }
            | O::F32Ceil { .. }
            | O::F32Floor { .. }
            | O::F32Trunc { .. }
            | O::F32Nearest { .. }
            | O::F32Sqrt { .. }
            | O::F32Add { .. }
            | O::F32Sub { .. }
            | O::F32Mul { .. }
            | O::F32Div { .. }
            | O::F32Min { .. }
            | O::F32Max { .. }
            | O::F32Copysign { .. }
            | O::F64Abs { .. }
            | O::F64Neg { .. }
            | O::F64Ceil { .. }
            | O::F64Floor { .. }
            | O::F64Trunc { .. }
            | O::F64Nearest { .. }
            | O::F64Sqrt { .. }
            | O::F64Add { .. }
            | O::F64Sub { .. }
            | O::F64Mul { .. }
            | O::F64Div { .. }
            | O::F64Min { .. }
            | O::F64Max { .. }
            | O::F64Copysign { .. }
            | O::I32WrapI64 { .. }
            | O::I32TruncF32S { .. }
            | O::I32TruncF32U { .. }
            | O::I32TruncF64S { .. }
            | O::I32TruncF64U { .. }
            | O::I64ExtendI32S { .. }
            | O::I64ExtendI32U { .. }
            | O::I64TruncF32S { .. }
            | O::I64TruncF32U { .. }
            | O::I64TruncF64S { .. }
            | O::I64TruncF64U { .. }
            | O::F32ConvertI32S { .. }
            | O::F32ConvertI32U { .. }
            | O::F32ConvertI64S { .. }
            | O::F32ConvertI64U { .. }
            | O::F32DemoteF64 { .. }
            | O::F64ConvertI32S { .. }
            | O::F64ConvertI32U { .. }
            | O::F64ConvertI64S { .. }
            | O::F64ConvertI64U { .. }
            | O::F64PromoteF32 { .. }
            | O::I32ReinterpretF32 { .. }
            | O::I64ReinterpretF64 { .. }
            | O::F32ReinterpretI32 { .. }
            | O::F64ReinterpretI64 { .. }
            | O::I32Extend8S { .. }
            | O::I32Extend16S { .. }
            | O::I64Extend8S { .. }
            | O::I64Extend16S { .. }
            | O::I64Extend32S { .. }
            | O::I32TruncSatF32S { .. }
            | O::I32TruncSatF32U { .. }
            | O::I32TruncSatF64S { .. }
            | O::I32TruncSatF64U { .. }
            | O::I64TruncSatF32S { .. }
            | O::I64TruncSatF32U { .. }
            | O::I64TruncSatF64S { .. }
            | O::I64TruncSatF64U { .. }
            | O::DataDrop { .. }
            | O::TableInit { .. }
            | O::ElemDrop { .. }
            | O::TableCopy { .. }
            | O::TypedSelect { .. }
            | O::RefNull { .. }
            | O::RefIsNull { .. }
            | O::RefFunc { .. }
            | O::TableFill { .. }
            | O::TableGet { .. }
            | O::TableSet { .. }
            | O::TableGrow { .. }
            | O::TableSize { .. }
            | O::ReturnCall { .. }
            | O::ReturnCallIndirect { .. }
            | O::AtomicFence { .. }
            | O::V128Const { .. }
            | O::I8x16Shuffle { .. }
            | O::I8x16ExtractLaneS { .. }
            | O::I8x16ExtractLaneU { .. }
            | O::I8x16ReplaceLane { .. }
            | O::I16x8ExtractLaneS { .. }
            | O::I16x8ExtractLaneU { .. }
            | O::I16x8ReplaceLane { .. }
            | O::I32x4ExtractLane { .. }
            | O::I32x4ReplaceLane { .. }
            | O::I64x2ExtractLane { .. }
            | O::I64x2ReplaceLane { .. }
            | O::F32x4ExtractLane { .. }
            | O::F32x4ReplaceLane { .. }
            | O::F64x2ExtractLane { .. }
            | O::F64x2ReplaceLane { .. }
            | O::I8x16Swizzle { .. }
            | O::I8x16Splat { .. }
            | O::I16x8Splat { .. }
            | O::I32x4Splat { .. }
            | O::I64x2Splat { .. }
            | O::F32x4Splat { .. }
            | O::F64x2Splat { .. }
            | O::I8x16Eq { .. }
            | O::I8x16Ne { .. }
            | O::I8x16LtS { .. }
            | O::I8x16LtU { .. }
            | O::I8x16GtS { .. }
            | O::I8x16GtU { .. }
            | O::I8x16LeS { .. }
            | O::I8x16LeU { .. }
            | O::I8x16GeS { .. }
            | O::I8x16GeU { .. }
            | O::I16x8Eq { .. }
            | O::I16x8Ne { .. }
            | O::I16x8LtS { .. }
            | O::I16x8LtU { .. }
            | O::I16x8GtS { .. }
            | O::I16x8GtU { .. }
            | O::I16x8LeS { .. }
            | O::I16x8LeU { .. }
            | O::I16x8GeS { .. }
            | O::I16x8GeU { .. }
            | O::I32x4Eq { .. }
            | O::I32x4Ne { .. }
            | O::I32x4LtS { .. }
            | O::I32x4LtU { .. }
            | O::I32x4GtS { .. }
            | O::I32x4GtU { .. }
            | O::I32x4LeS { .. }
            | O::I32x4LeU { .. }
            | O::I32x4GeS { .. }
            | O::I32x4GeU { .. }
            | O::I64x2Eq { .. }
            | O::I64x2Ne { .. }
            | O::I64x2LtS { .. }
            | O::I64x2GtS { .. }
            | O::I64x2LeS { .. }
            | O::I64x2GeS { .. }
            | O::F32x4Eq { .. }
            | O::F32x4Ne { .. }
            | O::F32x4Lt { .. }
            | O::F32x4Gt { .. }
            | O::F32x4Le { .. }
            | O::F32x4Ge { .. }
            | O::F64x2Eq { .. }
            | O::F64x2Ne { .. }
            | O::F64x2Lt { .. }
            | O::F64x2Gt { .. }
            | O::F64x2Le { .. }
            | O::F64x2Ge { .. }
            | O::V128Not { .. }
            | O::V128And { .. }
            | O::V128AndNot { .. }
            | O::V128Or { .. }
            | O::V128Xor { .. }
            | O::V128Bitselect { .. }
            | O::V128AnyTrue { .. }
            | O::I8x16Abs { .. }
            | O::I8x16Neg { .. }
            | O::I8x16Popcnt { .. }
            | O::I8x16AllTrue { .. }
            | O::I8x16Bitmask { .. }
            | O::I8x16NarrowI16x8S { .. }
            | O::I8x16NarrowI16x8U { .. }
            | O::I8x16Shl { .. }
            | O::I8x16ShrS { .. }
            | O::I8x16ShrU { .. }
            | O::I8x16Add { .. }
            | O::I8x16AddSatS { .. }
            | O::I8x16AddSatU { .. }
            | O::I8x16Sub { .. }
            | O::I8x16SubSatS { .. }
            | O::I8x16SubSatU { .. }
            | O::I8x16MinS { .. }
            | O::I8x16MinU { .. }
            | O::I8x16MaxS { .. }
            | O::I8x16MaxU { .. }
            | O::I8x16AvgrU { .. }
            | O::I16x8ExtAddPairwiseI8x16S { .. }
            | O::I16x8ExtAddPairwiseI8x16U { .. }
            | O::I16x8Abs { .. }
            | O::I16x8Neg { .. }
            | O::I16x8Q15MulrSatS { .. }
            | O::I16x8AllTrue { .. }
            | O::I16x8Bitmask { .. }
            | O::I16x8NarrowI32x4S { .. }
            | O::I16x8NarrowI32x4U { .. }
            | O::I16x8ExtendLowI8x16S { .. }
            | O::I16x8ExtendHighI8x16S { .. }
            | O::I16x8ExtendLowI8x16U { .. }
            | O::I16x8ExtendHighI8x16U { .. }
            | O::I16x8Shl { .. }
            | O::I16x8ShrS { .. }
            | O::I16x8ShrU { .. }
            | O::I16x8Add { .. }
            | O::I16x8AddSatS { .. }
            | O::I16x8AddSatU { .. }
            | O::I16x8Sub { .. }
            | O::I16x8SubSatS { .. }
            | O::I16x8SubSatU { .. }
            | O::I16x8Mul { .. }
            | O::I16x8MinS { .. }
            | O::I16x8MinU { .. }
            | O::I16x8MaxS { .. }
            | O::I16x8MaxU { .. }
            | O::I16x8AvgrU { .. }
            | O::I16x8ExtMulLowI8x16S { .. }
            | O::I16x8ExtMulHighI8x16S { .. }
            | O::I16x8ExtMulLowI8x16U { .. }
            | O::I16x8ExtMulHighI8x16U { .. }
            | O::I32x4ExtAddPairwiseI16x8S { .. }
            | O::I32x4ExtAddPairwiseI16x8U { .. }
            | O::I32x4Abs { .. }
            | O::I32x4Neg { .. }
            | O::I32x4AllTrue { .. }
            | O::I32x4Bitmask { .. }
            | O::I32x4ExtendLowI16x8S { .. }
            | O::I32x4ExtendHighI16x8S { .. }
            | O::I32x4ExtendLowI16x8U { .. }
            | O::I32x4ExtendHighI16x8U { .. }
            | O::I32x4Shl { .. }
            | O::I32x4ShrS { .. }
            | O::I32x4ShrU { .. }
            | O::I32x4Add { .. }
            | O::I32x4Sub { .. }
            | O::I32x4Mul { .. }
            | O::I32x4MinS { .. }
            | O::I32x4MinU { .. }
            | O::I32x4MaxS { .. }
            | O::I32x4MaxU { .. }
            | O::I32x4DotI16x8S { .. }
            | O::I32x4ExtMulLowI16x8S { .. }
            | O::I32x4ExtMulHighI16x8S { .. }
            | O::I32x4ExtMulLowI16x8U { .. }
            | O::I32x4ExtMulHighI16x8U { .. }
            | O::I64x2Abs { .. }
            | O::I64x2Neg { .. }
            | O::I64x2AllTrue { .. }
            | O::I64x2Bitmask { .. }
            | O::I64x2ExtendLowI32x4S { .. }
            | O::I64x2ExtendHighI32x4S { .. }
            | O::I64x2ExtendLowI32x4U { .. }
            | O::I64x2ExtendHighI32x4U { .. }
            | O::I64x2Shl { .. }
            | O::I64x2ShrS { .. }
            | O::I64x2ShrU { .. }
            | O::I64x2Add { .. }
            | O::I64x2Sub { .. }
            | O::I64x2Mul { .. }
            | O::I64x2ExtMulLowI32x4S { .. }
            | O::I64x2ExtMulHighI32x4S { .. }
            | O::I64x2ExtMulLowI32x4U { .. }
            | O::I64x2ExtMulHighI32x4U { .. }
            | O::F32x4Ceil { .. }
            | O::F32x4Floor { .. }
            | O::F32x4Trunc { .. }
            | O::F32x4Nearest { .. }
            | O::F32x4Abs { .. }
            | O::F32x4Neg { .. }
            | O::F32x4Sqrt { .. }
            | O::F32x4Add { .. }
            | O::F32x4Sub { .. }
            | O::F32x4Mul { .. }
            | O::F32x4Div { .. }
            | O::F32x4Min { .. }
            | O::F32x4Max { .. }
            | O::F32x4PMin { .. }
            | O::F32x4PMax { .. }
            | O::F64x2Ceil { .. }
            | O::F64x2Floor { .. }
            | O::F64x2Trunc { .. }
            | O::F64x2Nearest { .. }
            | O::F64x2Abs { .. }
            | O::F64x2Neg { .. }
            | O::F64x2Sqrt { .. }
            | O::F64x2Add { .. }
            | O::F64x2Sub { .. }
            | O::F64x2Mul { .. }
            | O::F64x2Div { .. }
            | O::F64x2Min { .. }
            | O::F64x2Max { .. }
            | O::F64x2PMin { .. }
            | O::F64x2PMax { .. }
            | O::I32x4TruncSatF32x4S { .. }
            | O::I32x4TruncSatF32x4U { .. }
            | O::F32x4ConvertI32x4S { .. }
            | O::F32x4ConvertI32x4U { .. }
            | O::I32x4TruncSatF64x2SZero { .. }
            | O::I32x4TruncSatF64x2UZero { .. }
            | O::F64x2ConvertLowI32x4S { .. }
            | O::F64x2ConvertLowI32x4U { .. }
            | O::F32x4DemoteF64x2Zero { .. }
            | O::F64x2PromoteLowF32x4 { .. }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_parser_memarg_has_an_explicit_access_shape() {
        let mut count = 0;
        macro_rules! check {
            ($( @$proposal:ident $op:ident $({ $($arg:ident: $argty:ty),* })? => $visit:ident ($($ann:tt)*))*) => {
                $(check!(@one $op $($($arg: $argty),*)?);)*
            };
            (@one $op:ident memarg: $argty:ty $(, $arg:ident: $ty:ty)*) => {
                let op = O::$op { memarg: wasmparser::MemArg { align: 0, max_align: 0, offset: 0, memory: 0 }, $($arg: 0),* };
                assert!(shape(&op).is_some(), "missing access shape for {}", stringify!($op));
                count += 1;
            };
            (@one $op:ident $($rest:tt)*) => {};
        }
        wasmparser::for_each_operator!(check);
        assert_eq!(
            count, 111,
            "update the independent memarg differential table when the parser changes"
        );
    }
}
