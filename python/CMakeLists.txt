# @license
# Copyright 2016 Google Inc.
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Build specification for compress_segmentation tests.

cmake_minimum_required(VERSION 2.8)
project (neuroglancer CXX)

enable_testing()
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -std=c++11 -Wall")

# Enable ExternalProject CMake module
include(ExternalProject)

# Set default ExternalProject root directory
set_directory_properties(PROPERTIES EP_PREFIX ${CMAKE_BINARY_DIR}/third_party)

ExternalProject_Add(
  googletest
  PREFIX ${CMAKE_CURRENT_BINARY_DIR}/third_party
  GIT_REPOSITORY https://github.com/google/googletest.git
  UPDATE_COMMAND ""
  CONFIGURE_COMMAND ""
  BUILD_COMMAND ""
  INSTALL_COMMAND ""
  TEST_COMMAND "")


add_library(gtest STATIC
  ${CMAKE_CURRENT_BINARY_DIR}/third_party/src/googletest/googletest/src/gtest-all.cc
  )

add_library(gmock STATIC
  ${CMAKE_CURRENT_BINARY_DIR}/third_party/src/googletest/googlemock/src/gmock-all.cc
  )

target_link_libraries(gmock gtest pthread)

add_library(gmock_main STATIC
  ${CMAKE_CURRENT_BINARY_DIR}/third_party/src/googletest/googlemock/src/gmock_main.cc
  )

target_link_libraries(gmock_main gmock)

target_include_directories(gtest PUBLIC ${CMAKE_CURRENT_BINARY_DIR}/third_party/src/googletest/googletest/include)
target_include_directories(gtest PRIVATE ${CMAKE_CURRENT_BINARY_DIR}/third_party/src/googletest/googletest)

target_include_directories(gmock PUBLIC ${CMAKE_CURRENT_BINARY_DIR}/third_party/src/googletest/googlemock/include)
target_include_directories(gmock PRIVATE ${CMAKE_CURRENT_BINARY_DIR}/third_party/src/googletest/googlemock)

target_link_libraries(gmock gtest)


add_custom_command(OUTPUT ${CMAKE_CURRENT_BINARY_DIR}/third_party/src/googletest/googletest/src/gtest-all.cc
  DEPENDS googletest)

add_custom_command(OUTPUT ${CMAKE_CURRENT_BINARY_DIR}/third_party/src/googletest/googlemock/src/gmock-all.cc
  DEPENDS googletest)

add_custom_command(OUTPUT ${CMAKE_CURRENT_BINARY_DIR}/third_party/src/googletest/googlemock/src/gmock_main.cc
  DEPENDS googletest)

function(DefineGTest source_name)
  include ( CMakeParseArguments )

  cmake_parse_arguments (
    "_test_arg"
    ""
    ""
    "LIBRARIES"
    ${ARGN} )

  get_filename_component(test_name "${source_name}" NAME_WE)
  add_executable("${test_name}" "${source_name}" )
  target_link_libraries("${test_name}"
    ${_test_arg_LIBRARIES}
    gmock_main
    )
  set_property(TARGET "${test_name}" PROPERTY COMPILE_DEFINITIONS
    )
  add_test("${test_name}" "${test_name}")
endfunction()

add_library(compress_segmentation STATIC
  ext/src/compress_segmentation.cc)

DefineGTest(ext/src/compress_segmentation_test.cc LIBRARIES compress_segmentation)
