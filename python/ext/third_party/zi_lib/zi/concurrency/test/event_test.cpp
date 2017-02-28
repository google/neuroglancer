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

#include <zi/concurrency/concurrency.hpp>
#include <zi/zunit/zunit.hpp>

ZiSUITE( ZiLib_Concurrency_Tests );

namespace concurrency_tests {
namespace event_tests {

zi::mutex m;
int       x;
zi::event e;

void event_tester()
{
    zi::mutex::guard g( m );
    e.wait( g );
    ++x;
    e.clear();
    e.signal();
}

zi::mutex m1;
zi::mutex m2;
zi::event e1;
zi::event e2;

int x1, x2;

void event1_tester()
{
    zi::mutex::guard g( m1 );
    e1.wait( g );
    ++x1;
    e2.clear();
    e2.signal();
}

void event2_tester()
{
    zi::mutex::guard g( m2 );
    e2.wait( g );
    ++x2;
    e1.clear();
    e1.signal();
}

} // event_tests
} // concurrency_tests

ZiTEST( Test_Event )
{
    using namespace concurrency_tests::event_tests;

    x = 0;

    for ( int i = 0; i < 20; ++i )
    {
        zi::thread th( zi::run_fn( &event_tester ) );
        th.start();
    }

    {
        zi::mutex::guard g( m );
        e.signal();
    }

    zi::all_threads::join();

    EXPECT_EQ( x, 20 );
}

ZiTEST( Test_TwoEvents )
{
    using namespace concurrency_tests::event_tests;

    x1 = x2 = 0;

    for ( int i = 0; i < 10; ++i )
    {
        zi::thread th1( zi::run_fn( &event1_tester ) );
        th1.start();
        zi::thread th2( zi::run_fn( &event2_tester ) );
        th2.start();
    }

    {
        zi::mutex::guard g( m1 );
        e1.signal();
    }

    zi::all_threads::join();

    EXPECT_EQ( x1, 10 );
    EXPECT_EQ( x2, 10 );
}
