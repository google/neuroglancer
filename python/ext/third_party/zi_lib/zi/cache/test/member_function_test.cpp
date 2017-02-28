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

#include <zi/cache/identity.hpp>
#include <zi/cache/member_variable.hpp>
#include <zi/cache/member_function.hpp>
#include <zi/cache/global_function.hpp>
#include <zi/zunit/zunit.hpp>
#include <zi/bits/shared_ptr.hpp>

#include <iostream>

ZiSUITE( ZiLib_Cache_Tests );

namespace cache_tests {

struct mf_test_struct
{
    mf_test_struct( int x ): x_( x )
    {
    }

    int f1()
    {
        return ++x_;
    }

    int f2() const
    {
        return x_ + 1;
    }

    int* f3()
    {
        ++x_;
        return &x_;
    }

    const int* f4() const
    {
        return &x_;
    }

    int x_;

};

} // namespace cache_tests

ZiTEST( Test_MemberFunction )
{
    using namespace cache_tests;

    mf_test_struct mf_test( 0 );
    mf_test_struct *mf_test_ptr = &mf_test;

    zi::shared_ptr< mf_test_struct >  mf_test_sp ( new mf_test_struct( 0 ) );
    zi::shared_ptr< mf_test_struct >* mf_test_sp_ptr = &mf_test_sp;

    zi::cache::member_function<       mf_test_struct, int , &mf_test_struct::f1 > mf1;
    zi::cache::const_member_function< mf_test_struct, int , &mf_test_struct::f2 > mf2;

    zi::cache::member_function<       mf_test_struct, int* , &mf_test_struct::f3 > mf3;
    zi::cache::const_member_function< mf_test_struct, const int* , &mf_test_struct::f4 > mf4;

    EXPECT_EQ( mf1( mf_test     ), 1 );
    EXPECT_EQ( mf1( mf_test_ptr ), 2 );

    EXPECT_EQ( mf1( mf_test_sp     ), 1 );
    EXPECT_EQ( mf1( mf_test_sp_ptr ), 2 );

    EXPECT_EQ( mf2( mf_test     ), 3 );
    EXPECT_EQ( mf2( mf_test_ptr ), 3 );

    EXPECT_EQ( mf2( mf_test_sp     ), 3 );
    EXPECT_EQ( mf2( mf_test_sp_ptr ), 3 );

    EXPECT_EQ( *mf3( mf_test     ), 3 );
    EXPECT_EQ( *mf3( mf_test_ptr ), 4 );

    EXPECT_EQ( *mf3( mf_test_sp     ), 3 );
    EXPECT_EQ( *mf3( mf_test_sp_ptr ), 4 );

    EXPECT_EQ( *mf4( mf_test     ), 4 );
    EXPECT_EQ( *mf4( mf_test_ptr ), 4 );

    EXPECT_EQ( *mf4( mf_test_sp     ), 4 );
    EXPECT_EQ( *mf4( mf_test_sp_ptr ), 4 );

}

namespace cache_tests {

inline int global_fn1( int x )
{
    return x + 1;
}

inline int global_fn2( int& x )
{
    x++;
    return x + 2;
}

inline int global_fn3( const int x )
{
    return x + 3;
}

inline int global_fn4( const int& x )
{
    return x + 4;
}

} // namespace cache_tests


ZiTEST( Test_GlobalFunction )
{
    using namespace cache_tests;

    zi::cache::global_function< int, int, &global_fn1 > sf1;
    zi::cache::global_function< int&, int, &global_fn2 > sf2;
    zi::cache::global_function< const int, int, &global_fn3 > sf3;
    zi::cache::global_function< const int&, int, &global_fn4 > sf4;

    int x1 = 0;

    EXPECT_EQ( sf1( x1 ), 1 );
    EXPECT_EQ( sf2( x1 ), 3 );
    EXPECT_EQ( x1, 1 );
    EXPECT_EQ( sf3( x1 ), 4 );
    EXPECT_EQ( sf4( x1 ), 5 );

    x1 = 0;
    int &x2 = x1;

    EXPECT_EQ( sf1( x2 ), 1 );
    EXPECT_EQ( sf2( x2 ), 3 );
    EXPECT_EQ( sf3( x2 ), 4 );
    EXPECT_EQ( sf4( x2 ), 5 );

    int x3h = 0;
    const int &x3 = x3h;

    EXPECT_EQ( sf1( x3 ), 1 );
    EXPECT_EQ( sf3( x3 ), 3 );
    EXPECT_EQ( sf4( x3 ), 4 );

}
