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

#include <zi/heap/simple_binary_heap.hpp>
#include <zi/zunit/zunit.hpp>

ZiSUITE( ZiLib_Heap_Tests );

ZiTEST( Basic_Heap_Tests )
{
    zi::simple_binary_heap< int > h;

    EXPECT_TRUE( h.empty() );

    h.insert( 1 );
    h.insert( 3 );
    h.insert( 2 );

    EXPECT_EQ( h.size(), 3 );
    EXPECT_FALSE( h.empty() );

    EXPECT_TRUE( h.count( 1 ) );
    EXPECT_TRUE( h.count( 2 ) );
    EXPECT_TRUE( h.count( 3 ) );
    EXPECT_FALSE( h.count( 4 ) );

    EXPECT_EQ( h.top(), 1 );
    h.pop();

    EXPECT_EQ( h.top(), 2 );
    EXPECT_EQ( h.size(), 2 );
    EXPECT_FALSE( h.count( 1 ) );

    h.insert( 1 );
    h.insert( 4 );
    h.insert( 5 );
    h.insert( 4 );

    EXPECT_EQ( h.size(), 5 );
    EXPECT_EQ( h.top(), 1 );

    h.erase( 2 );
    EXPECT_EQ( h.size(), 4 );
    EXPECT_EQ( h.top(), 1 );

    h.pop();
    EXPECT_EQ( h.size(), 3 );
    EXPECT_EQ( h.top(), 3 );

    h.pop();
    EXPECT_EQ( h.size(), 2 );
    EXPECT_EQ( h.top(), 4 );

    h.pop();
    EXPECT_EQ( h.size(), 1 );
    EXPECT_EQ( h.top(), 5 );

    h.pop();
    EXPECT_EQ( h.size(), 0 );

    h.pop();
    EXPECT_EQ( h.size(), 0 );

    //EXPECT_THROW( h.top() );

}

ZiTEST( Large_Heap_Tests )
{
    zi::simple_binary_heap< int, std::greater< int > > h;

    for ( int i = 0; i < 100000; ++i )
    {
        h.insert( i );
    }

    for ( int i = 0; i < 100000; ++i )
    {
        EXPECT_EQ( h.size(), 100000 - i );
        EXPECT_EQ( h.top(), 100000 - i - 1 );
        h.pop();
    }
}

namespace simple_binary_heap_tests {

struct custom_heapable
{
    std::size_t v_;

    custom_heapable(): v_( 0 )
    {
    }

    custom_heapable( std::size_t v ): v_( v )
    {
    }

};

struct custom_heapable_compare
{
    bool operator()( const custom_heapable& x, const custom_heapable& y ) const
    {
        return x.v_ < y.v_;
    }
};

struct custom_heapable_equals
{
    bool operator()( const custom_heapable& x, const custom_heapable& y ) const
    {
        return x.v_ == y.v_;
    }
};

struct custom_heapable_hash
{
    zi::hash< std::size_t > hasher_;

    std::size_t operator()( const custom_heapable& x ) const
    {
        return hasher_( x.v_ );
    }
};

} // namespace simple_binary_heap_tests

ZiTEST( Custom_Struct_Heap_Tests )
{
    using namespace simple_binary_heap_tests;

    zi::simple_binary_heap<
        custom_heapable, custom_heapable_compare,
        custom_heapable_hash, custom_heapable_equals > h;

    for ( int i = 0; i < 100000; ++i )
    {
        h.insert( custom_heapable( i ) );
    }

    for ( int i = 0; i < 100000; ++i )
    {
        EXPECT_EQ( h.size(), 100000 - i );
        EXPECT_EQ( h.top().v_, i );
        h.pop();
    }

}
