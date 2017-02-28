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

struct cv_tester: zi::runnable
{
    cv_tester( int &v ):
        ok_( true ), v_( v ), vold_( 0 ), m_(), cv_()
    {
    }

    void run()
    {
        zi::mutex::guard g( m_ );
        vold_ = 1 + v_++;

        while ( v_ < 1000 )
        {
            cv_.notify_all();

            cv_.wait( g );

            if ( v_ != vold_ )
            {
                ok_ = false;
            }
            vold_ = 1 + v_++;
        }
        cv_.notify_all();
    }

    void notify()
    {
        cv_.notify_all();
    }

    bool       ok_  ;
    int       &v_   ;
    int        vold_;
    zi::mutex  m_   ;
    zi::condition_variable cv_;
};


struct cv_tester2: zi::runnable
{
    cv_tester2( int &v ):
        ok_( true ), v_( v ), vold_( 0 ), m_(), cv_()
    {
    }

    void run()
    {
        zi::mutex::guard g( m_ );
        vold_ = 1 + v_++;

        while ( v_ < 1000 )
        {
            cv_.notify_one();

            cv_.wait( g );

            if ( v_ != vold_ )
            {
                ok_ = false;
            }
            vold_ = 1 + v_++;
        }
        cv_.notify_one();
    }

    void notify()
    {
        cv_.notify_one();
    }

    bool       ok_  ;
    int       &v_   ;
    int        vold_;
    zi::mutex  m_   ;
    zi::condition_variable cv_;
};

struct cv_tester3: zi::runnable
{
    cv_tester3():
        ok_( true ), l_( false ), x_( 0 ), m_(), cv_()
    {
    }

    void run()
    {
        zi::mutex::guard g( m_ );
        while ( x_ < 1000 )
        {
            int  z =  x_;
            bool l = !l_;

            if ( !l_ )
            {
                l_ = true;
            }

            cv_.notify_all();
            cv_.notify_one();
            cv_.notify_all();

            cv_.wait( g );

            if ( l )
            {
                ok_ = z == x_;
                ++x_;
                l_ = false;
            }


            cv_.notify_all();
            cv_.notify_one();
            cv_.notify_all();

        }

        cv_.notify_all();
        cv_.notify_one();
        cv_.notify_all();
    }

    void notify()
    {
        cv_.notify_all();
    }

    bool       ok_  ;
    bool       l_   ;
    int        x_   ;
    zi::mutex  m_   ;
    zi::condition_variable cv_;
};


}

ZiTEST( Test_ConditionVariableNotifyAll )
{
    using concurrency_tests::cv_tester;

    int v = 0;

    zi::shared_ptr< cv_tester > cvt( new cv_tester( v ) );

    for ( int i = 0; i < 10; ++i )
    {
        v = 0;
        zi::thread t1( cvt );
        zi::thread t2( cvt );

        t1.start();
        t2.start();

        t2.join();
        t1.join();

        EXPECT_EQ  ( v, 1001 );
        EXPECT_TRUE( cvt->ok_ );
    }

    for ( int i = 0; i < 10; ++i )
    {
        v = 0;
        zi::thread t1( cvt );
        zi::thread t2( cvt );

        t1.start();
        t2.start();

        t1.join();
        t2.join();

        EXPECT_EQ  ( v, 1001 );
        EXPECT_TRUE( cvt->ok_ );
    }

    for ( int i = 0; i < 10; ++i )
    {
        v = 0;
        zi::thread t1( cvt );
        zi::thread t2( cvt );

        t1.start();
        zi::this_thread::sleep( 1 );
        t2.start();

        t1.join();
        t2.join();

        EXPECT_EQ  ( v, 1001 );
        EXPECT_TRUE( cvt->ok_ );
    }

    for ( int i = 0; i < 10; ++i )
    {
        v = 0;
        zi::thread t1( cvt );
        zi::thread t2( cvt );

        t2.start();
        zi::this_thread::sleep( 1 );
        t1.start();

        t1.join();
        t2.join();

        EXPECT_EQ  ( v, 1001 );
        EXPECT_TRUE( cvt->ok_ );
    }

}


ZiTEST( Test_ConditionVariableNotifyOne )
{
    using concurrency_tests::cv_tester2;

    int v = 0;

    zi::shared_ptr< cv_tester2 > cvt( new cv_tester2( v ) );

    for ( int i = 0; i < 10; ++i )
    {
        v = 0;
        zi::thread t1( cvt );
        zi::thread t2( cvt );

        t1.start();
        t2.start();

        t2.join();
        t1.join();

        EXPECT_EQ  ( v, 1001 );
        EXPECT_TRUE( cvt->ok_ );
    }

    for ( int i = 0; i < 10; ++i )
    {
        v = 0;
        zi::thread t1( cvt );
        zi::thread t2( cvt );

        t1.start();
        t2.start();

        t1.join();
        t2.join();

        EXPECT_EQ  ( v, 1001 );
        EXPECT_TRUE( cvt->ok_ );
    }

    for ( int i = 0; i < 10; ++i )
    {
        v = 0;
        zi::thread t1( cvt );
        zi::thread t2( cvt );

        t1.start();
        zi::this_thread::sleep( 1 );
        t2.start();

        t1.join();
        t2.join();

        EXPECT_EQ  ( v, 1001 );
        EXPECT_TRUE( cvt->ok_ );
    }

    for ( int i = 0; i < 10; ++i )
    {
        v = 0;
        zi::thread t1( cvt );
        zi::thread t2( cvt );

        t2.start();
        zi::this_thread::sleep( 1 );
        t1.start();

        t1.join();
        t2.join();

        EXPECT_EQ  ( v, 1001 );
        EXPECT_TRUE( cvt->ok_ );
    }

}

ZiTEST( Test_ConditionVariableNotifyMixed )
{
    using concurrency_tests::cv_tester3;

    zi::shared_ptr< cv_tester3 > cvt( new cv_tester3() );

    for ( int i = 0; i < 10; ++i )
    {
        zi::thread t1( cvt );
        zi::thread t2( cvt );
        zi::thread t3( cvt );

        t1.start();
        t2.start();
        t3.start();

        t3.join();
        t2.join();
        t1.join();

        EXPECT_TRUE( cvt->ok_ );
    }

}
