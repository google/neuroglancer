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

#ifndef ZI_ZUNIT_REGISTRY_HPP
#define ZI_ZUNIT_REGISTRY_HPP 1

#include <zi/zunit/config.hpp>
#include <zi/zunit/test_case.hpp>
#include <zi/zunit/test_suite.hpp>
#include <zi/zunit/tags.hpp>

#include <zi/time/timer.hpp>

#include <zi/utility/enable_singleton_of_this.hpp>
#include <zi/utility/non_copyable.hpp>
#include <zi/utility/for_each.hpp>

#include <zi/bits/ref.hpp>

#include <list>
#include <cstddef>

namespace zi {
namespace zunit {

class registry: public enable_singleton_of_this< registry >
{
private:

    std::list< reference_wrapper< test_suite > > suites_;

public:

    registry(): suites_() {}

    void add_suite( test_suite& suite )
    {
        suites_.push_front( ref( suite ) );
    }

    void run_all()
    {
        std::size_t total_tests_passed  = 0;
        std::size_t total_suites_passed = 0;

        FOR_EACH( it, suites_ )
        {
            std::size_t tests_passed = it->get().run_all();

            if ( tests_passed >= 0 )
            {
                total_tests_passed += tests_passed;
                ++total_suites_passed;
            }
        }
    }

};

} // namespace zunit
} // namespace zi

#endif
