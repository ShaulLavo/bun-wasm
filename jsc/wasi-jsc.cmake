# CMake toolchain for JavaScriptCore (PORT=JSCOnly, C loop) on wasm32-wasip1 with wasi-sdk.
# Compiler flags, the shim and the link flags are passed by jsc/configure.sh.
set(WASI_SDK_PREFIX "$ENV{WASI_SDK_PATH}" CACHE PATH "wasi-sdk root")
if(NOT EXISTS "$ENV{BUN_WASM_SYSROOT}/bun-wasm-sysroot.json")
  message(FATAL_ERROR "Build the patched sysroot with scripts/build-wasi-sysroot.ts first")
endif()
set(CMAKE_SYSROOT "$ENV{BUN_WASM_SYSROOT}" CACHE PATH "Waffle patched guest sysroot" FORCE)
list(APPEND CMAKE_MODULE_PATH "${WASI_SDK_PREFIX}/share/cmake")

set(CMAKE_SYSTEM_NAME WASI)
set(CMAKE_SYSTEM_VERSION 1)
set(CMAKE_SYSTEM_PROCESSOR wasm32)
set(CMAKE_EXECUTABLE_SUFFIX .wasm)
set(triple wasm32-wasip1)

set(CMAKE_C_COMPILER ${WASI_SDK_PREFIX}/bin/clang)
set(CMAKE_CXX_COMPILER ${WASI_SDK_PREFIX}/bin/clang++)
set(CMAKE_ASM_COMPILER ${WASI_SDK_PREFIX}/bin/clang)
set(CMAKE_AR ${WASI_SDK_PREFIX}/bin/llvm-ar CACHE FILEPATH "")
set(CMAKE_RANLIB ${WASI_SDK_PREFIX}/bin/llvm-ranlib CACHE FILEPATH "")
set(CMAKE_C_COMPILER_TARGET ${triple})
set(CMAKE_CXX_COMPILER_TARGET ${triple})
set(CMAKE_ASM_COMPILER_TARGET ${triple})

# wasip1 is single-threaded: pthreads are wasi-libc's stubs, nothing extra to link.
set(CMAKE_THREAD_LIBS_INIT "")
set(CMAKE_HAVE_THREADS_LIBRARY 1)
set(CMAKE_USE_PTHREADS_INIT 1)
set(Threads_FOUND TRUE)

set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY BOTH)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE BOTH)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE BOTH)
