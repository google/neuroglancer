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

#include <zi/atomic/atomic.hpp>

#include <zi/zunit/zunit.hpp>

ZiSUITE( ZiLib_Atomic_Tests );

typedef zi::atomic::atomic_word atomic_t;

ZiTEST( Test_Increment_Decrement )
{
    volatile atomic_t x = 0;
    EXPECT_EQ( x, 0 );
    EXPECT_EQ( zi::atomic::increment_swap( &x ), 0 );
    EXPECT_EQ( zi::atomic::increment_swap( &x ), 1 );
    EXPECT_EQ( zi::atomic::read( &x ), 2 );
    EXPECT_EQ( zi::atomic::decrement_swap( &x ), 2 );
    EXPECT_EQ( zi::atomic::decrement_swap( &x ), 1 );
    EXPECT_EQ( zi::atomic::read( &x ), 0 );

    zi::atomic::increment( &x );
    EXPECT_EQ( zi::atomic::read( &x ), 1 );
    zi::atomic::increment( &x );
    EXPECT_EQ( zi::atomic::read( &x ), 2 );


    zi::atomic::decrement( &x );
    EXPECT_EQ( zi::atomic::read( &x ), 1 );
    zi::atomic::decrement( &x );
    EXPECT_EQ( zi::atomic::read( &x ), 0 );

}


ZiTEST( Test_Compare_Swap )
{
    atomic_t x = 0;
    EXPECT_EQ( x, 0 );

    EXPECT_EQ( zi::atomic::compare_swap( &x, 1, 1 ), 0 );
    EXPECT_EQ( zi::atomic::compare_swap( &x, 1, 0 ), 0 );
    EXPECT_EQ( zi::atomic::read( &x ), 1 );

    EXPECT_EQ( zi::atomic::compare_swap( &x, 0, 0 ), 1 );
    EXPECT_EQ( zi::atomic::compare_swap( &x, 0, 1 ), 1 );
    EXPECT_EQ( zi::atomic::read( &x ), 0 );

}
