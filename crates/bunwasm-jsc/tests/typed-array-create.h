/*
 * Copyright (C) 2013-2023 Apple Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY APPLE INC. ``AS IS'' AND ANY
 * EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
 * PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL APPLE INC. OR
 * CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
 * EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
 * PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 * PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY
 * OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

#pragma once

#include "Error.h"
#include "ExceptionHelpers.h"
#include "GenericTypedArrayViewInlines.h"
#include "JSArrayBuffer.h"
#include "JSArrayBufferViewInlines.h"
#include "JSCellInlines.h"
#include "JSGenericTypedArrayView.h"
#include "JSGenericTypedArrayViewInlinesLight.h"
#include "ToNativeFromValue.h"
#include "TypeError.h"
#include "TypedArrays.h"
#include <JavaScriptCore/JSGenericTypedArrayViewConstructor.h>
#include <wtf/CheckedArithmetic.h>
#include <wtf/SIMDHelpers.h>
#include <wtf/text/MakeString.h>

WTF_ALLOW_UNSAFE_BUFFER_USAGE_BEGIN

namespace JSC {

template<typename Adaptor>
JSGenericTypedArrayView<Adaptor>::JSGenericTypedArrayView(
    VM& vm, ConstructionContext& context)
    : Base(vm, context)
{
}

template<typename Adaptor>
JSGenericTypedArrayView<Adaptor>* JSGenericTypedArrayView<Adaptor>::create(
    JSGlobalObject* globalObject, Structure* structure, size_t length)
{
    VM& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    ConstructionContext context(vm, structure, length, sizeof(typename Adaptor::Type));
    if (!context) {
        throwOutOfMemoryError(globalObject, scope);
        return nullptr;
    }
    JSGenericTypedArrayView* result =
        new (NotNull, allocateCell<JSGenericTypedArrayView>(vm))
        JSGenericTypedArrayView(vm, context);
    result->finishCreation(vm);
    return result;
}
