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

struct barrier_tester: zi::runnable
{
    barrier_tester( int &v, int count = 1 ):
        v_( v ), b_( count ), m_()
    {
    }

    void run()
    {
        if ( b_.wait() )
        {
            zi::guard g( m_ );
            ++v_;
        }
    }

    int         &v_;
    zi::barrier  b_;
    zi::mutex    m_;
};


} // namespace concurrency_tests

ZiTEST( Test_Barrier )
{
    using concurrency_tests::barrier_tester;

    for ( int i = 1; i < 10; ++i )
    {
        int v = 0;
        zi::shared_ptr< barrier_tester > bt( new barrier_tester( v, i ) );

        for ( int j = 0; j < i * ( i + 1 ); ++j )
        {
            zi::thread th( bt );
            th.start();
        }

        zi::all_threads::join();

        EXPECT_EQ( v, i + 1 );
    }

}
