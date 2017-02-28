//
// Copyright (C) 2010  Aleksandar Zlateski <zlateski@mit.edu>
// ----------------------------------------------------------
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.
//

#ifndef ZI_ZUNIT_MACROS_HPP
#define ZI_ZUNIT_MACROS_HPP 1

#include <zi/zunit/config.hpp>
#include <zi/zunit/registry.hpp>
#include <zi/zunit/test_suite_tpl.hpp>

#define ZiTEST(_tname)                                                  \
                                                                        \
    namespace zi {                                                      \
        namespace zunit {                                               \
            namespace {                                                 \
                struct test_ ## _tname ## _tag;                         \
            }                                                           \
        } /* namespace zunit */                                         \
    } /* namespace zi */                                                \
                                                                        \
    template< class FileTag >                                           \
    struct ___test ## _tname: ::zi::zunit::test_case                    \
    {                                                                   \
                                                                        \
        ___test ## _tname()                                             \
        {                                                               \
            ::zi::zunit::test_suite_tpl<                                \
            typename ::zi::zunit::suite_tag< FileTag >::tag             \
                >::instance().add_test( *this );                        \
        }                                                               \
                                                                        \
        const char* name() const { return #_tname ; }                   \
        const char* file() const { return __FILE__; }                   \
        const int   line() const { return __LINE__; }                   \
                                                                        \
        void run();                                                     \
    };                                                                  \
                                                                        \
    namespace {                                                         \
        static ___test ## _tname< zi::zunit::this_file_tag >            \
        ___instance_of_test_ ## _tname;                                 \
    }                                                                   \
                                                                        \
    template< class FileTag >                                           \
    inline void ___test ## _tname< FileTag >::run() /* { ... } */


#define ZiSUITE(_name)                                                  \
                                                                        \
    namespace zi {                                                      \
        namespace zunit {                                               \
                                                                        \
            struct suite_ ## _name ## _tag;                             \
                                                                        \
            template<> struct suite_tag< this_file_tag >                \
            {                                                           \
                typedef suite_ ## _name ## _tag tag ;                   \
            };                                                          \
                                                                        \
            template<> struct suite_name< suite_ ## _name ## _tag> \
            {                                                           \
                static const char* name() { return #_name; }            \
            };                                                          \
                                                                        \
        } /* namespace zunit */                                         \
    } /* namespace zi */                                                \
                                                                        \
                                                                        \
    static ::zi::zunit::test_suite &___suite_instance                   \
    ( ::zi::zunit::test_suite_tpl<                                      \
      ::zi::zunit::suite_ ## _name ## _tag                              \
      >::instance() )

#define ZiRUN_ALL_TESTS()                       \
    ::zi::zunit::registry::instance().run_all()

#endif

