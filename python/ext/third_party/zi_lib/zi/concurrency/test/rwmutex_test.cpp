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
namespace rwmutex_tests {

int n;
int m;

zi::rwmutex rwm;

void read_fn( int expected )
{
    zi::rwmutex::read_guard rg( rwm );

    if ( n == expected )
    {
        ++m;
    }
}

void write_fn( int expected )
{
    zi::rwmutex::write_guard wg( rwm );

    if ( m == expected )
    {
        ++n;
    }
}

} // namespace rwmutex_tests
} // namespace concurrency_tests

ZiTEST( Test_RWMutex )
{
    using namespace concurrency_tests::rwmutex_tests;

    {
        {
            zi::rwmutex::read_guard rg( rwm );
            n = 1;
            m = 0;

            for ( int i = 0; i < 10; ++i )
            {
                zi::thread th( zi::run_fn( zi::bind( &read_fn, 1 ) ) );
                th.start();
            }

            zi::this_thread::sleep( 200 );

            EXPECT_EQ( m, 10 );

        }

        {
            zi::thread th( zi::run_fn( zi::bind( &write_fn, 10 ) ) );
            th.start();
            th.join();
        }

        {
            zi::rwmutex::read_guard rg( rwm );
            EXPECT_EQ( m, 10 );
            EXPECT_EQ( n, 2 );
        }
    }

}


ZiTEST( Test_RWMutex_LotsOfReaders )
{
    using namespace concurrency_tests::rwmutex_tests;

    {
        {
            zi::rwmutex::write_guard wg( rwm );
            n = 1;
            m = 0;

            for ( int i = 0; i < 200; ++i )
            {
                zi::thread th( zi::run_fn( zi::bind( &read_fn, 1 ) ) );
                th.start();
            }

        }

        zi::this_thread::sleep( 200 );

        {
            zi::rwmutex::write_guard wg( rwm );
            EXPECT_EQ( m, 200 );
        }
    }
}
