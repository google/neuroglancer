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

#ifndef ZI_ZUNIT_TEST_CASE_HPP
#define ZI_ZUNIT_TEST_CASE_HPP 1

#include <zi/zunit/config.hpp>
#include <zi/utility/non_copyable.hpp>

namespace zi {
namespace zunit {

class test_case: non_copyable
{
protected:
    int passed_;

public:

    test_case(): passed_( 0 )
    {
    }

    virtual ~test_case()
    {
    }

    virtual const int passed() const
    {
        return passed_;
    }

    virtual const char* name()   const = 0;
    virtual const char* file()   const = 0;
    virtual const int   line()   const = 0;

    virtual void run() = 0;

};

} // namespace zunit
} // namespace zi

#endif
