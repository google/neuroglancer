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

#include <zi/concurrency/periodic_function.hpp>
#include <zi/concurrency/thread.hpp>
#include <zi/zunit/zunit.hpp>

ZiSUITE( ZiLib_Concurrency_Tests );

namespace concurrency_tests {
namespace periodic_fn_tests {

int x;

bool three_times_fn()
{
    ++x;
    return x < 3;
}

bool to_n_times( int n )
{
    ++x;
    return x < n;
}

bool just_return_true()
{
    ++x;
    return true;
}

struct pf_tester
{
    mutable int v_;

    pf_tester(): v_( 0 )
    {
    }

    pf_tester( int v ): v_( v )
    {
    }

    bool doit()
    {
        ++x;
        --v_;
        return v_ > 0;
    }

    bool doit_c() const
    {
        ++x;
        --v_;
        return v_ > 0;
    }

    bool doit_n( int n )
    {
        ++x;
        ++v_;
        return v_ < n;
    }
};

} // periodic_fn_tests
} // concurrency_tests

ZiTEST( Global_Periodic_Function )
{
    using namespace concurrency_tests::periodic_fn_tests;

    x = 0;
    zi::periodic_function pf( &three_times_fn, 1 );

    zi::thread th( pf );
    th.start();
    th.join();

    EXPECT_EQ( x, 3 );

}

ZiTEST( Global_Periodic_Function_Args )
{
    using namespace concurrency_tests::periodic_fn_tests;

    for ( int i = 10; i < 20; ++i )
    {
        x = 0;
        zi::periodic_function pf( &to_n_times, i, zi::interval::msecs( 1 ) );

        zi::thread th( pf );
        th.start();
        th.join();

        EXPECT_EQ( x, i );

    }

}

ZiTEST( Global_Periodic_Function_Stop )
{
    using namespace concurrency_tests::periodic_fn_tests;

    {
        x = 0;
        zi::periodic_function pf( &just_return_true, zi::interval::msecs( 200 ) );

        zi::thread th( pf );
        th.start();

        zi::this_thread::sleep( zi::interval::msecs( 500 ) );
        pf.stop();
    }

    EXPECT_EQ( x, 3 );
}

ZiTEST( Global_Periodic_Function_Stop_At_Dtor )
{
    using namespace concurrency_tests::periodic_fn_tests;

    zi::thread th;

    {
        x = 0;
        zi::periodic_function pf( &just_return_true, zi::interval::msecs( 200 ) );

        th = zi::thread( pf );
        th.start();

        zi::this_thread::sleep( zi::interval::msecs( 500 ) );
    }

    th.join();

    EXPECT_EQ( x, 3 );

}

ZiTEST( Member_Periodic_Function )
{
    using namespace concurrency_tests::periodic_fn_tests;

    x = 0;
    pf_tester t( 3 );
    zi::periodic_function pf( &pf_tester::doit, &t, 1 );

    zi::thread th( pf );
    th.start();
    th.join();

    EXPECT_EQ( x, 3 );

}

ZiTEST( Const_Member_Periodic_Function )
{
    using namespace concurrency_tests::periodic_fn_tests;

    x = 0;
    pf_tester t( 3 );
    zi::periodic_function pf( &pf_tester::doit_c, &t, 1 );

    zi::thread th( pf );
    th.start();
    th.join();

    EXPECT_EQ( x, 3 );

}


ZiTEST( Member_Periodic_Function_Args )
{
    using namespace concurrency_tests::periodic_fn_tests;

    for ( int i = 10; i < 20; ++i )
    {
        x = 0;
        pf_tester t;
        zi::periodic_function pf( &pf_tester::doit_n, &t, i, zi::interval::nsecs( 1 ) );

        {
            zi::thread::scoped th( pf );
        }
        EXPECT_EQ( x, i );
    }

}


