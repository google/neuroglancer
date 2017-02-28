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

#include <zi/zunit/zunit.hpp>

#include <zi/utility/enable_if.hpp>

ZiSUITE( ZiLib_Utility_Tests );

namespace zi_test {

struct enable_if_test
{

    template< bool B >
    static int simple( typename zi::enable_if< B >::type* = 0 )
    {
        return 1;
    }

    template< bool B >
    static int simple( typename zi::disable_if< B >::type* = 0 )
    {
        return 0;
    }


    template< class T >
    static int result( typename zi::enable_if< sizeof( T ) == 1 >::type* = 0 )
    {
        return 1;
    }

    template< class T >
    static int result( typename zi::disable_if< sizeof( T ) == 1 >::type* = 0 )
    {
        return 0;
    }
};

}

ZiTEST( EnableIf_Test )
{
    EXPECT_EQ( zi_test::enable_if_test::simple< true >(), 1 );
    EXPECT_EQ( zi_test::enable_if_test::simple< false >(), 0 );

    EXPECT_EQ( zi_test::enable_if_test::result< char  >(), 1 );
    EXPECT_EQ( zi_test::enable_if_test::result< int   >(), 0 );
    EXPECT_EQ( zi_test::enable_if_test::result< void* >(), 0 );
}
