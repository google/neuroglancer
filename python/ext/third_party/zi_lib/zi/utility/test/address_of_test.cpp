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

#include <zi/utility/address_of.hpp>
#include <string>

ZiSUITE( ZiLib_Utility_Tests );

ZiTEST( AddressOf_Test )
{
    int int_var;
    const int cint_var = 0;
    static int sint_var = 0;
    static const int scint_var = 0;

    EXPECT_EQ( zi::address_of( int_var ), &int_var );
    EXPECT_EQ( zi::address_of( cint_var ), &cint_var );
    EXPECT_EQ( zi::address_of( sint_var ), &sint_var );
    EXPECT_EQ( zi::address_of( scint_var ), &scint_var );
}


ZiTEST( AddressOf_Test2 )
{
    const char* str1 = "X";
    const char* str2 = "Y";

    EXPECT_NEQ( str1, str2 );

    char** x = const_cast< char** > ( zi::address_of( str1 ) );
    *x = const_cast< char* >( str2 );

    EXPECT_EQ( str1, str2 );
}

