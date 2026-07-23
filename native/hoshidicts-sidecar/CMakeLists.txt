cmake_minimum_required(VERSION 3.22.1)
cmake_policy(SET CMP0077 NEW)

project(hayase-hoshidicts-sidecar LANGUAGES C CXX)

include(CTest)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(HOSHIDICTS_SOURCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../vendor/hoshidicts")
if(NOT EXISTS "${HOSHIDICTS_SOURCE_DIR}/CMakeLists.txt")
    message(FATAL_ERROR "Hoshidicts submodule is missing")
endif()

add_subdirectory("${HOSHIDICTS_SOURCE_DIR}" hoshidicts EXCLUDE_FROM_ALL)

# Hoshidicts embeds its kanji mapping with the C++ #embed directive, which
# MSVC does not currently support. Generate an equivalent comma-separated
# byte include and compile a build-directory copy of the one affected source
# file so the vendored submodule remains untouched.
set(HOSHIDICTS_TEXT_PROCESSOR_SOURCE
    "${HOSHIDICTS_SOURCE_DIR}/src/text_processor/text_processor.cpp")
set(HOSHIDICTS_GENERATED_DIR "${CMAKE_CURRENT_BINARY_DIR}/generated")
set(HOSHIDICTS_GENERATED_TEXT_PROCESSOR
    "${HOSHIDICTS_GENERATED_DIR}/text_processor.cpp")
set(HOSHIDICTS_GENERATED_MAPPING
    "${HOSHIDICTS_GENERATED_DIR}/hoshidicts_full_list.inc")

file(MAKE_DIRECTORY "${HOSHIDICTS_GENERATED_DIR}")
file(READ "${HOSHIDICTS_TEXT_PROCESSOR_SOURCE}" HOSHIDICTS_TEXT_PROCESSOR)
set(HOSHIDICTS_EMBED_DIRECTIVE
    "#embed \"../../external/kanji-processor/src/full_list.json\"")
string(FIND "${HOSHIDICTS_TEXT_PROCESSOR}" "${HOSHIDICTS_EMBED_DIRECTIVE}"
    HOSHIDICTS_EMBED_POSITION)
if(HOSHIDICTS_EMBED_POSITION EQUAL -1)
    message(FATAL_ERROR "The Hoshidicts mapping embed directive has changed")
endif()
string(REPLACE
    "${HOSHIDICTS_EMBED_DIRECTIVE}"
    "#include \"hoshidicts_full_list.inc\""
    HOSHIDICTS_TEXT_PROCESSOR
    "${HOSHIDICTS_TEXT_PROCESSOR}")
file(WRITE "${HOSHIDICTS_GENERATED_TEXT_PROCESSOR}"
    "${HOSHIDICTS_TEXT_PROCESSOR}")

file(READ
    "${HOSHIDICTS_SOURCE_DIR}/external/kanji-processor/src/full_list.json"
    HOSHIDICTS_MAPPING_HEX
    HEX)
string(REGEX REPLACE "([0-9a-f][0-9a-f])" "0x\\1,\n"
    HOSHIDICTS_MAPPING_BYTES
    "${HOSHIDICTS_MAPPING_HEX}")
file(WRITE "${HOSHIDICTS_GENERATED_MAPPING}" "${HOSHIDICTS_MAPPING_BYTES}")

get_target_property(HOSHIDICTS_SOURCES hoshidicts SOURCES)
set(HOSHIDICTS_PORTABLE_SOURCES)
set(HOSHIDICTS_TEXT_PROCESSOR_FOUND OFF)
foreach(HOSHIDICTS_SOURCE IN LISTS HOSHIDICTS_SOURCES)
    if(HOSHIDICTS_SOURCE MATCHES "(^|/)src/text_processor/text_processor\\.cpp$")
        list(APPEND HOSHIDICTS_PORTABLE_SOURCES
            "${HOSHIDICTS_GENERATED_TEXT_PROCESSOR}")
        set(HOSHIDICTS_TEXT_PROCESSOR_FOUND ON)
    else()
        list(APPEND HOSHIDICTS_PORTABLE_SOURCES "${HOSHIDICTS_SOURCE}")
    endif()
endforeach()
if(NOT HOSHIDICTS_TEXT_PROCESSOR_FOUND)
    message(FATAL_ERROR "Could not replace the Hoshidicts text processor source")
endif()
set_property(TARGET hoshidicts PROPERTY SOURCES "${HOSHIDICTS_PORTABLE_SOURCES}")
target_include_directories(hoshidicts PRIVATE
    "${HOSHIDICTS_SOURCE_DIR}/src/text_processor"
    "${HOSHIDICTS_GENERATED_DIR}"
)

# Upstream importer.hpp currently uses uint64_t without including <cstdint>.
# Supply it from the consuming build until that header is fixed upstream.
target_precompile_headers(hoshidicts PRIVATE
    <cstdint>
    "${CMAKE_CURRENT_SOURCE_DIR}/ranges_to_compat.hpp"
)

# MSVC otherwise treats source as the active Windows code page and reports its
# legacy C++ version, breaking Japanese char32_t literals and utfcpp overloads.
if(MSVC)
    target_compile_options(hoshidicts PRIVATE /utf-8 /Zc:__cplusplus)
endif()

# GCC implemented the C++23 ranges::to adaptor in version 14. Keep the pinned
# Hoshidicts sources buildable with GCC 13 toolchains (including CLion's
# bundled MinGW) without modifying the submodule.
if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU"
   AND CMAKE_CXX_COMPILER_VERSION VERSION_LESS 14)
    target_compile_definitions(hoshidicts PRIVATE
        HAYASE_NEEDS_RANGES_TO_COMPAT=1
    )
endif()

find_package(Threads REQUIRED)

add_executable(hoshidicts-sidecar
    main.cpp
)

target_include_directories(hoshidicts-sidecar PRIVATE
    "${HOSHIDICTS_SOURCE_DIR}/src"
)

target_link_libraries(hoshidicts-sidecar PRIVATE
    hoshidicts
    Threads::Threads
)

# The sidecar is packaged as a single executable. Avoid runtime dependencies
# on MinGW DLLs that electron-builder does not copy beside it.
if(MINGW)
    target_link_options(hoshidicts-sidecar PRIVATE
        -static
        -static-libgcc
        -static-libstdc++
    )
endif()

if(BUILD_TESTING)
    find_package(Python3 COMPONENTS Interpreter)
    if(Python3_Interpreter_FOUND)
        add_test(
            NAME sidecar-protocol-smoke
            COMMAND ${Python3_EXECUTABLE}
                    ${CMAKE_CURRENT_SOURCE_DIR}/sidecar_protocol.py
                    $<TARGET_FILE:hoshidicts-sidecar>
        )
        set_tests_properties(sidecar-protocol-smoke PROPERTIES TIMEOUT 30)
    endif()
endif()
