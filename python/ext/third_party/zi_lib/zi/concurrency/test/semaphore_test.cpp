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

struct semaphore_tester: zi::runnable
{
    semaphore_tester( int &v, zi::semaphore &s, int count = 1 ):
        count_( count ), v_( v ), s_( s ), m_()
    {
    }

    void run()
    {
        int count = count_;
        while ( count > 0 )
        {
            s_.acquire();
            --count;
        }
        {
            zi::guard g( m_ );
            ++v_;
        }
    }

    int           count_;
    int           &v_;
    zi::semaphore &s_;
    zi::mutex     m_;
};


} // namespace concurrency_tests

ZiTEST( Test_Semaphore )
{
    using concurrency_tests::semaphore_tester;

    int v = 0;
    zi::semaphore s;

    zi::shared_ptr< semaphore_tester > st( new semaphore_tester( v, s ) );

    for ( int i = 0; i < 100; ++i )
    {
        zi::thread th( st );
        th.start();
    }

    for ( int i = 1; i <= 10; ++i )
    {
        s.release( 10 );
        zi::this_thread::sleep( 100 );
        EXPECT_EQ( v, i * 10 );
    }

    zi::all_threads::join();

}

ZiTEST( Test_Semaphore2 )
{
    using concurrency_tests::semaphore_tester;

    int v = 0;
    zi::semaphore s;

    zi::shared_ptr< semaphore_tester > st( new semaphore_tester( v, s, 10 ) );

    for ( int i = 0; i < 10; ++i )
    {
        zi::thread th( st );
        th.start();
    }

    s.release( 100 );
    zi::this_thread::sleep( 100 );
    EXPECT_EQ( v, 10 );

    zi::all_threads::join();

}
