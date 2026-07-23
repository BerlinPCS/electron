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

# Upstream importer.hpp currently uses uint64_t without including <cstdint>.
# Supply it from the consuming build until that header is fixed upstream.
target_precompile_headers(hoshidicts PRIVATE <cstdint>)

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
