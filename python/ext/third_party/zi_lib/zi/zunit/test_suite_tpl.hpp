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

#ifndef ZI_ZUNIT_TEST_SUITE_TPL_HPP
#define ZI_ZUNIT_TEST_SUITE_TPL_HPP 1

#include <zi/zunit/config.hpp>
#include <zi/zunit/test_suite.hpp>
#include <zi/zunit/registry.hpp>

#include <zi/utility/enable_singleton_of_this.hpp>

namespace zi {
namespace zunit {

template< class Tag > struct test_suite_tpl:
    test_suite,
    enable_singleton_of_this< test_suite_tpl< Tag > >
{
    test_suite_tpl():
        test_suite( suite_name< Tag >::name() )
    {
        registry::instance().add_suite( *this );
    }
};

} // namespace zunit
} // namespace zi

#endif
